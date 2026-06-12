// Electron main process — owns the window + the scraper.
//
// Renderer (React) talks to us via IPC: `window.pantoufa.scrape(...)` is
// exposed in preload.ts, which forwards to the IPC handler here.

import { app, BrowserWindow, ipcMain, protocol, session, shell } from "electron";
import path from "node:path";

// Disable QUIC so Chromium falls back to TCP/HTTP2. Restrictive ISPs
// often block or mangle QUIC (UDP/443), causing ERR_QUIC_PROTOCOL_ERROR
// and ERR_CONNECTION_TIMED_OUT. TCP fallback succeeds even on blocked ISPs.
app.commandLine.appendSwitch("disable-quic");
app.commandLine.appendSwitch("enable-quic", "false");

// Suppress Chromium-level warnings in dev mode — the scraper and iframe
// embeds generate ERR_CONNECTION_TIMED_OUT for ISP-blocked hosts, and
// Electron logs them as "Failed to load URL..." which is noise. Setting
// the log level to ERROR hides these warnings while keeping our own
// console.info / console.warn calls visible.
if (!app.isPackaged) {
  app.commandLine.appendSwitch("log-level", "3"); // LOG_ERROR only
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";
}

// Suppress Node.js process warnings ("electron: Failed to load URL...")
// that Electron emits on navigation failures. These happen every time
// the scraper or an iframe hits an ISP-blocked host. The errors are
// already handled by our own did-fail-load / fast-advance logic.
process.removeAllListeners("warning");
process.on("warning", (warning: { name?: string; message?: string }) => {
  const msg = warning?.message || "";
  if (msg.includes("Failed to load URL") && msg.includes("ERR_CONNECTION")) return;
  console.warn(msg || warning);
});

import { autoUpdater } from "electron-updater";
import { enqueue, type ScrapeJob } from "./scraper/host";
import { EXTRACT_VIDEO_URL, VIDEO_HOOK_INSTALL } from "../shared/scrape-scripts";

const isDev = !app.isPackaged;
const DEV_URL = "http://localhost:5173";
let activeIframeUrl: string | null = null;
const PROTOCOL = "pantoufa";
const VIDEO_PROTOCOL = "pantoufa-video";
// Mobile UA for video CDNs — matches what the mobile app uses and what
// most providers expect from real users. mp4upload + streamwish refuse
// some desktop UAs.
const VIDEO_UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
// Desktop UA — MUST match the mainWindow / headless scraper UA exactly. The
// mp4upload direct-.mp4 token is bound to the UA that fetched the embed page;
// if we extract the URL under a different UA than the one the <video> element
// (mainWindow) plays it with, mp4upload's CDN rejects the token with 403 and
// the player goes black. So mp4upload's server-side extraction fetch uses this.
const PLAYBACK_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

let mainWindow: BrowserWindow | null = null;
let pendingAuthCallback: string | null = null;
let updateCheckInterval: ReturnType<typeof setInterval> | null = null;

// Single-instance lock so the OS routes pantoufa:// URLs to our running app.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

if (gotLock) {

if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

// Privileged scheme for the video proxy. Has to be registered BEFORE app ready.
// `stream: true` lets <video> receive chunked Content-Length progressively.
// `bypassCSP` ensures hls.js can `fetch()` it from the renderer page.
protocol.registerSchemesAsPrivileged([
  {
    scheme: VIDEO_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
      // NOTE: corsEnabled triggers preflight handling that fights with the
      // CORS headers we set manually on the response. Leaving it off and
      // adding ACAO:* ourselves is more reliable across providers.
    },
  },
]);

function handleAuthCallbackUrl(url: string) {
  if (!url || !url.startsWith(`${PROTOCOL}://`)) return;
  if (mainWindow && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send("pantoufa:auth-callback", url);
  } else {
    pendingAuthCallback = url;
  }
}

// Ad-network hosts blocked across all layers (single source of truth).
// Ad-block hostname regex. Used across onBeforeRequest, will-frame-navigate,
// and the capture filter. Keep patterns hostname-centric (e.g. "doubleclick" not
// "//doubleclick.net/path") so they match anywhere in the hostname string.
//
// TLD group: cheap / free TLDs that are almost never used by legitimate
// video CDNs but are heavily abused by popup ad networks. Match them only
// when preceded by a dot (they're the top-level domain).
const AD_HOST_RE = /doubleclick|googletagmanager|google-analytics|googleadservices|googlesyndication|adservice\.google|adnxs|facebook\.com\/tr|pixel\.facebook|popads|popcash|popmyads|popunder|propeller|propellerads|trafficjunky|adsterra|hilltopads|onclkds|onclickbid|onclickpredictiv|exoclick|magsrv|tsyndicate|clickadu|adcash|ad-maven|admaven|adsupply|servedbyadbutler|mgid|revcontent|adskeeper|trustedclicks|outbrain|taboola|etymonstheine|savorsaveragereaudit|offletsoroche|horizonungyve|visageagar|protrafficinspector|spendsdetachment|\.(?:cfd|cyou|life|shop|sbs|quest|buzz|top|ooo|live|today|icu|site|click|link|bid|trade|webcam|date|download|party|review|science|stream|racing|accountant|win|men|loan|faith|gdn)$/i;

// Canonical Referer/Origin a provider's embed expects, keyed by hostname.
// Used both for proxy fetches AND (critically) for the embed iframe's own
// FRAME navigation: in a packaged build the app loads from file://, so
// Chromium sends NO Referer when the embed iframe navigates. mp4upload,
// ok.ru, voe, dood, etc. anti-hotlink by rendering a BLACK player when
// document.referrer is empty — forging the provider's own domain as the
// frame Referer makes the embed believe it's hosted on the provider's site.
function providerRefererForHost(host: string): { referer: string; origin: string } | null {
  host = (host || "").toLowerCase();
  if (/mp4upload/.test(host)) return { referer: "https://www.mp4upload.com/", origin: "https://www.mp4upload.com" };
  if (/streamwish|hgcloud|wishfast|wishembed|jwembed|hlswish|vibuxer|audinifer|masukestin|hanerix/.test(host)) return { referer: "https://streamwish.to/", origin: "https://streamwish.to" };
  if (/voe\./.test(host)) return { referer: "https://voe.sx/", origin: "https://voe.sx" };
  if (/dood/.test(host)) return { referer: "https://dood.li/", origin: "https://dood.li" };
  if (/uqload/.test(host)) return { referer: "https://uqload.io/", origin: "https://uqload.io" };
  if (/share4max|megamax/.test(host)) return { referer: "https://share4max.com/", origin: "https://share4max.com" };
  if (/videa|vidvaita|vidit/.test(host)) return { referer: "https://videa.hu/", origin: "https://videa.hu" };
  if (/streamruby|rubyvidhub|rubystm|ruby/.test(host)) return { referer: "https://streamruby.com/", origin: "https://streamruby.com" };
  if (/ok\.ru|odnoklassniki/.test(host)) return { referer: "https://ok.ru/", origin: "https://ok.ru" };
  if (/vk\.com|vkvideo/.test(host)) return { referer: "https://vk.com/", origin: "https://vk.com" };
  if (/dailymotion|dmcdn/.test(host)) return { referer: "https://www.dailymotion.com/", origin: "https://www.dailymotion.com" };
  return null;
}

function createMainWindow() {
  // Resolve the bundled icon — packaged app reads from resources/build/, dev reads from ../../build/.
  const iconExt = process.platform === "win32" ? "ico" : "png";
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, "build", `icon.${iconExt}`)
    : path.join(__dirname, "..", "..", "build", `icon.${iconExt}`);
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#06071A",
    autoHideMenuBar: true,
    title: "بانتوفة",
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      autoplayPolicy: "no-user-gesture-required",
    },
  });

  // Override the UA so the iframe-embed pages don't see "Electron" or
  // our app name in the string. Some providers (streamwish in
  // particular) refuse to play in user agents they don't recognize as
  // a real browser; presenting a plain desktop Chrome string sidesteps
  // those detection rules.
  mainWindow.webContents.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  );

  mainWindow.webContents.setWindowOpenHandler(({ url, referrer }) => {
    // Only open external browser for links originating from our own
    // renderer (witanime / anime4up pages). Everything else — empty
    // referrer, video-CDN iframes, unknown origins — is denied.
    // This prevents streamwish / videa / mp4upload popup ads from
    // opening the user's default browser, while still allowing
    // genuine external links from search results and anime pages.
    const refHost = (() => {
      try { return new URL(referrer?.url || "").hostname.toLowerCase(); } catch { return ""; }
    })();
    if (url.startsWith("http") && /witanime|anime4up/.test(refHost)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  // Suppress web push notification prompts. Streamwish, mp4upload, and
  // other embed sites request notification permission to push spam.
  // Deny all permission requests from sub-frames (iframes / embeds)
  // while letting the main frame keep default behavior.
  mainWindow.webContents.session.setPermissionRequestHandler(
    (_webContents, permission, callback, details) => {
      if (details.isMainFrame) return callback(true);
      // Deny everything from embed iframes: notifications, midi, etc.
      return callback(false);
    },
  );

  // Block in-iframe navigations to ad hosts only — legitimate CDN mirror
  // rotations (streamwish → ghbrisk.com, new dood subdomains) must NOT be
  // blocked.
  mainWindow.webContents.on("will-frame-navigate", (evt) => {
    if (evt.isMainFrame) return;
    const host = (() => { try { return new URL(evt.url).hostname.toLowerCase(); } catch { return ""; } })();
    if (AD_HOST_RE.test(host)) {
      console.info(`[ad-block] blocked iframe nav → ${host}`);
      evt.preventDefault();
    }
  });

  // When an embed iframe fails to load (ERR_CONNECTION_TIMED_OUT on
  // blocked CDNs, ERR_QUIC_PROTOCOL_ERROR, etc.), tell the renderer
  // to advance immediately instead of waiting for the iframe onError
  // (which fires ~5s later on some platforms). Only trigger for the
  // ACTIVE iframe URL — ad sub-frames inside the embed page also fire
  // did-fail-load and would cause false-positive fast-advances.
  mainWindow.webContents.on("did-fail-load", (_evt, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame) return;
    // ERR_ABORTED (-3) is NOT a failure — it fires when a load is superseded
    // by a redirect or a fresh navigation inside the same frame. ok.ru and
    // videa embeds load their landing page and then immediately redirect /
    // re-navigate internally, so they hit did-fail-load with -3 milliseconds
    // after onLoad. Treating that as a failure ripped the working embed out
    // and advanced to the next server (the "loads then goes black" symptom).
    // Only advance on genuine network failures (timeouts, DNS, refused, etc.).
    if (errorCode === -3) return;
    // Compare by host + last path segment so a provider redirect (e.g.
    // mp4upload.com → www.mp4upload.com, or a CDN mirror swap) doesn't make
    // the failed URL look like a different iframe and either suppress a real
    // failure or, worse, never clear — leaving the embed blank.
    const key = (s: string) => {
      try {
        const u = new URL(s);
        const seg = u.pathname.split("/").filter(Boolean).pop() || "";
        return `${u.hostname.replace(/^www\./, "")}/${seg}`;
      } catch {
        return (s || "").split("?")[0].split("#")[0];
      }
    };
    if (!activeIframeUrl) return;
    if (key(validatedURL || "") !== key(activeIframeUrl)) return;
    console.info(`[player] iframe load failed (${errorDescription}), advancing`);
    activeIframeUrl = null;
    mainWindow?.webContents.send("pantoufa:iframe-failed", { url: validatedURL });
  });

  mainWindow.webContents.on("did-finish-load", () => {
    if (pendingAuthCallback && mainWindow) {
      mainWindow.webContents.send("pantoufa:auth-callback", pendingAuthCallback);
      pendingAuthCallback = null;
    }
  });

  // Inject ad-hiding CSS into ALL video-embed sub-frames. The selector
  // sheet targets common ad container class/id patterns without touching
  // the actual video player controls. Skip the main frame to avoid
  // breaking our own app's UI.
  mainWindow.webContents.on("did-frame-navigate", async (_evt, url, _httpResponseCode, _httpStatusText, isMainFrame, frameProcessId, frameRoutingId) => {
    if (isMainFrame) return;
    try {
      const host = new URL(url).hostname.toLowerCase();
      // Only inject into video embed hosts, not analytics/tracker frames
      if (!host || /google|facebook|doubleclick|googletagmanager|supabase/.test(host)) return;
      const frames = mainWindow?.webContents.mainFrame?.framesInSubtree ?? [];
      const frame = frames.find((f) =>
        f.processId === frameProcessId && f.routingId === frameRoutingId,
      );
      if (!frame || frame.isDestroyed()) return;
      await frame.executeJavaScript(`
        (function(){
          if (window.__pa_adkill) return;
          window.__pa_adkill = true;

          // Hide common ad containers / overlay layers. Targets ad-specific
          // class/id patterns only — never the player chrome itself.
          if (!document.getElementById('__pa_ad_block')) {
            var s = document.createElement('style');
            s.id = '__pa_ad_block';
            s.textContent = 'div[class*="ad-"],div[id*="-ad"],div[class*="ads-"],div[id*="banner"],div[class*="popup"],div[class*="popunder"],div[class*="modal-ad"],[class*="adsby"],[class*="adsence"],[class*="ajax-ad"],[class*="sponsored"],[class*="native-ad"],[class*="promoted"],[id*="google_ads"],[id*="div-gpt-ad"],[class*="outbrain"],[class*="taboola"],[class*="mgid"],[class*="revcontent"],ins.adsbygoogle{display:none!important}';
            (document.head || document.documentElement).appendChild(s);
          }

          // Kill popups / popunders. Pirate embeds open an ad tab via
          // window.open on the first click anywhere on the player. Inline
          // players never legitimately call it, so neutralize it outright.
          try {
            window.open = function(){ return null; };
            Object.defineProperty(window, 'open', { value: function(){ return null; }, writable: false, configurable: false });
          } catch (e) {}

          // Swallow the default navigation of cross-origin target=_blank
          // anchors (the other common popunder trigger) in the capture phase.
          // preventDefault only — we don't stopPropagation, so the player's
          // own play handler on the same click still runs.
          document.addEventListener('click', function (e) {
            try {
              var a = e.target && e.target.closest && e.target.closest('a[target="_blank"]');
              if (!a || !a.href) return;
              if (new URL(a.href).hostname !== location.hostname) e.preventDefault();
            } catch (e2) {}
          }, true);
        })();
      `).catch(() => {});
    } catch {}
  });

  // Let iframes (streamwish, mp4upload, etc.) request fullscreen so their
  // native player fullscreen button works. Electron doesn't auto-propagate
  // HTML5 fullscreen requests from cross-origin iframes to the parent
  // document's fullscreenElement, so we use IPC to tell the renderer to
  // make the iframe container a fixed fullscreen overlay.
  mainWindow.webContents.on("enter-html-full-screen", () => {
    mainWindow?.setFullScreen(true);
    mainWindow?.webContents.send("pantoufa:fullscreen-changed", true);
  });
  mainWindow.webContents.on("leave-html-full-screen", () => {
    mainWindow?.setFullScreen(false);
    mainWindow?.webContents.send("pantoufa:fullscreen-changed", false);
  });

  // When the main window is about to close, destroy all hidden scraper
  // BrowserWindows so window-all-closed can fire. Without this the scraper
  // pool keeps the app alive indefinitely.
  mainWindow.on("close", () => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w !== mainWindow) try { w.destroy(); } catch {}
    }
  });

  if (isDev) {
    // Attach debugger BEFORE loading page and opening DevTools so
    // we can suppress the anti-adblock `debugger;` statements that
    // pirate-site embed pages inject. setSkipAllPauses + auto-resume
    // listener together ensure no "Paused in debugger" overlays.
    try { mainWindow.webContents.debugger.attach("1.3"); } catch { /* already attached */ }
    mainWindow.webContents.debugger.sendCommand("Debugger.enable").catch(() => {});
    mainWindow.webContents.debugger.sendCommand("Debugger.setSkipAllPauses", { skip: true }).catch(() => {});
    mainWindow.webContents.debugger.sendCommand("Debugger.setPauseOnExceptions", { state: "none" }).catch(() => {});
    mainWindow.webContents.debugger.on("message", (_event, method) => {
      if (method === "Debugger.paused") {
        mainWindow?.webContents.debugger.sendCommand("Debugger.resume").catch(() => {});
      }
    });
    void mainWindow.loadURL(DEV_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    void mainWindow.loadFile(path.join(__dirname, "..", "..", "dist", "index.html"));
  }
}

