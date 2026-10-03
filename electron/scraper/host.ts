import { BrowserWindow } from "electron";

const SLOT_COUNT = 3;
// Rapid-navigation backlog guard (mobile bus.ts parity). Each detail/watch
// screen enqueues background scrape jobs; hopping through pages quickly piles
// up jobs for screens the user has already left, and because the slots are
// finite those dead jobs starve the CURRENT screen's scrape. When the
// non-priority backlog exceeds this, the OLDEST background job is dropped.
// Priority (user-initiated video) jobs are never dropped.
const MAX_BG_QUEUE = 12;

export type ScrapeJob = {
  url: string;
  injectBefore?: string;
  injectAfter: string;
  timeoutMs: number;
  isVideoJob?: boolean;
  // Jump the queue like isVideoJob does, WITHOUT the video-job navigation
  // semantics (video jobs allow cross-domain navigation and deny popups).
  // Used for the watch page's server-list scrape so it never waits behind
  // background home/listing scrapes.
  priority?: boolean;
  // Stop + blank the slot window after the job settles. For URL-resolution
  // jobs (witanime gate → provider embed) that land on a page which would
  // otherwise keep a player buffering in a hidden window.
  stopAfter?: boolean;
};

type Pending = {
  job: ScrapeJob;
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  cancelled?: boolean;
  settled?: boolean;
  // Fired the instant the job settles (fast-path intercept, cancellation or
  // normal completion) so runJob's pending executeJavaScript race can bail
  // out and free the slot immediately instead of waiting for the deadline.
  onSettle?: () => void;
};

type Slot = {
  win: BrowserWindow;
  busy: boolean;
  cdpScriptId: string | null;
};

const pendingQueue: Pending[] = [];
let slots: Slot[] | null = null;
let slotsReady: Promise<void> | null = null;

// isVideoJob callers keep the old jump-the-queue semantics; a background
// warm-up (extractViaCapture with background=true) opts out via priority:false.
const isPriority = (job: ScrapeJob): boolean =>
  job.priority === true || (job.isVideoJob === true && job.priority !== false);

export function enqueue(job: ScrapeJob): Promise<any> {
  return new Promise((resolve, reject) => {
    const entry: Pending = { job, resolve, reject };
    if (isPriority(job)) {
      // Place ahead of any non-priority jobs already queued.
      const at = pendingQueue.findIndex((p) => !isPriority(p.job));
      if (at === -1) pendingQueue.push(entry);
      else pendingQueue.splice(at, 0, entry);
    } else {
      pendingQueue.push(entry);
      // Shed the oldest background job(s) once the backlog is too deep, so a
      // flood of abandoned-screen scrapes can't block the current screen.
      let bg = pendingQueue.reduce((n, p) => n + (isPriority(p.job) ? 0 : 1), 0);
      while (bg > MAX_BG_QUEUE) {
        const oldIdx = pendingQueue.findIndex((p) => !isPriority(p.job));
        if (oldIdx === -1) break;
        const [dropped] = pendingQueue.splice(oldIdx, 1);
        dropped.reject(new Error("superseded: scrape queue overflow"));
        bg--;
      }
    }
    void drain();
  });
}

function claimNext(): Pending | null {
  let idx = pendingQueue.findIndex((p) => isPriority(p.job));
  if (idx === -1) idx = 0;
  return pendingQueue.splice(idx, 1)[0] ?? null;
}

function peekNext(): Pending | null {
  let idx = pendingQueue.findIndex((p) => isPriority(p.job));
  if (idx === -1) idx = 0;
  return pendingQueue[idx] ?? null;
}

function settleResolve(p: Pending, value: any) {
  if (p.settled) return;
  p.settled = true;
  try { p.onSettle?.(); } catch {}
  p.resolve(value);
}

function settleReject(p: Pending, err: Error) {
  if (p.settled) return;
  p.settled = true;
  try { p.onSettle?.(); } catch {}
  p.reject(err);
}

/** Drop work that was only warming/discovering servers. Priority jobs are
 *  explicit user selections and must survive. Returns how many were dropped. */
export function cancelBackgroundJobs(): number {
  const message = "cancelled: playback selected";
  let count = 0;
  for (let i = pendingQueue.length - 1; i >= 0; i--) {
    const p = pendingQueue[i];
    if (isPriority(p.job)) continue;
    pendingQueue.splice(i, 1);
    settleReject(p, new Error(message));
    count++;
  }
  for (let i = 0; i < pendingBySlot.length; i++) {
    const p = pendingBySlot[i];
    if (!p || p.settled || p.cancelled || isPriority(p.job)) continue;
    p.cancelled = true;
    // Kill the current document fast: the pending executeJavaScript rejects
    // with "context destroyed", and runJob's error path sees `cancelled`.
    const win = slots?.[i]?.win;
    if (win && !win.isDestroyed()) {
      try { win.webContents.stop(); } catch {}
      win.loadURL("about:blank").catch(() => {});
    }
    settleReject(p, new Error(message));
    count++;
  }
  return count;
}

