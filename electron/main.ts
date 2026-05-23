// Electron main process — owns the window + the scraper.
//
// Renderer (React) talks to us via IPC: `window.pantoufa.scrape(...)` is
// exposed in preload.ts, which forwards to the IPC handler here.

import { app, BrowserWindow, ipcMain, protocol, session, shell } from "electron";
import path from "node:path";
import { autoUpdater } from "electron-updater";
import { enqueue, type ScrapeJob } from "./scraper/host";

const isDev = !app.isPackaged;
const DEV_URL = "http://localhost:5173";
const PROTOCOL = "pantoufa";
const VIDEO_PROTOCOL = "pantoufa-video";
// Mobile UA for video CDNs — matches what the mobile app uses and what
// most providers expect from real users. mp4upload + streamwish refuse
// some desktop UAs.
const VIDEO_UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

let mainWindow: BrowserWindow | null = null;
let pendingAuthCallback: string | null = null;

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
const AD_HOST_RE = /doubleclick|googletagmanager|google-analytics|googleadservices|googlesyndication|adservice\.google|adnxs|facebook\.com\/tr|pixel\.facebook|popads|popcash|popmyads|popunder|propeller|propellerads|trafficjunky|adsterra|hilltopads|onclkds|onclickbid|onclickpredictiv|exoclick|magsrv|tsyndicate|clickadu|adcash|ad-maven|admaven|adsupply|servedbyadbutler|mgid|revcontent|adskeeper|trustedclicks|outbrain|taboola/i;

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

  // CDP-injected guard that runs inside every iframe document before page
  // scripts. Neutralizes window.open (click-jack) and hides Videa's pre-roll
  // ad containers — all invisible to the embed's sandbox-detection probes.
  // Streamwish actively checks frameElement?.sandbox and blocks playback if
  // set; CDP injection avoids that detection altogether.
  const IFRAME_AD_GUARD = `(function(){
if (window === window.top) return;
// Block <a target="_blank|_top|_parent"> clicks and form submissions.
// window.open nullification was removed — some players (streamwish)
// check its return value and abort if null. setWindowOpenHandler
// already denies all non-app popups globally.
document.addEventListener("click",function(e){
  var t=e.target;
  while(t && t.nodeType===1) {
    if (t.tagName==="A") {
      var tg=t.getAttribute("target");
      if (tg==="_blank"||tg==="_top"||tg==="_parent"){e.preventDefault();e.stopImmediatePropagation();return false;}
    }
    t=t.parentNode;
  }
},true);
// Intercept form submit with target that would open in a new context.
document.addEventListener("submit",function(e){
  var f=e.target;
  if (f&&f.nodeType===1&&f.tagName==="FORM"){
    var tg=f.getAttribute("target");
    if (tg&&tg!=="_self"){e.preventDefault();e.stopImmediatePropagation();return false;}
  }
},true);
if (/videa|vidvaita|vidit/.test(location.hostname)) {
  var s=document.createElement("style");
  s.textContent=".videa-ad,.ad-container,[class*='advert'],[id*='advert'],[class*='ad-overlay'],[class*='adoverlay'],[id*='ad-overlay'],.pre-roll,.preroll,[class*='pre-roll'],[class*='popunder'],[class*='popup-ad'],div[style*='position: absolute'][style*='z-index: 99']{display:none !important;pointer-events:none !important}";
  (document.head||document.documentElement).appendChild(s);
}
})();`;

  async function installIframeAdGuard(win: BrowserWindow) {
    try {
      if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach("1.3");
      await win.webContents.debugger.sendCommand("Page.enable");
      await win.webContents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
        source: IFRAME_AD_GUARD,
      });
    } catch (err) {
      console.warn("[ad-block] CDP guard install failed:", err);
    }
  }

  mainWindow.webContents.on("did-finish-load", () => {
    void installIframeAdGuard(mainWindow!);
  });

  mainWindow.webContents.on("did-finish-load", () => {
    if (pendingAuthCallback && mainWindow) {
      mainWindow.webContents.send("pantoufa:auth-callback", pendingAuthCallback);
      pendingAuthCallback = null;
    }
  });

  if (isDev) {
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
  function canonicalReferer(videoUrl: URL, _embedUrl: URL): { referer: string; origin: string } {
    const host = videoUrl.hostname.toLowerCase();
    if (/mp4upload/.test(host)) {
      return { referer: "https://www.mp4upload.com/", origin: "https://www.mp4upload.com" };
    }
    if (/streamwish|hgcloud|wishfast|wishembed|jwembed|hlswish|vibuxer|audinifer|masukestin|hanerix/.test(host)) {
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

    // mp4upload: only target-self Referer works. The other strategies
    // always fail and the parallel race just overloads the CDN, causing
    // it to throttle/reject all requests (including the winning one).
    // Use target-self exclusively with no race.
    if (/mp4upload/.test(target.hostname) || /mp4upload/.test(embed.hostname)) {
      return [
        { name: "canonical", headers: canonicalHeaders },
      ];
    }

    // streamwish family: CDN host (vibuxer.com, audinifer.com) expects the
    // embed-page Referer (hgcloud.to, streamwish.to) not its own domain.
    // Also check embed.hostname so rotating CDN mirrors (cybervynx.com,
    // ghbrisk.com) that don't match any static regex still get the single
    // canonical strategy instead of a 4-way parallel race that overloads
    // the CDN and triggers 403 rate-limiting.
    if (/streamwish|hgcloud|wishfast|wishembed|jwembed|hlswish|vibuxer|audinifer|masukestin|hanerix/.test(target.hostname)
        || /streamwish|hgcloud|wishfast|wishembed|jwembed|hlswish/.test(embed.hostname)) {
      return [
        { name: "canonical", headers: canonicalHeaders },
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
      const isLargeMedia = isMp4 || isHlsSegment;
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
    // Replace restrictive Supabase CORS with the requesting origin so
    // auth cookies + Authorization headers work from any origin (local
    // dev, packaged app, custom domains). Wildcard * breaks credentials.
    const urlStr = details.url || "";
    if (urlStr.includes("supabase.co")) {
      const origin = (() => {
        try { return new URL(details.referrer || "").origin; } catch { return "*"; }
      })();
      headers["access-control-allow-origin"] = [origin || "*"];
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
      if (AD_HOST_RE.test(u)) return callback({ cancel: true });
      if (/\.(m3u8|mp4)(\?|#|$)/i.test(u) && !isDecoyStream(u)) {
        const host = new URL(u).hostname;
        if (isKnownVideoCdn(host)) {
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
      const hdrs = details.requestHeaders;
      const proxyMarker = Object.keys(hdrs).find((k) => k.toLowerCase() === "x-pantoufa-proxy");
      if (proxyMarker) {
        delete hdrs[proxyMarker];
        callback({ requestHeaders: hdrs });
        return;
      }
      try {
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
        } else if (/videa|vidvaita|vidit/.test(host)) {
          ref = "https://videa.hu/";
          ori = "https://videa.hu";
        } else if (/dailymotion|dmcdn/.test(host)) {
          ref = "https://www.dailymotion.com/";
          ori = "https://www.dailymotion.com";
        } else if (!AD_HOST_RE.test(host) && host.includes(".") && !/^\d+\.\d+/.test(host)) {
          // Is this request originating from a streamwish embed iframe?
          // If so, inject the canonical streamwish.to Referer regardless
          // of the CDN mirror's actual hostname. This fixes black screens
          // when streamwish rotates to new CDN mirrors like cybervynx.com
          // or ghbrisk.com that aren't in any static regex.
          let frameOrigin = "";
          try { frameOrigin = ((details as any).frame?.origin || "").toLowerCase(); } catch {}
          if (/streamwish|hgcloud|wishfast|wishembed|jwembed|hlswish/.test(frameOrigin)) {
            ref = "https://streamwish.to/";
            ori = "https://streamwish.to";
          } else {
            // Generic fallback: root-domain Referer for any non-ad host.
            const root = host.split(".").slice(-2).join(".");
            ref = `https://${root}/`;
            ori = `https://${root}`;
          }
        }
        if (ref) {
          hdrs["Referer"] = ref;
          hdrs["Origin"] = ori;
        }
      } catch {}
      callback({ requestHeaders: hdrs });
    },
  );

  registerVideoProxy();

  ipcMain.handle("pantoufa:scrape", async (_evt, job: ScrapeJob) => {
    return enqueue(job);
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

  // Kept for backwards compatibility; no-op now that we proxy.
  ipcMain.handle("pantoufa:set-video-referer", () => true);

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
    setInterval(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 60 * 60 * 1000);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