app.on("second-instance", (_event, argv) => {
  const url = argv.find((a) => a.startsWith(`${PROTOCOL}://`));
  if (url) handleAuthCallbackUrl(url);
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on("open-url", (event, url) => {
  event.preventDefault();
  handleAuthCallbackUrl(url);
});

/* ── pantoufa-video:// proxy ────────────────────────────────────────────
 *
 * v2 format: pantoufa-video://x/<pct-encoded-origin>/<cdn-path>?<cdn-qs>&__pantoufa_ref=<pct-encoded-embed>
 *   The CDN origin is percent-encoded (encodeURIComponent) as the first path
 *   segment after /x/. This survives URL hostname lowercasing and has no
 *   padding or case-sensitivity issues.
 *   When hls.js resolves a relative segment against this URL the query
 *   params survive and the handler reconstructs the full CDN URL from
 *   path-segment-2 (decoded origin) + remaining path + non-ref query params.
 *
 * v1 format (backwards compat): pantoufa-video://x/?u=<encoded>&ref=<encoded>
 */
const REF_PARAM = "__pantoufa_ref";

function proxyUrlFor(absUrl: string, referer: string): string {
  let u: URL;
  try { u = new URL(absUrl); } catch { return `${VIDEO_PROTOCOL}://x/?u=${encodeURIComponent(absUrl)}&ref=${encodeURIComponent(referer)}`; }
  const originEnc = encodeURIComponent(`${u.protocol}//${u.host}`);
  const refEnc = encodeURIComponent(referer);
  const sep = u.search ? "&" : "?";
  return `${VIDEO_PROTOCOL}://x/${originEnc}${u.pathname}${u.search}${sep}${REF_PARAM}=${refEnc}`;
}

function rewriteM3U8(text: string, baseUrl: string, referer: string): string {
  let base: URL;
  try { base = new URL(baseUrl); } catch { return text; }

  const lines = text.split(/\r?\n/);
  const rewritten = lines.map((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed.startsWith("#")) {
      // EXT-X-KEY / EXT-X-MAP / EXT-X-MEDIA / EXT-X-I-FRAME-STREAM-INF /
      // EXT-X-SESSION-KEY / EXT-X-SESSION-DATA — all carry URI="..." that
      // must be proxied so the proxy's session cookies + Referer are used.
      const hasUri = /URI="([^"]+)"/.test(trimmed);
      if (hasUri) {
        return trimmed.replace(/URI="([^"]+)"/g, (_m, u) => {
          try {
            const abs = new URL(u, base).toString();
            return `URI="${proxyUrlFor(abs, referer)}"`;
          } catch {
            return _m;
          }
        });
      }
      return line; // comment / metadata tag — no URI to proxy
    }
    // Segment line — may be relative (init.mp4) or absolute.
    try {
      const abs = new URL(trimmed, base).toString();
      return proxyUrlFor(abs, referer);
    } catch {
      console.warn(`[pantoufa-video] m3u8 line ${i} could not be proxied: "${trimmed}"`);
      return line;
    }
  });
  return rewritten.join("\n");
}

// URLs the proxy is currently fetching from defaultSession. The
// renderer's capture listener checks this set so the proxy's own
// outbound requests don't loop back as new "captured" URLs — which
// would otherwise cause the just-expired URL to be re-published as
// a fresh capture during a re-extract cycle.
const inFlightProxyTargets = new Set<string>();

/**
 * Hit Dailymotion's public metadata endpoint and return the master HLS
 * URL. Skipping the iframe means no ad break, no autoplay games, and
 * no race between token mint time and proxy fetch.
 *
 * The metadata endpoint isn't documented but is what dailymotion.com
 * itself calls — it's stable enough to rely on. Returns `null` when
 * the video has DRM (Veedict) or geo-blocking we can't bypass.
 */
async function extractDailymotion(
  iframeUrl: string,
): Promise<{ url: string; type: "hls" | "mp4" } | null> {
  const m =
    iframeUrl.match(/dailymotion\.com\/(?:embed\/)?video\/([a-zA-Z0-9]+)/) ||
    iframeUrl.match(/dai\.ly\/([a-zA-Z0-9]+)/);
  if (!m) return null;
  const id = m[1];

  const endpoint = `https://www.dailymotion.com/player/metadata/video/${id}`;
  const uaHint =
    BrowserWindow.getAllWindows()[0]?.webContents.getUserAgent() ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

  const resp = await session.defaultSession.fetch(endpoint, {
    method: "GET",
    headers: {
      "User-Agent": uaHint,
      "Accept": "application/json",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": "https://www.dailymotion.com/",
      "Origin": "https://www.dailymotion.com",
      "X-Pantoufa-Proxy": "1",
    },
    redirect: "follow",
    credentials: "include",
    cache: "no-store",
  });
  if (!resp.ok) return null;

  const data = (await resp.json()) as {
    qualities?: Record<string, Array<{ type?: string; url?: string }>>;
    error?: unknown;
  };
  if (data?.error) return null;
  const qualities = data?.qualities || {};
  // Preference order — auto (HLS) first, then 1080, etc.
  const order = ["auto", "1080", "720", "480", "380", "240"];
  for (const q of order) {
    const arr = qualities[q];
    if (!Array.isArray(arr)) continue;
    const hls = arr.find((s) => s?.type === "application/x-mpegURL" && s.url);
    if (hls?.url) return { url: hls.url, type: "hls" };
    const mp4 = arr.find((s) => s?.type === "video/mp4" && s.url);
    if (mp4?.url) return { url: mp4.url, type: "mp4" };
  }
  return null;
}

// Generic headless capture. Loads the embed in an offscreen window with the
// fetch/XHR/video-tag hooks armed (VIDEO_HOOK_INSTALL) and returns the first
// real .m3u8/.mp4 the player asks for. Works for EVERY provider whose player
// requests a URL ending in .m3u8/.mp4 — streamwish, videa, voe, share4max,
// streamruby, uqload all qualify. Providers whose CDN URLs carry no file
// extension (ok.ru/mycdn.me, doodstream tokens, vk) are NOT captured here and
// need a dedicated extractor or the iframe fallback.
async function extractViaCapture(
  iframeUrl: string,
  label: string,
  timeoutMs = 30000,
): Promise<{ url: string; type: "hls" | "mp4" } | null> {
  try {
    const result = await enqueue({
      url: iframeUrl,
      injectBefore: VIDEO_HOOK_INSTALL,
      injectAfter: EXTRACT_VIDEO_URL,
      timeoutMs,
      isVideoJob: true,
    });
    if (result?.url) {
      console.info(`[${label}] capture hit → ${result.url}`);
      return { url: result.url, type: result.url.includes(".m3u8") ? "hls" : "mp4" };
    }
    console.warn(`[${label}] capture found nothing`);
    return null;
  } catch (e) {
    console.warn(`[${label}] capture failed:`, e);
    return null;
  }
}

// videa.hu (and its vidvaita/vidit clones) never inline the stream in the embed
// HTML — the player pulls it from an XML API (/player/xml). Older/clone hosts
// return that XML in plaintext; videa.hu proper now returns it base64'd and
// RC4-encrypted, keyed off an `_xt` nonce printed in the player page. Both are
// resolved here so the real progressive MP4 plays in the custom <video> player
// instead of dropping back to videa's iframe. (Mirrors yt-dlp's videa flow.)
const VIDEA_STATIC_SECRET = "xHb0ZvME5q8CBcoQi6AngerDu3FGO9fkUlwPmLVY_RTzj2hJIS4NasXWKy1td7p";

function videaRc4(cipher: Buffer, key: string): string {
  const keyLen = key.length;
  const S = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + key.charCodeAt(i % keyLen)) % 256;
    [S[i], S[j]] = [S[j], S[i]];
  }
  const out = Buffer.alloc(cipher.length);
  let a = 0, b = 0;
  for (let m = 0; m < cipher.length; m++) {
    a = (a + 1) % 256;
    b = (b + S[a]) % 256;
    [S[a], S[b]] = [S[b], S[a]];
    out[m] = S[(S[a] + S[b]) % 256] ^ cipher[m];
  }
  return out.toString("utf8");
}