function getBaseDomain(host: string): string {
  const parts = host.toLowerCase().split(".");
  return parts.length >= 2 ? parts.slice(-2).join(".") : host;
}

function isWhitelistedVideoDomain(host: string): boolean {
  const h = host.toLowerCase();
  return /streamwish|hgcloud|wishfast|wishembed|jwembed|hlswish|vibuxer|audinifer|masukestin|hanerix|mp4upload|voe|doodstream|dood|uqload|share4max|megamax|videa|vidvaita|vidit|okru|vk|dailymotion|dai\.ly/.test(h);
}

const isKnownAd = /popads|popcash|propeller|trafficjunky|medixiru|playnixes|doubleclick|advert|banners|tracker|adservice|adnxs|taboola|outbrain|exoclick|adx/i;

const activeJobs = new Map<number, { isVideoJob: boolean; resolve: (url: string) => void }>();
const slotWebContentsIds = new Set<number>();
const pendingBySlot: (Pending | null)[] = Array.from({ length: SLOT_COUNT }, () => null);
const beltScripts: (string | null)[] = Array.from({ length: SLOT_COUNT }, () => null);

/** m3u8 fast-path intercept, called by main.ts's defaultSession
 *  onBeforeRequest handler. The hidden slot windows run on defaultSession
 *  (persist:scraper can't reach provider CDNs), so their requests reach that
 *  handler — this is the only way to intercept them. Returns true when the
 *  request was handled (cancelled), false to let main.ts continue. */
export function tryFastPathRequest(
  details: { webContentsId?: number; url: string },
  callback: (response: { cancel?: boolean }) => void,
): boolean {
  const wcId = details.webContentsId;
  if (typeof wcId !== "number" || !slotWebContentsIds.has(wcId)) return false;

  // Kill loads to invalid hosts (witanime's loadIframe() decode can fail
  // and produce `https://undefined/...`, spamming ERR_NAME_NOT_RESOLVED).
  if (/^https?:\/\//i.test(details.url)) {
    try {
      const h = new URL(details.url).hostname.toLowerCase();
      if (!h || h === "undefined" || h === "null" || !h.includes(".")) {
        callback({ cancel: true });
        return true;
      }
    } catch {
      callback({ cancel: true });
      return true;
    }
  }

  const entry = activeJobs.get(wcId);
  if (entry?.isVideoJob && /\.m3u8(\?|$)/i.test(details.url)) {
    const decoy = /test-videos\.co\.uk|bigbuckbunny|sample[-_.]|placeholder/.test(details.url.toLowerCase());
    if (!decoy) {
      try {
        const host = new URL(details.url).hostname.toLowerCase();
        if (!/test-videos|bigbuckbunny|sample|placeholder|google|facebook|doubleclick|popads|propeller|trafficjunky|popcash|disqus|googletag|analytics|pyppo/.test(host)) {
          console.info(`[scraper] Fast-path intercept: ${details.url}`);
          entry.resolve(details.url);
          callback({ cancel: true });
          return true;
        }
      } catch {}
    }
  }
  return false;
}

