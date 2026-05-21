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

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) {
      void shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
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

function registerVideoProxy() {
  const scraperSession = session.fromPartition("persist:scraper");

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
    if (/mp4upload/.test(host)) {
      return { referer: "https://www.mp4upload.com/", origin: "https://www.mp4upload.com" };
    }
    if (/streamwish|hgcloud|wishfast|wishembed|jwembed|hlswish/.test(host)) {
      // streamwish family: strip subdomain to root (vibuxer.com, hgcloud.cc, etc.)
      const root = host.split(".").slice(-2).join(".");
      return { referer: `https://${root}/`, origin: `https://${root}` };
    }
    if (/voe\./.test(host)) {
      return { referer: "https://voe.sx/", origin: "https://voe.sx" };
    }
    if (/doodstream|dood\./.test(host)) {
      return { referer: "https://dood.li/", origin: "https://dood.li" };
    }
    if (/uqload/.test(host)) {
      return { referer: "https://uqload.io/", origin: "https://uqload.io" };
    }
    if (/share4max|megamax/.test(host)) {
      return { referer: "https://share4max.com/", origin: "https://share4max.com" };
    }
    // Default: use the embed page's origin.
    try {
      const embedOrigin = `${embedUrl.protocol}//${embedUrl.host}`;
      return { referer: embedOrigin + "/", origin: embedOrigin };
    } catch {
      const root = host.split(".").slice(-2).join(".");
      return { referer: `https://${root}/`, origin: `https://${root}` };
    }
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

    // mp4upload CDN only accepts self-referencing; canonical www.mp4upload.com
    // and embed-page origins are rejected. Skip the slow race and lead with
    // target-self, then try embed + no-referer as fallbacks.
    if (/mp4upload/.test(target.hostname)) {
      return [
        { name: "target-self", headers: targetHeaders },
        { name: "embed", headers: embedHeaders },
        { name: "no-referer", headers: noRefererHeaders },
        { name: "canonical", headers: canonicalHeaders },
      ];
    }

    // streamwish family: CDN host (vibuxer.com, audinifer.com) expects the
    // embed-page Referer (hgcloud.to, streamwish.to) not its own domain.
    if (/streamwish|hgcloud|wishfast|wishembed|jwembed|hlswish|vibuxer|audinifer|masukestin/.test(target.hostname)) {
      return [
        { name: "embed", headers: embedHeaders },
        { name: "target-self", headers: targetHeaders },
        { name: "canonical", headers: canonicalHeaders },
        { name: "no-referer", headers: noRefererHeaders },
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
    const baseHeaders: Record<string, string> = {
      "User-Agent": VIDEO_UA,
      "Accept": "*/*",
      "Accept-Encoding": "identity",
    };
    if (range) baseHeaders["Range"] = range;
    const upstream = await scraperSession.fetch(target, {
      method,
      headers: { ...baseHeaders, ...strat.headers() },
      redirect: "follow",
      credentials: "include",
      bypassCustomProtocolHandlers: true,
      signal,
    });
    if (!upstream.ok) throw new Error(`${strat.name} → ${upstream.status}`);
    return { upstream, strategy: strat.name };
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

    // Fast path: cached working strategy. Try alone with 8s cap. If it
    // succeeds we save all the parallel overhead. If it aborts (timeout),
    // fall through to the parallel race which may have a working alt.
    const cached = hostStrategyCache.get(targetUrl.host);
    if (cached) {
      const cachedStrat = list.find((s) => s.name === cached);
      if (cachedStrat) {
        const ctrl = new AbortController();
        const onOuter = () => ctrl.abort();
        if (signal) signal.addEventListener("abort", onOuter, { once: true });
        const watchdog = setTimeout(() => ctrl.abort(), 8000);
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
      for (let i = 0; i < errors.length; i++) {
        const err = errors[i] as any;
        const msg = err?.message || err?.code || err?.name || String(err);
        console.warn(`[pantoufa-video] ${list[i]?.name || "?"}: ${msg}`);
      }
      const wrap = new Error(`all strategies failed for ${target}`);
      (wrap as any).cause = e;
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
      // causing the renderer to time out → black screen. We cap to a
      // 4 MB window per request; the browser will issue more Range
      // requests as it needs them.
      const CHUNK_SIZE = 4 * 1024 * 1024;
      const isLargeMedia = /\.(mp4|m4s|ts)(\?|$)/i.test(target);
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
          },
        });
      }

      // NOTE: I tried streaming upstream.body straight through but Electron
      // 33's protocol.handle doesn't reliably pipe Session.fetch ReadableStreams
      // for large bodies — mp4upload + videa came back broken. Buffering via
      // arrayBuffer is slower at first byte but actually plays. Acceptable
      // tradeoff for now; revisit if the streaming bug is fixed upstream.
      const buf = await upstream.arrayBuffer();

      const outHeaders = new Headers();
      const passthrough = ["content-type", "content-range", "etag", "last-modified"];
      for (const k of passthrough) {
        const v = upstream.headers.get(k);
        if (v) outHeaders.set(k, v);
      }
      outHeaders.set("content-length", String(buf.byteLength));
      outHeaders.set("accept-ranges", "bytes");

      // If we chunked the upstream request but it answered 200 with the
      // full body (server ignored Range), synthesize a Content-Range so
      // the browser still treats this as partial content and requests more.
      let outStatus = upstream.status;
      if (isLargeMedia && range && !outHeaders.get("content-range")) {
        const m = range.match(/^bytes=(\d+)-(\d+)$/);
        if (m) {
          const start = parseInt(m[1], 10);
          const total = parseInt(upstream.headers.get("content-length") || "0", 10) || (start + buf.byteLength);
          outHeaders.set("content-range", `bytes ${start}-${start + buf.byteLength - 1}/${total}`);
          outStatus = 206;
        }
      }

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
      const m = msg.match(/last status:\s*(\d+)/i);
      const lastStatus = m ? parseInt(m[1], 10) : 0;
      if (lastStatus === 401 || lastStatus === 403 || lastStatus === 410) {
        console.warn(`[pantoufa-video] URL EXPIRED (${lastStatus}) for ${target}`);
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
    cb({ responseHeaders: headers });
  });

  registerVideoProxy();

  ipcMain.handle("pantoufa:scrape", async (_evt, job: ScrapeJob) => {
    return enqueue(job);
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

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