// Pick the best <video_source> out of a videa player XML. Prefers the highest
// resolution and HLS over progressive when both exist.
function parseVideaSources(xml: string): { url: string; type: "hls" | "mp4" } | null {
  // videa signs each progressive variant: the bare <video_source> URL (e.g.
  // //videa.hu/static/720p/…, no extension) 403s at the CDN. The real URL needs
  // ?md5=<hash>&expires=<exp>, where <hash> is the per-quality token from the
  // <hash_values> block (hash_value_360p, hash_value_720p, …) and <exp> is the
  // source's exp attr. Mirrors yt-dlp's update_url_query(md5, expires). Without
  // this the custom player loads a dead URL and falls back to videa's iframe.
  const hashes = new Map<string, string>();
  const hre = /<hash_value_([^>\s]+)>\s*([^<]+?)\s*<\/hash_value_[^>]+>/gi;
  let hm: RegExpExecArray | null;
  while ((hm = hre.exec(xml))) hashes.set(hm[1].toLowerCase(), hm[2].trim());
  const parentExp = xml.match(/<video_sources\b[^>]*\bexp="(\d+)"/i)?.[1] || "";

  const sources: Array<{ url: string; q: number; hls: boolean }> = [];
  const re = /<video_source\b([^>]*)>(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?<\/video_source>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    let url = m[2].trim();
    if (url.startsWith("//")) url = "https:" + url;
    if (!/^https?:\/\//.test(url) || DECOY_RE.test(url)) continue;
    const attrs = m[1];
    const height = parseInt(attrs.match(/height\s*=\s*"(\d+)"/i)?.[1] || "0", 10);
    const name = attrs.match(/name\s*=\s*"([^"]*)"/i)?.[1] || "";
    const hls = /\.m3u8/i.test(url);
    // Progressive variants need the md5/expires signature; HLS playlists are
    // already self-contained.
    if (!hls) {
      const md5 = hashes.get(name.toLowerCase());
      if (md5) {
        const exp = attrs.match(/\bexp="(\d+)"/i)?.[1] || parentExp;
        const sep = url.includes("?") ? "&" : "?";
        url += `${sep}md5=${encodeURIComponent(md5)}`;
        if (exp) url += `&expires=${encodeURIComponent(exp)}`;
      }
    }
    sources.push({ url, q: height || parseInt(name, 10) || 0, hls });
  }
  if (sources.length) {
    sources.sort((x, y) => (y.hls ? 1 : 0) - (x.hls ? 1 : 0) || y.q - x.q);
    const best = sources[0];
    return { url: best.url, type: best.hls ? "hls" : "mp4" };
  }
  // No structured tags — fall back to any media URL in the document.
  const any = xml.match(/https?:\/\/[^"'<\s]+\.(?:m3u8|mp4)[^"'<\s]*/i)?.[0];
  if (any && !DECOY_RE.test(any)) return { url: any, type: /\.m3u8/i.test(any) ? "hls" : "mp4" };
  return null;
}

async function extractVideaXml(
  iframeUrl: string,
): Promise<{ url: string; type: "hls" | "mp4" } | null> {
  try {
    const u = new URL(iframeUrl);
    const idM =
      iframeUrl.match(/[?&]v=([a-zA-Z0-9]+)/) ||
      iframeUrl.match(/\/player\/v\/([a-zA-Z0-9]+)/) ||
      u.pathname.match(/\/([a-zA-Z0-9]{8,})(?:\/|$)/);
    if (!idM) {
      console.info("[extractVidea] no video id in URL");
      return null;
    }
    const id = idM[1];
    const origin = u.origin;
    const ref = providerRefererForHost(u.hostname) ?? { referer: `${origin}/`, origin };
    const fetchVidea = (target: string) =>
      session.defaultSession.fetch(target, {
        method: "GET",
        headers: {
          "User-Agent": PLAYBACK_UA,
          "Accept": "*/*",
          "Accept-Language": "en-US,en;q=0.9",
          "Referer": ref.referer,
          "Origin": ref.origin,
          "X-Pantoufa-Proxy": "1",
        },
        redirect: "follow",
        cache: "no-store",
      });

    // 1) Plaintext XML (clone hosts + older videa).
    for (const ep of [
      `${origin}/player/xml?platform=desktop&v=${id}`,
      `${origin}/videaplayer_get_xml.php?v=${id}`,
    ]) {
      try {
        const resp = await fetchVidea(ep);
        if (!resp.ok) continue;
        const text = await resp.text();
        if (/<\?xml|<video_source/i.test(text)) {
          const got = parseVideaSources(text);
          if (got) {
            console.info(`[extractVidea] xml hit → ${got.url}`);
            return got;
          }
        }
      } catch {}
    }

    // 2) Encrypted videa.hu flow: derive the request token from the `_xt`
    //    nonce in the player page, then RC4-decrypt the base64 XML response.
    try {
      const playerResp = await fetchVidea(`${origin}/player?v=${id}`);
      if (playerResp.ok) {
        const page = await playerResp.text();
        const nonce = page.match(/_xt\s*=\s*"([^"]+)"/)?.[1];
        if (nonce && nonce.length > 32) {
          const l = nonce.slice(0, 32);
          const s = nonce.slice(32);
          let result = "";
          // Exactly 32 iterations (one per char of `l`), NOT s.length — `s` is
          // longer than 32. Looping over s.length reads l[i] past its end
          // (→ undefined → indexOf -1) and yields a wrong-length `result`,
          // corrupting both the `_t` token and the RC4 key. Mirrors yt-dlp's
          // `for i in range(0, 32)`.
          for (let i = 0; i < 32; i++) {
            // Python wraps negative indices to the end of the string; JS's
            // String.at() matches that, plain s[k] would not.
            const k = i - (VIDEA_STATIC_SECRET.indexOf(l[i]) - 31);
            result += s.at(k) ?? "";
          }
          const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
          let randomSeed = "";
          for (let i = 0; i < 8; i++) randomSeed += alphabet[Math.floor(Math.random() * alphabet.length)];
          const xmlResp = await fetchVidea(
            `${origin}/player/xml?platform=desktop&v=${id}&_s=${randomSeed}&_t=${result.slice(0, 16)}`,
          );
          if (xmlResp.ok) {
            const body = await xmlResp.text();
            let xml = body;
            if (!body.trimStart().startsWith("<?xml") && !/<video_source/i.test(body)) {
              const xs = xmlResp.headers.get("x-videa-xs") || "";
              xml = videaRc4(Buffer.from(body, "base64"), result.slice(16) + randomSeed + xs);
            }
            const got = parseVideaSources(xml);
            if (got) {
              console.info(`[extractVidea] decrypted xml hit → ${got.url}`);
              return got;
            }
          }
        }
      }
    } catch (e) {
      console.warn("[extractVidea] encrypted flow failed:", e);
    }

    console.info("[extractVidea] xml API yielded no source");
    return null;
  } catch (e) {
    console.warn("[extractVidea] xml extraction failed:", e);
    return null;
  }
}

async function extractVidea(iframeUrl: string) {
  // Direct XML API first (exact source URLs, sub-second), then static HTML
  // scrape, then headless capture as the last resort.
  return (await extractVideaXml(iframeUrl))
    ?? (await extractViaHtml(iframeUrl, "extractVidea"))
    ?? extractViaCapture(iframeUrl, "extractVidea", 25000);
}

async function extractStreamwish(iframeUrl: string) {
  // streamwish inlines its hls source in a packed-JS blob — the static pass
  // resolves it in well under a second. Headless capture (which also rides
  // out Cloudflare challenges) remains the fallback.
  return (await extractViaHtml(iframeUrl, "extractStreamwish"))
    ?? extractViaCapture(iframeUrl, "extractStreamwish", 35000);
}

// ok.ru can't be captured by the generic hook: its stream URLs come off
// *.mycdn.me with NO .mp4/.m3u8 extension (…/?expires=…&type=4), so the
// fetch/XHR hook's isVideo() regex never matches. Instead, ok.ru inlines the
// whole player config in a `data-options` attribute whose `flashvars.metadata`
// is (sometimes double-encoded) JSON carrying an `hlsManifestUrl` and a
// `videos` array of progressive MP4s. Fetch the embed HTML and parse it.
async function extractOkru(
  iframeUrl: string,
): Promise<{ url: string; type: "hls" | "mp4" } | null> {
  // Normalize to the canonical embed form (works for /video/ and /videoembed/).
  let embedUrl = iframeUrl;
  const idM = iframeUrl.match(/(?:videoembed|video)\/(\d+)/);
  if (idM) embedUrl = `https://ok.ru/videoembed/${idM[1]}`;

  let html = "";
  try {
    const resp = await session.defaultSession.fetch(embedUrl, {
      method: "GET",
      headers: {
        "User-Agent": VIDEO_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://ok.ru/",
        "Origin": "https://ok.ru",
        "X-Pantoufa-Proxy": "1",
      },
      redirect: "follow",
      cache: "no-store",
    });
    console.info(`[extractOkru] GET ${embedUrl} → ${resp.status}`);
    if (resp.ok) html = await resp.text();
  } catch (e) {
    console.warn("[extractOkru] HTML fetch failed:", e);
  }

  if (html) {
    // Recover the `data-options` JSON: HTML-entity-decode, then parse. The
    // metadata field is itself a JSON string (occasionally double-escaped).
    const decode = (s: string) =>
      s
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#92;/g, "\\")
        .replace(/\\u0026/g, "&");
    try {
      // The data-options attribute uses double quotes with &quot; entities for
      // its inner JSON, so everything up to the closing literal " is the value.
      const optM = html.match(/data-options="([^"]*)"/) || html.match(/data-options='([^']*)'/);
      let metaRaw: unknown = null;
      if (optM) {
        const opts = JSON.parse(decode(optM[1]));
        metaRaw = opts?.flashvars?.metadata ?? null;
      }
      // Fallback: pull the metadata JSON string directly if data-options
      // didn't parse (some layouts inline metadata in a separate script).
      if (!metaRaw) {
        const mm = html.match(/"metadata"\s*:\s*"((?:\\.|[^"\\])*)"/);
        if (mm) metaRaw = decode(mm[1]).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      }
      if (metaRaw) {
        const meta = typeof metaRaw === "string" ? JSON.parse(metaRaw) : metaRaw;
        const hls: string | undefined = meta?.hlsManifestUrl || meta?.hlsMasterPlaylistUrl;
        if (hls) {
          console.info(`[extractOkru] hls manifest → ${hls}`);
          return { url: hls, type: "hls" };
        }
        const videos: Array<{ name?: string; url?: string }> = Array.isArray(meta?.videos) ? meta.videos : [];
        // ok.ru orders videos low→high; prefer the highest progressive MP4.
        const rankName: Record<string, number> = { mobile: 0, lowest: 1, low: 2, sd: 3, hd: 4, full: 5, quad: 6, ultra: 7 };
        const best = videos
          .filter((v) => v?.url)
          .sort((a, b) => (rankName[b.name || ""] ?? 0) - (rankName[a.name || ""] ?? 0))[0];
        if (best?.url) {
          const url = best.url.startsWith("//") ? "https:" + best.url : best.url;
          console.info(`[extractOkru] mp4 (${best.name}) → ${url}`);
          return { url, type: "mp4" };
        }
      }
    } catch (e) {
      console.warn("[extractOkru] parse failed:", e);
    }
    console.info("[extractOkru] no stream URL in HTML");
  }
  return null;
}

// Dean Edwards / p.a.c.k.e.r de-obfuscator. mp4upload wraps its player
// config (including the real .mp4 URL) in an eval(function(p,a,c,k,e,d){…})
// blob; un-pack it so the URL regexes below can see the source.
function unpackPacked(source: string): string {
  // eval(function(p,a,c,k,e,d){…}('PAYLOAD',RADIX,COUNT,'k1|k2|…'.split('|'),0,{}))
  const m = source.match(
    /\}\s*\(\s*'((?:\\.|[^'\\])*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'((?:\\.|[^'\\])*)'\s*\.split\(\s*'\|'\s*\)/,
  );
  if (!m) return source;
  let payload = m[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\");
  const radix = parseInt(m[2], 10);
  let count = parseInt(m[3], 10);
  const keywords = m[4].split("|");
  const toBase = (n: number): string =>
    (n < radix ? "" : toBase(Math.floor(n / radix))) +
    ((n = n % radix) > 35 ? String.fromCharCode(n + 29) : n.toString(36));
  while (count--) {
    if (keywords[count]) {
      payload = payload.replace(
        new RegExp("\\b" + toBase(count) + "\\b", "g"),
        keywords[count],
      );
    }
  }
  return payload;
}