function initSlots(): Slot[] {
  const result: Slot[] = [];
  for (let i = 0; i < SLOT_COUNT; i++) {
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      skipTaskbar: true,
      focusable: false,
      webPreferences: {
        offscreen: false,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
          // No partition → uses default session, same as the iframe.
        backgroundThrottling: false,
        webSecurity: true,
        autoplayPolicy: "no-user-gesture-required",
      },
    });
    slotWebContentsIds.add(win.webContents.id);

    // Never show this window — and never let it make a sound. Embed pages
    // autoplay ads with audio; the capture hook mutes <video> elements but
    // not <audio>/WebAudio, so hard-mute the whole webContents.
    try { win.webContents.setAudioMuted(true); } catch {}
    try { win.hide(); } catch {}
    try { win.setOpacity(0); } catch {}
    win.on("show", () => {
      try { win.hide(); } catch {}
      try { win.setOpacity(0); } catch {}
    });
    // Periodic sledgehammer — some embed pages (streamwish) call
    // win.focus() / win.moveTop() / requestFullscreen() which Electron
    // may honour despite show:false.
    const hideInterval = setInterval(() => {
      try { if (!win.isDestroyed()) win.hide(); } catch {}
    }, 1000);
    win.on("closed", () => clearInterval(hideInterval));

    try {
      if (!win.webContents.debugger.isAttached()) {
        win.webContents.debugger.attach("1.3");
      }
      win.webContents.debugger.sendCommand("Page.enable").catch(() => {});
    } catch {}

    // Belt: executeJavaScript on every navigation start.
    win.webContents.on("did-start-navigation", () => {
      if (!win || win.isDestroyed()) return;
      const script = beltScripts[i];
      if (script) {
        win.webContents.executeJavaScript(script, true).catch(() => {});
      }
    });

    win.webContents.setWindowOpenHandler((details) => {
      const job = pendingBySlot[i];
      if (job?.job.isVideoJob) return { action: "deny" };
      try {
        const primaryHost = new URL(job?.job.url ?? "").hostname;
        const targetHost = new URL(details.url).hostname;
        if (getBaseDomain(primaryHost) === getBaseDomain(targetHost) || isWhitelistedVideoDomain(targetHost)) {
          setTimeout(() => { win.loadURL(details.url).catch(() => {}); }, 0);
        }
      } catch {}
      return { action: "deny" };
    });

    win.webContents.on("will-navigate", (event, navigationUrl) => {
      try {
        const job = pendingBySlot[i];
        const primaryHost = new URL(job?.job.url ?? "").hostname;
        const targetHost = new URL(navigationUrl).hostname;
        if (getBaseDomain(primaryHost) === getBaseDomain(targetHost)) return;
        if (job?.job.isVideoJob) {
          if (isKnownAd.test(targetHost)) {
            console.info(`[scraper] Blocked ad: ${primaryHost} → ${targetHost}`);
            event.preventDefault();
            return;
          }
          return;
        }
        if (isWhitelistedVideoDomain(primaryHost) && isWhitelistedVideoDomain(targetHost)) return;
        console.info(`[scraper] Blocked: ${primaryHost} → ${targetHost}`);
        event.preventDefault();
      } catch { event.preventDefault(); }
    });

    result.push({ win, busy: false, cdpScriptId: null });
  }
  return result;
}

/** Resolve as soon as the new document exists (DOM ready), with a hard cap.
 *  The extractors poll internally via __pWaitFor, so they only need the DOM —
 *  waiting for full loadURL means ad-heavy pages that never finish loading
 *  starve the injector until the job timeout (the "servers load forever" bug). */
function waitForDomReady(win: BrowserWindow, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { win.webContents.removeListener("dom-ready", finish); } catch {}
      try { win.removeListener("closed", finish); } catch {}
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    if (win.isDestroyed()) { finish(); return; }
    try {
      win.webContents.once("dom-ready", finish);
      win.once("closed", finish);
    } catch {
      finish();
    }
  });
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function drain() {
  if (!slots) {
    slots = initSlots();
    slotsReady = new Promise((r) => setTimeout(r, 500));
  }
  if (slotsReady) {
    await slotsReady;
    slotsReady = null;
  }

  for (let i = 0; i < slots.length; i++) {
    if (slots[i].busy) continue;
    const next = peekNext();
    if (!next) return;
    // Reserve one slot for user-facing (priority) video jobs. Background
    // pre-resolves may hold at most SLOT_COUNT-1 slots — otherwise a Play
    // click queues behind warm-up captures for up to a full timeout.
    if (!isPriority(next.job)) {
      let bgBusy = 0;
      for (const q of pendingBySlot) {
        if (q && !isPriority(q.job)) bgBusy++;
      }
      if (bgBusy >= SLOT_COUNT - 1) return;
    }
    claimNext();
    slots[i].busy = true;
    pendingBySlot[i] = next;
    beltScripts[i] = next.job.injectBefore ?? null;
    void runJob(i, next);
  }
}