// Decoy / placeholder streams some embeds preload to fool scrapers.
const DECOY_RE = /test-videos\.co\.uk|bigbuckbunny|sample[-_.]|placeholder|tos\.mp4|\/lol\/file\.mp4/i;

// Un-pack EVERY p.a.c.k.e.r blob in a page (unpackPacked only handles the
// first). streamwish/streamruby/share4max pages often carry several eval()
// blobs and the player config isn't always the first one.
function unpackAllPacked(html: string): string[] {
  const out: string[] = [];
  const re = /eval\(function\(p,a,c,k,e,d\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      const up = unpackPacked(html.slice(m.index));
      if (up && up !== html.slice(m.index)) out.push(up);
    } catch {}
  }
  return out;
}

/**
 * Generic static extractor: fetch the embed page HTML from the main process
 * (correct canonical Referer, playback UA so any minted token stays valid for
 * the <video> that plays it), un-pack packed JS, and regex out the first real
 * .m3u8/.mp4 source. Sub-second when it hits — the headless capture engine is
 * only needed for embeds that compute the URL at runtime.
 *
 * Handles two provider quirks:
 *  - voe-style tiny redirect pages (`window.location.href = '…'`) — followed once.
 *  - voe's base64 `'hls': '…'` source field.
 */
async function extractViaHtml(
  iframeUrl: string,
  label: string,
): Promise<{ url: string; type: "hls" | "mp4" } | null> {
  try {
    let pageUrl = iframeUrl;
    let html = "";
    for (let hop = 0; hop < 2; hop++) {
      const u = new URL(pageUrl);
      const canon = providerRefererForHost(u.hostname) ?? {
        referer: `${u.protocol}//${u.host}/`,
        origin: `${u.protocol}//${u.host}`,
      };
      const resp = await session.defaultSession.fetch(pageUrl, {
        method: "GET",
        headers: {
          "User-Agent": PLAYBACK_UA,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Referer": canon.referer,
          "Origin": canon.origin,
          "X-Pantoufa-Proxy": "1",
        },
        redirect: "follow",
        cache: "no-store",
      });
      if (!resp.ok) {
        console.info(`[${label}] static GET ${pageUrl} → ${resp.status}`);
        return null;
      }
      html = await resp.text();
      // voe serves a tiny stub that client-side-redirects to a mirror domain.
      const redir = html.match(/window\.location\.href\s*=\s*['"](https?:\/\/[^'"]+)['"]/);
      if (redir && hop === 0 && html.length < 4096) {
        pageUrl = redir[1];
        continue;
      }
      break;
    }
    if (!html) return null;

    const haystacks = [html, ...unpackAllPacked(html)];
    const patterns = [
      /(?:file|src)\s*:\s*["']([^"']+\.m3u8[^"']*)["']/i,
      /sources\s*:\s*\[\s*\{[^}]*?(?:file|src)\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
      // uqload-style bare string array: sources: ["https://…mp4"]
      /sources\s*:\s*\[\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
      /(?:file|src)\s*:\s*["']([^"']+\.mp4[^"']*)["']/i,
      /<source[^>]+src\s*=\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
      /(https?:\/\/[^"'\s\\<>]+\.(?:m3u8|mp4)[^"'\s\\<>]*)/i,
    ];
    for (const text of haystacks) {
      for (const re of patterns) {
        const raw = text.match(re)?.[1];
        if (!raw || DECOY_RE.test(raw)) continue;
        let abs = "";
        try { abs = new URL(raw, pageUrl).toString(); } catch { continue; }
        if (!/^https?:\/\//.test(abs)) continue;
        console.info(`[${label}] static HTML hit → ${abs}`);
        return { url: abs, type: /\.m3u8(\?|#|$)/i.test(abs) ? "hls" : "mp4" };
      }
    }
    // voe inline base64 HLS source.
    const hlsB64 = html.match(/['"]hls['"]\s*:\s*['"]([A-Za-z0-9+/=]{40,})['"]/);
    if (hlsB64) {
      try {
        const dec = Buffer.from(hlsB64[1], "base64").toString("utf8");
        if (/^https?:\/\//.test(dec)) {
          console.info(`[${label}] base64 hls hit → ${dec}`);
          return { url: dec, type: "hls" };
        }
      } catch {}
    }
    console.info(`[${label}] static HTML found no source`);
    return null;
  } catch (e) {
    console.warn(`[${label}] static HTML extraction failed:`, e);
    return null;
  }
}

// doodstream: the embed page carries a /pass_md5/… path; GET-ing it (with the
// embed page as Referer) returns the CDN base URL, to which the player appends
// 10 random chars + ?token=<md5 tail>&expiry=<now>. No .mp4 extension on the
// final URL — the proxy's extension-less chunking handles playback.
async function extractDood(
  iframeUrl: string,
): Promise<{ url: string; type: "hls" | "mp4" } | null> {
  try {
    const u = new URL(iframeUrl);
    const idM = u.pathname.match(/\/(?:e|d)\/([a-zA-Z0-9]+)/);
    const embedUrl = idM ? `${u.origin}/e/${idM[1]}` : iframeUrl;
    const resp = await session.defaultSession.fetch(embedUrl, {
      method: "GET",
      headers: {
        "User-Agent": PLAYBACK_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": `${u.origin}/`,
        "X-Pantoufa-Proxy": "1",
      },
      redirect: "follow",
      cache: "no-store",
    });
    if (!resp.ok) return null;
    // dood domains rotate via redirects (dood.li → dood.watch …) — pass_md5
    // must be fetched from the FINAL host with the final page as Referer.
    const finalUrl = resp.url || embedUrl;
    const html = await resp.text();
    const md5Path =
      html.match(/\$\.get\(\s*['"](\/pass_md5\/[^'"]+)['"]/)?.[1] ||
      html.match(/['"](\/pass_md5\/[^'"]+)['"]/)?.[1];
    if (!md5Path) {
      console.info("[extractDood] no pass_md5 in embed HTML");
      return null;
    }
    const token = md5Path.split("/").pop() || "";
    const fo = new URL(finalUrl);
    const r2 = await session.defaultSession.fetch(`${fo.origin}${md5Path}`, {
      method: "GET",
      headers: {
        "User-Agent": PLAYBACK_UA,
        "Referer": finalUrl,
        "X-Pantoufa-Proxy": "1",
      },
      cache: "no-store",
    });
    if (!r2.ok) return null;
    const base = (await r2.text()).trim();
    if (!/^https?:\/\//.test(base)) return null;
    const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let rand = "";
    for (let i = 0; i < 10; i++) rand += alphabet[Math.floor(Math.random() * alphabet.length)];
    const url = `${base}${rand}?token=${token}&expiry=${Date.now()}`;
    console.info(`[extractDood] → ${url}`);
    return { url, type: "mp4" };
  } catch (e) {
    console.warn("[extractDood] failed:", e);
    return null;
  }
}

// vk: the video_ext.php embed HTML inlines a player JSON with progressive
// MP4s keyed "url240"…"url1080" plus an optional "hls" manifest.
async function extractVk(
  iframeUrl: string,
): Promise<{ url: string; type: "hls" | "mp4" } | null> {
  try {
    const resp = await session.defaultSession.fetch(iframeUrl, {
      method: "GET",
      headers: {
        "User-Agent": PLAYBACK_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": "https://vk.com/",
        "Origin": "https://vk.com",
        "X-Pantoufa-Proxy": "1",
      },
      redirect: "follow",
      cache: "no-store",
    });
    if (!resp.ok) return null;
    const html = await resp.text();
    const unesc = (s: string) => s.replace(/\\\//g, "/").replace(/\\u0026/g, "&").replace(/&amp;/g, "&");
    let best: { q: number; url: string } | null = null;
    const re = /"url(\d{3,4})"\s*:\s*"([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      const q = parseInt(m[1], 10);
      const url = unesc(m[2]);
      if (!/^https?:\/\//.test(url)) continue;
      if (!best || q > best.q) best = { q, url };
    }
    if (best) {
      console.info(`[extractVk] mp4 ${best.q}p → ${best.url}`);
      return { url: best.url, type: "mp4" };
    }
    const hls = html.match(/"hls"\s*:\s*"([^"]+)"/);
    if (hls) {
      const url = unesc(hls[1]);
      if (/^https?:\/\//.test(url)) {
        console.info(`[extractVk] hls → ${url}`);
        return { url, type: "hls" };
      }
    }
    console.info("[extractVk] no stream URL in embed HTML");
    return null;
  } catch (e) {
    console.warn("[extractVk] failed:", e);
    return null;
  }
}

// Pull the real .mp4 URL straight out of mp4upload's embed page from the
// main process, the same way we do for dailymotion/videa/streamwish. The
// renderer then plays it in the native <video> element via the proxy
// (which already forces the canonical www.mp4upload.com Referer and the
// bytes=0- Range retry the CDN needs). This bypasses the embed iframe
// entirely — the iframe renders a black player because, loaded from
// file://, document.referrer is empty and mp4upload anti-hotlinks it.
async function extractMp4upload(
  iframeUrl: string,
): Promise<{ url: string; type: "hls" | "mp4" } | null> {
  // Force the canonical www host + embed form (matches normalizeEmbedUrl in
  // the renderer) so the page returns the player, not the download page.
  let embedUrl = iframeUrl;
  try {
    const u = new URL(iframeUrl);
    const code =
      u.pathname.match(/\/embed-([a-z0-9]+)\.html/i)?.[1] ||
      u.pathname.match(/^\/([a-z0-9]{8,})/i)?.[1];
    if (code) embedUrl = `https://www.mp4upload.com/embed-${code}.html`;
  } catch {}

  // ── Strategy 1: cheap server-side HTML fetch + un-pack ──
  // Retry transient failures (Cloudflare 5xx/503 "checking your browser",
  // rate-limit, network blip). A single attempt that came back non-200 was
  // silently dropping us to the black iframe fallback even though the embed
  // HTML reliably carries the .mp4 URL. The UA MUST be the desktop playback
  // UA (see PLAYBACK_UA) so the token we extract is valid for the <video>
  // request that plays it.
  let html = "";
  for (let attempt = 0; attempt < 3 && !html; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 600 * attempt));
    try {
      const resp = await session.defaultSession.fetch(embedUrl, {
        method: "GET",
        headers: {
          "User-Agent": PLAYBACK_UA,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Referer": "https://www.mp4upload.com/",
          "Origin": "https://www.mp4upload.com",
          // Marker so onBeforeSendHeaders leaves our Referer alone (see handler).
          "X-Pantoufa-Proxy": "1",
        },
        redirect: "follow",
        cache: "no-store",
      });
      console.info(`[extractMp4upload] GET ${embedUrl} (try ${attempt + 1}) → ${resp.status}`);
      if (resp.ok) {
        const text = await resp.text();
        // A Cloudflare interstitial / placeholder returns 200 but carries no
        // player config — only accept a body that actually has a source.
        if (/player\.src|sources?\s*[:=]|\.mp4/i.test(text)) html = text;
        else console.warn("[extractMp4upload] 200 but no source markers, retrying");
      }
    } catch (e) {
      console.warn(`[extractMp4upload] HTML fetch failed (try ${attempt + 1}):`, e);
    }
  }

  if (html) {
    const haystacks = [html];
    if (/eval\(function\(p,a,c,k,e,d\)/.test(html)) {
      try { haystacks.push(unpackPacked(html)); } catch {}
    }
    const patterns = [
      /player\.src\(\s*["']([^"']+\.mp4[^"']*)["']/i,
      /(?:file|src)\s*:\s*["']([^"']+\.mp4[^"']*)["']/i,
      /<source[^>]+src\s*=\s*["']([^"']+\.mp4[^"']*)["']/i,
      /(https?:\/\/[^"'\s\\]+mp4upload\.com[^"'\s\\]*\.mp4[^"'\s\\]*)/i,
      /(https?:\/\/[^"'\s\\]+\.mp4[^"'\s\\]*)/i,
    ];
    for (const text of haystacks) {
      for (const re of patterns) {
        const url = text.match(re)?.[1];
        if (url && !/sample[-_.]|placeholder|bigbuckbunny|tos\.mp4/i.test(url)) {
          console.info(`[extractMp4upload] HTML unpack hit → ${url}`);
          return { url, type: "mp4" };
        }
      }
    }
    console.info("[extractMp4upload] HTML unpack found no .mp4, trying headless capture");
  }

  // ── Strategy 2: headless capture (same engine streamwish uses) ──
  // Loads the embed in an offscreen BrowserWindow so the player JS runs and
  // actually requests its tokenized .mp4 — the VIDEO_HOOK captures that URL.
  // Handles cases where the URL is computed at runtime / behind a gate the
  // static HTML scan can't see.
  try {
    const result = await enqueue({
      url: embedUrl,
      injectBefore: VIDEO_HOOK_INSTALL,
      injectAfter: EXTRACT_VIDEO_URL,
      timeoutMs: 30000,
      isVideoJob: true,
    });
    if (result?.url) {
      console.info(`[extractMp4upload] headless capture hit → ${result.url}`);
      return { url: result.url, type: result.url.includes(".m3u8") ? "hls" : "mp4" };
    }
    console.warn("[extractMp4upload] headless capture found nothing");
  } catch (e) {
    console.warn("[extractMp4upload] headless capture failed:", e);
  }
  return null;
}

// anime3rb's first-party video host (video.vid3rb.com). The /player/<uuid>
// page inlines a `video_sources` JSON array carrying direct tokenized .mp4
// URLs per quality (480p/720p/1080p), so a single cheap GET yields a stream
// the custom player plays natively — the CDN URLs answer Range requests,
// need no Referer, and aren't IP-locked (their signed redirect carries
// noip=yes). Premium-gated qualities ship with an empty src and are skipped.
// Tokens expire in ~40 minutes, which is why extraction happens at play time
// (the resolve cache is 90s) rather than when the server list is built.
async function extractVid3rb(
  playerUrl: string,
): Promise<{ url: string; type: "hls" | "mp4" } | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 600 * attempt));
    try {
      const resp = await session.defaultSession.fetch(playerUrl, {
        method: "GET",
        headers: {
          "User-Agent": PLAYBACK_UA,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "ar,en;q=0.9",
          "Referer": "https://anime3rb.com/",
          "X-Pantoufa-Proxy": "1",
        },
        redirect: "follow",
        cache: "no-store",
      });
      console.info(`[extractVid3rb] GET ${playerUrl} (try ${attempt + 1}) → ${resp.status}`);
      if (!resp.ok) continue;
      const html = await resp.text();
      // The page declares `video_sources` twice — an empty [] then the real
      // array — so match the non-empty form. The match is valid JSON as-is
      // (URLs use JSON's escaped https:\/\/… slashes).
      const m = html.match(/video_sources\s*=\s*(\[\{[\s\S]*?\}\])\s*;/);
      if (!m) { console.warn("[extractVid3rb] no video_sources in player HTML"); continue; }
      let sources: { src?: string; res?: string; label?: string; premium?: boolean }[] = [];
      try { sources = JSON.parse(m[1]); } catch { continue; }
      const best = sources
        .filter((s) => s.src && /^https?:\/\//.test(s.src) && !s.premium)
        .sort((a, b) => (parseInt(b.res || "0", 10) || 0) - (parseInt(a.res || "0", 10) || 0))[0];
      if (!best?.src) { console.warn("[extractVid3rb] no playable (non-premium) source"); return null; }
      console.info(`[extractVid3rb] ${best.label || best.res || "?"} → ${best.src}`);
      return { url: best.src, type: /\.m3u8(\?|$)/i.test(best.src) ? "hls" : "mp4" };
    } catch (e) {
      console.warn(`[extractVid3rb] fetch failed (try ${attempt + 1}):`, e);
    }
  }
  return null;
}

function registerVideoProxy() {
  const scraperSession = session.fromPartition("persist:scraper");

  // Intercept outgoing requests and inject the correct Referer + Origin
  // passport ONLY if they're missing. The video proxy handler sets its own
  // headers via per-request strategy race — those must NOT be overridden.
  // This interceptor is a fallback safety net for bare requests (embed page
  // navigation, player JS fetches inside the scraper BrowserWindow).
  scraperSession.webRequest.onBeforeSendHeaders(
    {
      urls: [
        // mp4upload
        "*://*.mp4upload.com/*",
        // streamwish family — all known CDN subdomains
        "*://*.streamwish.to/*", "*://*.hgcloud.cc/*", "*://*.hgcloud.to/*",
        "*://*.wishfast.com/*", "*://*.wishembed.pro/*", "*://*.jwembed.com/*",
        "*://*.hlswish.com/*", "*://*.vibuxer.com/*", "*://*.audinifer.com/*",
        "*://*.masukestin.com/*", "*://*.hanerix.com/*",
        // voe
        "*://*.voe.sx/*",
        // doodstream
        "*://*.dood.li/*", "*://*.doodstream.com/*", "*://*.dood.watch/*",
        "*://*.dood.to/*", "*://*.dood.sh/*", "*://*.dood.so/*",
        "*://*.dood.cx/*", "*://*.dood.video/*",
        // uqload
        "*://*.uqload.io/*", "*://*.uqload.com/*", "*://*.uqload.net/*",
        // share4max / megamax
        "*://*.share4max.com/*", "*://*.megamax.com/*",
        // videa
        "*://*.videa.hu/*", "*://*.vidvaita.info/*", "*://*.vidit.info/*",
        // okru
        "*://*.ok.ru/*",
        // dailymotion
        "*://*.dailymotion.com/*", "*://*.dmcdn.net/*",
      ],
    },
    (details, callback) => {
      try {
        const hdrs = details.requestHeaders;

        const hasReferer = Object.keys(hdrs).some(
          (k) => k.toLowerCase() === "referer",
        );

        if (!hasReferer) {
          const host = new URL(details.url).hostname.toLowerCase();
        let ref = "";
        let ori = "";
        if (/mp4upload/.test(host)) {
          ref = "https://www.mp4upload.com/";
          ori = "https://www.mp4upload.com";
        } else if (/streamwish|hgcloud|wishfast|wishembed|jwembed|hlswish|vibuxer|audinifer|masukestin|hanerix/.test(host)) {
          ref = "https://streamwish.to/";
          ori = "https://streamwish.to";
        } else if (/voe\./.test(host)) {
          ref = "https://voe.sx/";
          ori = "https://voe.sx";
        } else if (/dood/.test(host)) {
          ref = "https://dood.li/";
          ori = "https://dood.li";
        } else if (/uqload/.test(host)) {
          ref = "https://uqload.io/";
          ori = "https://uqload.io";
        } else if (/share4max|megamax/.test(host)) {
          ref = "https://share4max.com/";
          ori = "https://share4max.com";
        } else if (/streamruby|rubyvidhub|rubystm|ruby/.test(host)) {
          ref = "https://streamruby.com/";
          ori = "https://streamruby.com";
        } else if (/ok\.ru|odnoklassniki|mycdn\.me/.test(host)) {
          ref = "https://ok.ru/";
          ori = "https://ok.ru";
        } else if (/videa|vidvaita|vidit/.test(host)) {
          ref = "https://videa.hu/";
          ori = "https://videa.hu";
        } else if (/dailymotion|dmcdn/.test(host)) {
          ref = "https://www.dailymotion.com/";
          ori = "https://www.dailymotion.com";
        } else {
          const root = host.split(".").slice(-2).join(".");
          ref = `https://${root}/`;
          ori = `https://${root}`;
        }
        hdrs["Referer"] = ref;
        hdrs["Origin"] = ori;
      }

      callback({ requestHeaders: hdrs });
      } catch {
        // Malformed URL or interceptor bug — let the request through
        // unchanged rather than dropping it silently.
        callback({ requestHeaders: details.requestHeaders });
      }
    },
  );

  // Ported from mobile app (app/watch/[episode].tsx). Each provider has a
  // canonical embed origin that its CDN whitelists. mp4upload's segment
  // host (a4.mp4upload.com:183) rejects www.mp4upload.com embed-URL
  // Referer? No — it WANTS www.mp4upload.com. The desktop "embed" Referer
  // was producing the embed-PAGE URL (e.g. https://www.mp4upload.com/embed-xyz.html)
  // which technically should work, but with port mismatches it sometimes
  // doesn't. Hard-coded canonical origins are what the mobile app uses
  // and they work reliably.
  function canonicalReferer(videoUrl: URL, embedUrl: URL): { referer: string; origin: string } {
    const host = videoUrl.hostname.toLowerCase();
    const eHost = embedUrl.hostname.toLowerCase();
    if (/mp4upload/.test(host)) {
      return { referer: "https://www.mp4upload.com/", origin: "https://www.mp4upload.com" };
    }
    // Check both the CDN host AND the embed host so rotating streamwish
    // mirrors (cybervynx.com) whose CDN domain doesn't match any static
    // regex still get the mandatory streamwish.to Referer.
    if (/streamwish|hgcloud|wishfast|wishembed|jwembed|hlswish/.test(host)
        || /streamwish|hgcloud|wishfast|wishembed|jwembed|hlswish/.test(eHost)) {
      return { referer: "https://streamwish.to/", origin: "https://streamwish.to" };
    }
    if (/voe\./.test(host)) {
      return { referer: "https://voe.sx/", origin: "https://voe.sx" };
    }
    if (/dood/.test(host)) {
      return { referer: "https://dood.li/", origin: "https://dood.li" };
    }
    if (/uqload/.test(host)) {
      return { referer: "https://uqload.io/", origin: "https://uqload.io" };
    }
    if (/share4max|megamax/.test(host)) {
      return { referer: "https://share4max.com/", origin: "https://share4max.com" };
    }
    if (/streamruby|rubyvidhub|rubystm|ruby/.test(host)) {
      return { referer: "https://streamruby.com/", origin: "https://streamruby.com" };
    }
    // ok.ru streams from *.mycdn.me, which whitelists the ok.ru embed Referer
    // (not its own CDN domain). Extracted ok.ru mp4/hls plays via this proxy.
    if (/ok\.ru|odnoklassniki|mycdn\.me/.test(host)) {
      return { referer: "https://ok.ru/", origin: "https://ok.ru" };
    }
    if (/videa|vidvaita|vidit/.test(host)) {
      return { referer: "https://videa.hu/", origin: "https://videa.hu" };
    }
    if (/dailymotion|dmcdn/.test(host)) {
      return { referer: "https://www.dailymotion.com/", origin: "https://www.dailymotion.com" };
    }
    const root = host.split(".").slice(-2).join(".");
    return { referer: `https://${root}/`, origin: `https://${root}` };
  }

  // Per-host cache of the Referer strategy that last worked — backup for
  // hosts not covered by canonicalReferer().
  type StrategyName = "canonical" | "embed" | "target-self" | "no-referer";
  const hostStrategyCache = new Map<string, StrategyName>();

  type Strategy = { name: StrategyName; headers: () => Record<string, string> };
  function strategies(target: URL, embed: URL): Strategy[] {
    const canonical = canonicalReferer(target, embed);
    const canonicalHeaders = () => ({ "Referer": canonical.referer, "Origin": canonical.origin });
    const embedHeaders = () => ({
      "Referer": `${embed.protocol}//${embed.host}/`,
      "Origin": `${embed.protocol}//${embed.host}`,
    });
    const targetHeaders = () => ({
      "Referer": `${target.protocol}//${target.host}/`,
      "Origin": `${target.protocol}//${target.host}`,
    });
    const noRefererHeaders = () => ({});
    const all: Strategy[] = [
      { name: "canonical", headers: canonicalHeaders },
      { name: "embed", headers: embedHeaders },
      { name: "target-self", headers: targetHeaders },
      { name: "no-referer", headers: noRefererHeaders },
    ];

    // mp4upload CDN requires the canonical www.mp4upload.com Referer.
    if (/mp4upload/.test(target.hostname) || /mp4upload/.test(embed.hostname)) {
      return [
        { name: "canonical", headers: canonicalHeaders },
      ];
    }

    // streamwish family: the CDN whitelists the Referer of the EMBED PAGE that
    // minted the token — and streamwish rotates that page across many mirror
    // domains (hgcloud.to, embedwish.com, awish.pro, …). Hard-coding
    // streamwish.to as the only Referer therefore 403s every segment whenever
    // the embed lives on a different mirror, with no fallback to recover (which
    // is exactly why streamwish "doesn't play" in the custom player while every
    // other provider does). So lead with the ACTUAL embed-page Referer, then
    // fall back to the streamwish.to literal and the CDN's own domain. The
    // winning strategy is cached per host, so this races at most once per host
    // — the rate-limit concern that motivated the single-strategy lock still
    // holds for every subsequent fetch.
    if (/streamwish|hgcloud|wishfast|wishembed|jwembed|hlswish|vibuxer|audinifer|masukestin|hanerix/.test(target.hostname)
        || /streamwish|hgcloud|wishfast|wishembed|jwembed|hlswish|vibuxer|audinifer|masukestin|hanerix/.test(embed.hostname)) {
      return [
        { name: "embed", headers: embedHeaders },
        { name: "canonical", headers: canonicalHeaders },
        { name: "target-self", headers: targetHeaders },
      ];
    }

    // If we know which strategy works for this host, try it first.
    const cached = hostStrategyCache.get(target.host);
    if (cached) {
      const reordered = [
        all.find((s) => s.name === cached)!,
        ...all.filter((s) => s.name !== cached),
      ];
      return reordered;
    }
    return all;
  }

  async function fetchWithStrategy(
    target: string,
    strat: Strategy,
    range: string | null,
    method: string,
    signal: AbortSignal,
  ) {
    // Mirror the iframe's UA so CDNs that bind tokens to UA fingerprint
    // (Cloudflare bot-fight + many video CDNs) accept proxy fetches with
    // the same signed URLs the iframe just minted. Falls back to a plain
    // Chrome desktop UA if we're called before the window is up.
    const iframeUa =
      mainWindow?.webContents.getUserAgent() ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

    const baseHeaders: Record<string, string> = {
      "User-Agent": iframeUa,
      "Accept": "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      // No "Accept-Encoding: identity" — let Chromium negotiate gzip/br
      // like the iframe does. Some CDN bot-detection rules flag clients
      // that disable compression.
      "Sec-Fetch-Dest": /\.(m3u8|mpd)(\?|#|$)/i.test(target) ? "empty" : "video",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "cross-site",
    };

    if (range) baseHeaders["Range"] = range;

    // CRITICAL: do NOT append `_p=` cache-buster to signed URLs. The
    // signature is computed over the full query string by most providers
    // (Cloudflare streamwish, voe, dailymotion, etc.). Adding any extra
    // param invalidates the HMAC and the CDN responds 403 — which is
    // exactly the "works briefly then fails" symptom. Instead, set
    // cache: "no-store" on the fetch so Chromium doesn't cache responses
    // and the strategy race can't be poisoned by a stale 403. Cache-
    // buster is only used for fully bare URLs (no query string at all),
    // which are rare with real provider CDNs.
    const cachebusted =
      target.includes("?") || target.includes("#")
        ? target
        : `${target}?_p=${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Use defaultSession (same as the renderer iframe). The iframe
    // already passed Cloudflare challenges and stored clearance cookies
    // in defaultSession. If the proxy used a different partition, the
    // CDN's CF check would reject our requests even with the right
    // Referer + token. The marker header tells the defaultSession's
    // Referer interceptor not to override our strategy-specific value.
    //
    // Track the URL in inFlightProxyTargets so the renderer's capture
    // listener (which also runs on defaultSession requests) doesn't
    // echo our proxy fetches back as fresh "captured" URLs.
    inFlightProxyTargets.add(cachebusted);
    if (cachebusted !== target) inFlightProxyTargets.add(target);
    try {
      const upstream = await session.defaultSession.fetch(cachebusted, {
        method,
        headers: {
          ...baseHeaders,
          ...strat.headers(),
          "X-Pantoufa-Proxy": "1",
        },
        redirect: "follow",
        credentials: "include",
        cache: "no-store",
        bypassCustomProtocolHandlers: true,
        signal,
      });

      if (!upstream.ok) throw new Error(`${strat.name} → ${upstream.status}`);
      return { upstream, strategy: strat.name };
    } finally {
      // Keep entries for a brief moment so any onBeforeRequest still
      // firing during request teardown (especially for aborted losers
      // of the strategy race) hits the skip path. 2s is plenty.
      setTimeout(() => {
        inFlightProxyTargets.delete(cachebusted);
        inFlightProxyTargets.delete(target);
      }, 2000);
    }
  }

  async function tryFetch(
    target: string,
    embedHref: string,
    range: string | null,
    method: string,
    signal: AbortSignal | undefined,
  ) {
    const targetUrl = new URL(target);
    const embedUrl = (() => { try { return new URL(embedHref); } catch { return targetUrl; } })();
    const list = strategies(targetUrl, embedUrl);

    // Fast path: cached working strategy. Try alone with a 20s cap.
    // The previous 8s cap matched median segment latency on slow CDN
    // edges (MENA → EU), so legitimate fetches were being killed and
    // flushing the strategy cache — forcing a full 4-way race on the
    // next call and triggering CDN rate limits.
    const cached = hostStrategyCache.get(targetUrl.host);
    if (cached) {
      const cachedStrat = list.find((s) => s.name === cached);
      if (cachedStrat) {
        const ctrl = new AbortController();
        const onOuter = () => ctrl.abort();
        if (signal) signal.addEventListener("abort", onOuter, { once: true });
        const watchdog = setTimeout(() => ctrl.abort(), 20000);
        try {
          const r = await fetchWithStrategy(target, cachedStrat, range, method, ctrl.signal);
          clearTimeout(watchdog);
          if (signal) signal.removeEventListener("abort", onOuter);
          return r;
        } catch {
          clearTimeout(watchdog);
          if (signal) signal.removeEventListener("abort", onOuter);
          // Cached strategy stopped working — drop and race below.
          hostStrategyCache.delete(targetUrl.host);
        }
      }
    }

    // Race all strategies in parallel. First 2xx wins; only the LOSERS
    // get their controllers aborted (the winner's controller must stay
    // alive so upstream.text()/arrayBuffer() can still drain the body).
    const stratStates = list.map((strat) => {
      const ctrl = new AbortController();
      if (signal) signal.addEventListener("abort", () => { try { ctrl.abort(); } catch {} }, { once: true });
      const watchdog = setTimeout(() => { try { ctrl.abort(); } catch {} }, 15000);
      return { strat, ctrl, watchdog };
    });

    // Wrap each fetch so the resolved value carries its strategy index,
    // and reject silently so unhandled-rejection warnings don't leak.
    const tasks = stratStates.map((s, i) =>
      fetchWithStrategy(target, s.strat, range, method, s.ctrl.signal)
        .then((r) => ({ ...r, _index: i })),
    );
    // Make sure loser rejections don't bubble out as unhandled.
    tasks.forEach((t) => { t.catch(() => {}); });

    try {
      const winner = await Promise.any(tasks);
      hostStrategyCache.set(targetUrl.host, winner.strategy);
      stratStates.forEach((s, i) => {
        if (i !== winner._index) try { s.ctrl.abort(); } catch {}
        clearTimeout(s.watchdog);
      });
      return { upstream: winner.upstream, strategy: winner.strategy };
    } catch (e: any) {
      stratStates.forEach((s) => clearTimeout(s.watchdog));
      const errors: unknown[] = (e?.errors as unknown[]) || [e];
      const statusCodes: number[] = [];
      for (let i = 0; i < errors.length; i++) {
        const err = errors[i] as any;
        const msg = err?.message || err?.code || err?.name || String(err);
        // strategy errors look like "canonical → 403"; extract the number.
        const sm = String(msg).match(/→\s*(\d{3})/);
        if (sm) statusCodes.push(parseInt(sm[1], 10));
        console.warn(`[pantoufa-video] ${list[i]?.name || "?"}: ${msg}`);
      }
      const wrap = new Error(
        `all strategies failed for ${target}` +
          (statusCodes.length ? ` (statuses: ${statusCodes.join(",")})` : ""),
      );
      (wrap as any).cause = e;
      (wrap as any).statusCodes = statusCodes;
      throw wrap;
    }
  }

  protocol.handle(VIDEO_PROTOCOL, async (request) => {
    let target = "";
    let referer = "";
    try {
      const reqUrl = new URL(request.url);

      // Path segments: "" / "<pct-origin>" / "cdn" / "path"...
      // (hostname "x" is not in the path)
      const pathParts = reqUrl.pathname.split("/").filter(Boolean);

      // ── v2 format: /<pct-encoded-origin>/<cdn-path>?__pantoufa_ref=<pct-encoded-embed> ──
      // Detect by first segment containing %3A%2F%2F (percent-encoded ://)
      const originEnc = pathParts.length >= 1 && /%3A%2F%2F/i.test(pathParts[0]) ? pathParts[0] : "";
      let origin = "";
      if (originEnc) {
        try { origin = decodeURIComponent(originEnc); } catch { origin = ""; }
      }
      if (origin && /^https?:\/\//i.test(origin)) {
        const cdnPath = "/" + pathParts.slice(1).join("/");
        const cdnParams = new URLSearchParams(reqUrl.search);
        cdnParams.delete(REF_PARAM);
        const cdnQs = cdnParams.toString();
        target = origin + cdnPath + (cdnQs ? "?" + cdnQs : "");
      } else {
        // ── v1 backwards-compat: /x/?u=<encoded>&ref=<encoded> ──
        target = reqUrl.searchParams.get("u") || "";
      }

      // URLSearchParams.get already URL-decodes — no second decode needed.
      const refFromQs = reqUrl.searchParams.get(REF_PARAM);
      if (refFromQs) referer = refFromQs;
      if (!referer) referer = reqUrl.searchParams.get("ref") || target;

      if (!target) {
        console.warn("[pantoufa-video] bad/missing target", {
          url: request.url,
          pathname: reqUrl.pathname,
          parts: pathParts,
          originEnc,
          origin,
          refParam: refFromQs ? "present" : "missing",
        });
        return new Response("missing url", { status: 400 });
      }

      // Short-circuit OPTIONS preflights — no upstream call needed.
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
            "Access-Control-Allow-Headers": "*",
            "Access-Control-Max-Age": "86400",
          },
        });
      }

      // Chunk open-ended Range requests so we never wait on a 100+MB
      // download before responding. For mp4 sources the browser sends
      // `Range: bytes=0-` which used to suck the whole file into RAM,
      // causing the renderer to time out → black screen. For HLS .ts /
      // .m4s segments we use a larger cap; for direct .mp4 playback we
      // use a small first-chunk so the moov atom + first frames arrive
      // fast and the user sees the picture quickly.
      const isMp4 = /\.mp4(\?|$)/i.test(target);
      const isHlsSegment = /\.(m4s|ts)(\?|$)/i.test(target);
      const isManifest = /\.(m3u8|mpd)(\?|$)/i.test(target);
      // Extension-less CDN media (ok.ru/mycdn.me progressive mp4, doodstream
      // tokens, vk) must ALSO be chunked — without this the proxy buffers the
      // entire 100MB+ file via arrayBuffer() before returning a byte, which
      // trips the watchdogs and ends in a black player. Manifests (which may
      // also lack an extension, e.g. ok.ru hlsManifestUrl) are tiny and get
      // detected by content-type below, so chunking them is harmless.
      const lastSeg = target.split("?")[0].split("#")[0].split("/").pop() || "";
      const hasExtension = /\.[a-z0-9]{2,5}$/i.test(lastSeg);
      const isLargeMedia = isMp4 || isHlsSegment || (!isManifest && !hasExtension);
      const CHUNK_SIZE = isMp4 ? 1 * 1024 * 1024 : 4 * 1024 * 1024;
      let range = request.headers.get("range");
      if (isLargeMedia) {
        if (!range) {
          range = `bytes=0-${CHUNK_SIZE - 1}`;
        } else {
          // bytes=START- (open-ended) → bytes=START-(START+CHUNK-1)
          const m = range.match(/^bytes=(\d+)-(\d*)$/);
          if (m) {
            const start = parseInt(m[1], 10);
            const end = m[2] ? parseInt(m[2], 10) : NaN;
            if (!isFinite(end) || end - start > CHUNK_SIZE - 1) {
              range = `bytes=${start}-${start + CHUNK_SIZE - 1}`;
            }
          }
        }
      }

      let { upstream, strategy } = await tryFetch(target, referer, range, request.method, request.signal);

      // mp4upload CDN sometimes only accepts Range requests — if the
      // initial GET fails without Range, retry with bytes=0-.
      if (!upstream.ok && !range && /mp4upload/.test(target)) {
        console.info("[pantoufa-video] initial GET failed, retrying with bytes=0-");
        try {
          const r = await tryFetch(target, referer, "bytes=0-", request.method, request.signal);
          if (r.upstream.ok) { upstream = r.upstream; strategy = r.strategy; }
        } catch { /* keep original error */ }
      }

      const ct = (upstream.headers.get("content-type") || "").toLowerCase();
      const isHls = ct.includes("mpegurl") || /\.m3u8(\?|$)/i.test(target);

      if (isHls) {
        const text = await upstream.text();
        const rewritten = rewriteM3U8(text, target, referer);
        const entries = rewritten.split("\n").filter(l => l.startsWith(VIDEO_PROTOCOL)).length;
        console.info(`[pantoufa-video] m3u8 ${upstream.status} (${strategy}, rewrote ${entries}) ${target}`);
        return new Response(rewritten, {
          status: upstream.status,
          headers: {
            "Content-Type": "application/vnd.apple.mpegurl",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store",
            "Vary": "Origin",
          },
        });
      }

      // NOTE: I tried streaming upstream.body straight through but Electron
      // 33's protocol.handle doesn't reliably pipe Session.fetch ReadableStreams
      // for large bodies — mp4upload + videa came back broken. Buffering via
      // arrayBuffer is slower at first byte but actually plays. Acceptable
      // tradeoff for now; revisit if the streaming bug is fixed upstream.
      let buf = await upstream.arrayBuffer();

      const outHeaders = new Headers();
      const passthrough = ["content-type", "content-range", "etag", "last-modified"];
      for (const k of passthrough) {
        const v = upstream.headers.get(k);
        if (v) outHeaders.set(k, v);
      }
      outHeaders.set("accept-ranges", "bytes");

      // If we chunked the upstream request but it answered 200 with the
      // full body (server ignored Range), slice the buffer to the
      // requested window AND synthesize a truthful Content-Range. The
      // old code reported the full-body length as "partial" — the
      // browser then expected CHUNK_SIZE bytes but received e.g. 200MB,
      // OOMing the main process. Slice first, report second.
      let outStatus = upstream.status;
      if (isLargeMedia && range && upstream.status === 200) {
        const m = range.match(/^bytes=(\d+)-(\d+)$/);
        if (m) {
          const start = parseInt(m[1], 10);
          const end = parseInt(m[2], 10);
          if (buf.byteLength > end - start + 1) {
            const sliced = buf.slice(start, end + 1);
            const total = buf.byteLength;
            buf = sliced;
            outHeaders.set("content-range", `bytes ${start}-${start + buf.byteLength - 1}/${total}`);
            outStatus = 206;
          }
        }
      }
      outHeaders.set("content-length", String(buf.byteLength));

      // MIME fixups.
      const outCt = (outHeaders.get("content-type") || "").toLowerCase();
      if (/\.mp4(\?|$)/i.test(target) && (!outCt || outCt === "application/octet-stream")) {
        outHeaders.set("content-type", "video/mp4");
      }
      if (/\.ts(\?|$)/i.test(target) && (!outCt || outCt.startsWith("text/") || outCt === "application/octet-stream")) {
        outHeaders.set("content-type", "video/mp2t");
      }
      if (/\.m4s(\?|$)/i.test(target) && (!outCt || outCt === "application/octet-stream")) {
        outHeaders.set("content-type", "video/iso.segment");
      }
      // Extension-less progressive media (dood tokens, vk, ok.ru mp4) often
      // comes back as octet-stream, which the <video> element refuses to
      // decode. Manifests never reach here (handled in the isHls branch), so
      // defaulting to video/mp4 is safe.
      if (!hasExtension && (!outCt || outCt === "application/octet-stream")) {
        outHeaders.set("content-type", "video/mp4");
      }

      outHeaders.set("Access-Control-Allow-Origin", "*");
      outHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      outHeaders.set("Access-Control-Allow-Headers", "*");
      outHeaders.set("Access-Control-Expose-Headers", "*");

      console.info(`[pantoufa-video] ${outStatus} ${outHeaders.get("content-type") || "?"} ${buf.byteLength}B (${strategy}) ${target}${range ? " " + range : ""}`);

      return new Response(buf, { status: outStatus, headers: outHeaders });
    } catch (e: any) {
      const msg = e?.message || String(e);
      // If every strategy returned 401/403/410, the URL's signed token is
      // dead — likely the page was idle long enough for it to expire. Tell
      // the renderer with a recognizable status so it can re-extract.
      // tryFetch attaches `statusCodes` to the wrapping error when all
      // strategies fail with HTTP responses (not network timeouts).
      const statusCodes: number[] = Array.isArray(e?.statusCodes) ? e.statusCodes : [];
      const expired =
        statusCodes.length > 0 &&
        statusCodes.every((s) => s === 401 || s === 403 || s === 410);
      if (expired) {
        console.warn(
          `[pantoufa-video] URL EXPIRED (${statusCodes.join(",")}) for ${target}`,
        );
        return new Response("url expired", {
          status: 410,
          headers: { "X-Pantoufa-Reextract": "1", "Access-Control-Allow-Origin": "*" },
        });
      }
      console.warn(`[pantoufa-video] FINAL ERR ${e?.code || e?.name || ""} ${msg} for ${target}`);
      return new Response("proxy error", {
        status: 502,
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }
  });
}

app.whenReady().then(() => {
  const coldStartUrl = process.argv.find((a) => a.startsWith(`${PROTOCOL}://`));
  if (coldStartUrl) handleAuthCallbackUrl(coldStartUrl);

  // Relax response headers on the renderer for images / iframes.
  // Also fix Supabase auth CORS — in dev mode (localhost:5173) the
  // origin doesn't match the Supabase dashboard's allowed list.
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    const headers: Record<string, any> = { ...details.responseHeaders };
    for (const k of Object.keys(headers)) {
      const lower = k.toLowerCase();
      if (
        lower === "content-security-policy" ||
        lower === "x-frame-options" ||
        lower === "frame-options" ||
        lower === "cross-origin-embedder-policy" ||
        lower === "cross-origin-opener-policy"
      ) {
        delete headers[k];
      }
    }
    // Inject permissive CORS for video CDN hosts so the proxy's
    // credentials:"include" fetches don't hit Chromium's
    // net::ERR_FAILED when the CDN doesn't return
    // Access-Control-Allow-Credentials (streamwish CDNs like
    // premilkyway.com, cybervynx.com etc. never do). Scope to
    // video CDN hosts only — universal injection breaks Google
    // Fonts, analytics, and other third-party assets.
    const host = (() => { try { return new URL(details.url).hostname.toLowerCase(); } catch { return ""; } })();
    const isVideoCdn = /streamwish|hgcloud|wishfast|wishembed|jwembed|hlswish|vibuxer|audinifer|masukestin|hanerix|mp4upload|voe|dood|uqload|share4max|megamax|dailymotion|dmcdn/.test(host);
    const isSupabase = host.includes("supabase.co");
    if (isVideoCdn || isSupabase) {
      const origin = (() => {
        try { return new URL(details.referrer || "").origin; } catch { return "*"; }
      })();
      headers["access-control-allow-origin"] = [origin];
      headers["access-control-allow-credentials"] = ["true"];
    }
    cb({ responseHeaders: headers });
  });

  // Capture video URLs the renderer's iframe-embed fetches. The
  // renderer subscribes via IPC and uses the captured URL to swap
  // playback into its own custom <video> element while still gaining
  // the reliability of the provider's real player initializing
  // everything (CF, autoplay, tokens). The renderer is responsible
  // for ignoring captures that don't belong to its current viewing
  // state — we just emit everything that looks like a real stream
  // from a known CDN host.
  function isDecoyStream(u: string) {
    return /test-videos\.co\.uk|bigbuckbunny|sample[-_.]|placeholder|tos\.mp4|googleapis\.com\/.*oggtheora|\/lol\/file\.mp4/i.test(u);
  }
  function isKnownVideoCdn(host: string): boolean {
    const h = host.toLowerCase();
    // Reject known ad / tracking / decoy hosts. Accept everything else
    // so yonaplay and any future provider work automatically without
    // needing manual additions to every regex list in the codebase.
    // AD_HOST_RE already cancels ad-network requests before they reach
    // this check, and the renderer gates captures by captureForEmbed.
    if (AD_HOST_RE.test(h)) return false;
    if (/test-videos\.co\.uk|bigbuckbunny|sample[-_.]|placeholder/.test(h)) return false;
    return h.includes(".") && !/^\d+\.\d+/.test(h);
  }
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    try {
      const u = details.url;
      // Skip if this URL is being fetched BY the proxy itself — the
      // proxy operates on defaultSession too, and without this check
      // its own outbound fetches would loop back as new captures.
      if (inFlightProxyTargets.has(u)) return callback({});
      // CRITICAL: match AD_HOST_RE against the HOSTNAME only, not the
      // full URL. The regex contains substrings like "mgid", "popunder",
      // "adcash", "tsyndicate" — testing against a full URL means any
      // CDN path or query token that happens to contain one of those
      // substrings gets cancelled, breaking the embed silently (iframe
      // loads but its player JS / token request returns blocked, page
      // renders black). Hostname-only avoids the false positives.
      const host = (() => { try { return new URL(u).hostname.toLowerCase(); } catch { return ""; } })();
      if (host && AD_HOST_RE.test(host)) {
        console.info(`[ad-block] cancelled request to ${host}`);
        return callback({ cancel: true });
      }
      // Block well-known ad script filenames / paths that escape the
      // hostname-based AD_HOST_RE (e.g. a CDN mirror hosting both the
      // video player and ad scripts on the same domain).
      if (/[\/.](?:popunder|popads|popmyads|adscripts?|advertisement|bannerads?|overlay|interstitial|prebid|vast|vpaid|adserver|admob|adx|ad[sv]?\d*)\.(?:js|php|html?)/i.test(u)) {
        console.info(`[ad-block] cancelled ad script ${u.split("/").pop()}`);
        return callback({ cancel: true });
      }
      if (/\.(m3u8|mp4)(\?|#|$)/i.test(u) && !isDecoyStream(u)) {
        if (host && isKnownVideoCdn(host)) {
          mainWindow?.webContents.send("pantoufa:video-captured", { url: u });
        }
      }
    } catch {}
    callback({});
  });

  // The provider's embed iframe makes its own fetches to its CDN for
  // playlists and segments. Some CDNs (mp4upload, streamwish family)
  // whitelist a specific canonical Referer that doesn't always match
  // what the embed page's natural URL would produce. Force the right
  // one so playback inside the iframe is reliable.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    {
      // Catch-all — streamwish rotates CDN mirrors (cybervynx.com,
      // ghbrisk.com, etc.) that aren't in any static list. By matching
      // EVERY request and routing headers based on hostname inside the
      // callback, new mirrors get the correct Referer automatically.
      urls: ["*://*/*"],
    },
    (details, callback) => {
      // Only inject Referer for sub-resource requests (xhr, fetch, script,
      // media). Never touch mainFrame/subFrame navigations — the iframe
      // needs to load the embed page with its native Referer chain.
      const rt = (details as any).resourceType;
      // Our own app frame — never touch.
      if (rt === "mainFrame") {
        callback({ requestHeaders: details.requestHeaders });
        return;
      }
      // Embed iframe navigation (mp4upload, ok.ru, voe, dood, uqload, …). In a
      // packaged build the parent app origin is file://, so Chromium sends no
      // Referer here and the provider renders a BLACK player. Force the
      // provider's canonical domain as the frame Referer so the embed plays.
      // We strip any pre-existing file://-/localhost-derived Referer/Origin
      // first so the forged value is the one the provider sees.
      if (rt === "subFrame") {
        try {
          const fhost = new URL(details.url).hostname.toLowerCase();
          const pr = providerRefererForHost(fhost);
          if (pr) {
            const fhdrs = details.requestHeaders;
            for (const k of Object.keys(fhdrs)) {
              const lk = k.toLowerCase();
              if (lk === "referer" || lk === "origin") delete fhdrs[k];
            }
            fhdrs["Referer"] = pr.referer;
            callback({ requestHeaders: fhdrs });
            return;
          }
        } catch {}
        callback({ requestHeaders: details.requestHeaders });
        return;
      }
      const hdrs = details.requestHeaders;
      const proxyMarker = Object.keys(hdrs).find((k) => k.toLowerCase() === "x-pantoufa-proxy");
      if (proxyMarker) {
        delete hdrs[proxyMarker];
        callback({ requestHeaders: hdrs });
        return;
      }
      try {
        const host = new URL(details.url).hostname.toLowerCase();
        const hasReferer = Object.keys(hdrs).some(
          (k) => k.toLowerCase() === "referer",
        );
        let ref = "";
        let ori = "";
        // `force` = override the Referer even if the request already carries
        // one. The mp4upload direct-play path loads the raw .mp4 in a native
        // <video> (NOT through the proxy or an iframe), so the request inherits
        // the app's own file://-/localhost Referer — which mp4upload's CDN
        // rejects with 403, leaving a black player. Only-when-missing injection
        // silently kept that wrong Referer. Every OTHER provider's requests
        // originate inside their embed iframe (correct natural Referer) or go
        // through the proxy, so we leave those only-when-missing to avoid
        // clobbering a working full-path embed Referer.
        let force = false;
        if (/mp4upload/.test(host)) {
          ref = "https://www.mp4upload.com/";
          ori = "https://www.mp4upload.com";
          force = true;
        } else if (/streamwish|hgcloud|wishfast|wishembed|jwembed|hlswish|vibuxer|audinifer|masukestin|hanerix/.test(host)) {
          ref = "https://streamwish.to/";
          ori = "https://streamwish.to";
        } else if (/voe\./.test(host)) {
          ref = "https://voe.sx/";
          ori = "https://voe.sx";
        } else if (/dood/.test(host)) {
          ref = "https://dood.li/";
          ori = "https://dood.li";
        } else if (/uqload/.test(host)) {
          ref = "https://uqload.io/";
          ori = "https://uqload.io";
        } else if (/share4max|megamax/.test(host)) {
          ref = "https://share4max.com/";
          ori = "https://share4max.com";
        } else if (/videa|vidvaita|vidit/.test(host)) {
          ref = "https://videa.hu/";
          ori = "https://videa.hu";
        } else if (/dailymotion|dmcdn/.test(host)) {
          ref = "https://www.dailymotion.com/";
          ori = "https://www.dailymotion.com";
        } else if (/ok\.ru|odnoklassniki|mycdn\.me/.test(host)) {
          // ok.ru streams its video from *.mycdn.me, which expects the
          // ok.ru embed Referer — not its own CDN domain.
          ref = "https://ok.ru/";
          ori = "https://ok.ru";
        } else if (!AD_HOST_RE.test(host) && host.includes(".") && !/^\d+\.\d+/.test(host)) {
          // Sub-resource on a CDN host that doesn't match any provider regex
          // (e.g. a rotating streamwish/voe mirror, or ok.ru's mycdn.me). Use
          // the EMBED FRAME's origin to pick the canonical Referer the CDN
          // expects, so token/segment requests aren't rejected (the classic
          // "loads then goes black" symptom on rotating mirrors).
          let frameOrigin = "";
          try { frameOrigin = ((details as any).frame?.origin || "").toLowerCase(); } catch {}
          let frameHost = "";
          try { frameHost = new URL(frameOrigin).hostname.toLowerCase(); } catch {}
          const fromFrame = frameHost ? providerRefererForHost(frameHost) : null;
          if (fromFrame) {
            ref = fromFrame.referer;
            ori = fromFrame.origin;
          } else {
            // Generic fallback: root-domain Referer for any non-ad host.
            const root = host.split(".").slice(-2).join(".");
            ref = `https://${root}/`;
            ori = `https://${root}`;
          }
        }
        if (ref && (force || !hasReferer)) {
          if (force) {
            // Drop any inherited Referer/Origin (any casing) first so we don't
            // emit a duplicate header — Chromium may have set "Referer" while
            // we'd add "referer", and the CDN could read the wrong one.
            for (const k of Object.keys(hdrs)) {
              const lk = k.toLowerCase();
              if (lk === "referer" || lk === "origin") delete hdrs[k];
            }
          }
          hdrs["Referer"] = ref;
          hdrs["Origin"] = ori;
        }
      } catch {}
      callback({ requestHeaders: hdrs });
    },
  );

  registerVideoProxy();

  ipcMain.handle("pantoufa:scrape", async (_evt, job: ScrapeJob) => {
    try {
      return await enqueue(job);
    } catch (e: any) {
      // Silently handle scraper timeouts (blocked sites, network issues).
      // The renderer already has .catch(() => null) on every scrape call;
      // we just prevent Electron from logging a noisy "Error occurred in
      // handler" every time an ISP blocks anime4up or a CDN mirror.
      return null;
    }
  });

  // Mute / unmute the main window's audio. The renderer calls this
  // while the hidden iframe is bootstrapping a provider's player so the
  // user doesn't hear ad audio during the brief URL-capture window. The
  // iframe still plays (capturing requires audio context) — we just
  // silence the speaker for the few seconds it takes to extract.
  ipcMain.handle("pantoufa:set-muted", async (_evt, muted: boolean) => {
    try {
      mainWindow?.webContents.setAudioMuted(!!muted);
      return true;
    } catch {
      return false;
    }
  });

  // Direct provider extractors. Skip the iframe + capture cycle for
  // providers that expose a public manifest API — we hit the endpoint
  // from the main process and hand the resulting URL straight to the
  // custom player. No ads ever load, no token race.
  ipcMain.handle("pantoufa:direct-extract", async (
    _evt,
    opts: { provider: string; iframeUrl: string },
  ): Promise<{ url: string; type: "hls" | "mp4" } | null> => {
    try {
      if (opts.provider === "dailymotion") {
        return await extractDailymotion(opts.iframeUrl);
      }
      if (opts.provider === "videa") {
        return await extractVidea(opts.iframeUrl);
      }
      if (opts.provider === "streamwish") {
        return await extractStreamwish(opts.iframeUrl);
      }
      if (opts.provider === "mp4upload") {
        return await extractMp4upload(opts.iframeUrl);
      }
      if (opts.provider === "okru") {
        return await extractOkru(opts.iframeUrl);
      }
      if (opts.provider === "doodstream") {
        return await extractDood(opts.iframeUrl);
      }
      if (opts.provider === "vk") {
        return await extractVk(opts.iframeUrl);
      }
      if (opts.provider === "vid3rb") {
        return await extractVid3rb(opts.iframeUrl);
      }
      // Providers whose player requests a real .m3u8/.mp4 URL. Try the cheap
      // static-HTML pass first (most of these inline the source in packed JS,
      // so it resolves in <1s); the generic headless capture engine is the
      // fallback. Renderer falls back to the iframe on null.
      if (
        opts.provider === "voe" ||
        opts.provider === "share4max" ||
        opts.provider === "streamruby" ||
        opts.provider === "uqload"
      ) {
        const viaHtml = await extractViaHtml(opts.iframeUrl, `extract:${opts.provider}`);
        if (viaHtml) return viaHtml;
        // voe/share4max sometimes sit behind Cloudflare → allow extra time.
        const timeout = opts.provider === "uqload" ? 25000 : 32000;
        return await extractViaCapture(opts.iframeUrl, `extract:${opts.provider}`, timeout);
      }
    } catch (e) {
      console.warn("[direct-extract] failed:", e);
    }
    return null;
  });

  ipcMain.handle("pantoufa:open-external", async (_evt, url: string) => {
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) return false;
    await shell.openExternal(url);
    return true;
  });

  // Privileged HTML fetch from the main process (no CORS, any port). Used to
  // read anime4up episode pages directly: their server list lives in the
  // static HTML (<li data-watch>), so a plain GET is far faster and more
  // reliable than rendering the page in a headless window (which trips
  // anime4up's ad redirects / JS gates). Returns the body text, or null.
  //
  // anime4up is intermittently flaky: a single GET routinely hits a timeout,
  // a 429 rate-limit (the resolve chain fires several GETs in a burst), a 503,
  // or a transient Cloudflare hiccup. The anime4up→servers chain is THREE such
  // GETs back-to-back (search → episode list → server list), so any one of
  // them returning null used to collapse the whole chain and leave the user
  // waiting on the renderer's slow (1.5s–15s) backoff loops — that's the
  // "servers take forever / sometimes never show" symptom. Retry each GET a few
  // times with a short per-attempt timeout and a small growing backoff so a
  // transient miss self-heals in well under a second instead of bubbling up.
  ipcMain.handle("pantoufa:fetch-html", async (
    _evt,
    opts: { url: string; referer?: string; attempts?: number; timeoutMs?: number },
  ): Promise<string | null> => {
    // anime3rb's edge does NOT 404 unknown paths — it TARPITS them (the
    // connection hangs until our timeout), and a burst of stalled probes gets
    // the whole site blackholed for a while. Callers probing such hosts pass
    // attempts/timeoutMs overrides so a miss costs seconds, not half a minute.
    const ATTEMPTS = Math.max(1, Math.min(opts.attempts ?? 3, 5));
    const PER_ATTEMPT_TIMEOUT_MS = Math.max(1000, Math.min(opts.timeoutMs ?? 9000, 30000));
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), PER_ATTEMPT_TIMEOUT_MS);
      try {
        const res = await fetch(opts.url, {
          signal: controller.signal,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "ar,en;q=0.9",
            ...(opts.referer ? { Referer: opts.referer } : {}),
          },
        });
        clearTimeout(t);
        if (res.ok) return await res.text();
        // Retry the transient/edge statuses (rate-limit, Cloudflare, 5xx);
        // a hard 4xx (404/410) won't change on retry, so bail immediately.
        const retryable = res.status === 429 || res.status === 403 || res.status >= 500;
        if (!retryable || attempt === ATTEMPTS) return null;
      } catch {
        clearTimeout(t);
        if (attempt === ATTEMPTS) return null;
      }
      // Growing backoff between attempts (0.6s, 1.2s) — long enough to ride out
      // a rate-limit burst, short enough that recovery stays near-instant.
      await new Promise((r) => setTimeout(r, 600 * attempt));
    }
    return null;
  });

  // Kept for backwards compatibility; no-op now that we proxy.
  ipcMain.handle("pantoufa:set-video-referer", () => true);

  // Track which iframe the renderer is currently watching so did-fail-load
  // can ignore sub-resource failures (ad iframes inside embed pages) and
  // only fast-advance when the actual embed iframe fails.
  ipcMain.handle("pantoufa:set-active-iframe", (_evt, url: string | null) => {
    activeIframeUrl = url;
  });

  ipcMain.handle("pantoufa:install-update", () => {
    try { autoUpdater.quitAndInstall(); return true; } catch { return false; }
  });

  createMainWindow();

  // Auto-updater: check GitHub releases on launch + every hour. Notifies the
  // renderer when an update is available (so we can show our own popup) and
  // when it's downloaded and ready to install.
  if (!isDev) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on("update-available", (info) => {
      mainWindow?.webContents.send("pantoufa:update-available", {
        version: info.version,
        releaseNotes: typeof info.releaseNotes === "string" ? info.releaseNotes : "",
      });
    });
    autoUpdater.on("update-downloaded", (info) => {
      mainWindow?.webContents.send("pantoufa:update-downloaded", {
        version: info.version,
        releaseNotes: typeof info.releaseNotes === "string" ? info.releaseNotes : "",
      });
    });
    autoUpdater.on("error", (err) => {
      console.warn("[updater] error:", err?.message || err);
    });
    setTimeout(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 5000);
    updateCheckInterval = setInterval(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 60 * 60 * 1000);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

}

app.on("window-all-closed", () => {
  if (updateCheckInterval) { clearInterval(updateCheckInterval); updateCheckInterval = null; }
  if (process.platform !== "darwin") {
    if (isDev) {
      // Dev mode: exit immediately so concurrently -k detects it
      // and kills the Vite dev server. app.exit() skips the event
      // loop, terminates all child processes instantly.
      app.exit(0);
    } else {
      // Production: normal quit so autoInstaller can apply updates.
      app.quit();
    }
  }
});