async function runJob(slotIdx: number, p: Pending) {
  const slot = slots![slotIdx];
  const { win } = slot;
  const deadline = Date.now() + p.job.timeoutMs;
  const timeoutErr = () => new Error(`scrape timeout: ${p.job.url}`);
  let timeoutTimer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(() => reject(timeoutErr()), p.job.timeoutMs);
  });
  timeoutPromise.catch(() => {});
  // Resolves the moment the job settles through any path (fast-path intercept,
  // cancellation, normal completion) so the races below stop waiting on an
  // executeJavaScript prompt that may never settle.
  const SETTLED = Symbol("settled");
  let signalSettled: () => void = () => {};
  const settledPromise = new Promise<symbol>((resolve) => {
    signalSettled = () => resolve(SETTLED);
  });
  p.onSettle = signalSettled;

  try {
    if (win.isDestroyed()) {
      settleReject(p, new Error("scrape window destroyed"));
      return;
    }

    // Navigate directly to the job URL. No `about:blank` prefix or
    // clearStorageData between jobs — those were introduced to prevent
    // cross-job state pollution but actually break network connectivity
    // for subsequent loads (stale DNS, corrupted session state).

    if (p.job.injectBefore) {
      try {
        if (win.webContents.debugger.isAttached()) {
          if (slot.cdpScriptId) {
            await win.webContents.debugger.sendCommand(
              "Page.removeScriptToEvaluateOnNewDocument",
              { identifier: slot.cdpScriptId },
            );
            slot.cdpScriptId = null;
          }
          const resp = await win.webContents.debugger.sendCommand(
            "Page.addScriptToEvaluateOnNewDocument",
            { source: p.job.injectBefore },
          ) as { identifier: string };
          slot.cdpScriptId = resp.identifier;
        }
      } catch {}
    }

    if (p.settled || p.cancelled) return;

    activeJobs.set(win.webContents.id, {
      isVideoJob: !!p.job.isVideoJob,
      resolve: (url: string) => {
        if (!p.settled && !p.cancelled) settleResolve(p, { url });
      },
    });

    const loadPromise = win.loadURL(p.job.url, {
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    }).catch(() => {});

    // Inject as soon as the DOM exists — never wait for full load.
    await Promise.race([waitForDomReady(win, Math.min(8000, p.job.timeoutMs)), loadPromise, settledPromise]);
    if (p.settled || p.cancelled) return;
    if (win.isDestroyed()) {
      settleReject(p, new Error("scrape window destroyed"));
      return;
    }

    if (p.job.injectBefore) {
      win.webContents.executeJavaScript(p.job.injectBefore, true).catch(() => {});
    }

    while (!p.settled && !p.cancelled) {
      if (win.isDestroyed()) {
        settleReject(p, new Error("scrape window destroyed"));
        return;
      }
      if (Date.now() >= deadline) {
        settleReject(p, timeoutErr());
        return;
      }
      let exec: Promise<any>;
      try {
        exec = win.webContents.executeJavaScript(p.job.injectAfter, true);
      } catch (e: any) {
        settleReject(p, e instanceof Error ? e : new Error(String(e)));
        return;
      }
      // A late rejection must not surface as an unhandled rejection.
      exec.catch(() => {});
      try {
        const res = await Promise.race([exec, timeoutPromise, settledPromise]);
        if (res === SETTLED) return;
        if (!p.settled && !p.cancelled) settleResolve(p, res);
        return;
      } catch (e: any) {
        if (p.settled || p.cancelled) return;
        const msg = String(e?.message || e?.name || e);
        if (msg.includes("context was destroyed") || msg.includes("navigated") || msg.includes("Target closed")) {
          if (Date.now() >= deadline) {
            settleReject(p, timeoutErr());
            return;
          }
          await delay(500);
          continue;
        }
        settleReject(p, e instanceof Error ? e : new Error(String(e)));
        return;
      }
    }
    if (!p.settled && p.cancelled) settleReject(p, new Error("cancelled: playback selected"));
  } catch (e: any) {
    settleReject(p, e instanceof Error ? e : new Error(String(e)));
  } finally {
    p.onSettle = undefined;
    try { activeJobs.delete(win.webContents.id); } catch {}
    if (timeoutTimer) clearTimeout(timeoutTimer);
    // Video extraction leaves the hidden window sitting on a live embed: the
    // captured <video> keeps buffering the whole file and ad scripts keep
    // looping in the background. Across a long session the 3 slots pile up
    // these leftover downloads, starving bandwidth/CPU — the main player
    // "buffers forever" and later extractions time out, so only the first
    // server worked until an app restart. Halt the leftover page. This is a
    // POST-job cleanup, NOT the pre-job about:blank prefix that broke
    // connectivity (removed above): the next job's loadURL is a fresh nav that
    // supersedes this blank.
    if ((p.job.isVideoJob || p.job.stopAfter) && !win.isDestroyed()) {
      try { win.webContents.stop(); } catch {}
      win.loadURL("about:blank").catch(() => {});
    }
    slot.busy = false;
    pendingBySlot[slotIdx] = null;
    beltScripts[slotIdx] = null;
    setTimeout(drain, 0);
  }
}
