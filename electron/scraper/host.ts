import { BrowserWindow, session } from "electron";

const SLOT_COUNT = 3;

export type ScrapeJob = {
  url: string;
  injectBefore?: string;
  injectAfter: string;
  timeoutMs: number;
  isVideoJob?: boolean;
};

type Pending = {
  job: ScrapeJob;
  resolve: (v: any) => void;
  reject: (e: Error) => void;
};

type Slot = {
  win: BrowserWindow;
  busy: boolean;
  cdpScriptId: string | null;
};

const queue: Pending[] = [];
const videoQueue: Pending[] = []; // prioritized — user-facing video extraction
let slots: Slot[] | null = null;
let slotsReady: Promise<void> | null = null;

export function enqueue(job: ScrapeJob): Promise<any> {
  return new Promise((resolve, reject) => {
    const entry = { job, resolve, reject };
    if (job.isVideoJob) {
      videoQueue.push(entry);
    } else {
      queue.push(entry);
    }
    void drain();
  });
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

const activeJobs = new Map<number, { resolve: (url: string) => void }>();
const pendingBySlot: (Pending | null)[] = Array.from({ length: SLOT_COUNT }, () => null);
const beltScripts: (string | null)[] = Array.from({ length: SLOT_COUNT }, () => null);

function initSlots(): Slot[] {
  const ses = session.fromPartition("persist:scraper");

  ses.webRequest.onBeforeRequest((details, cb) => {
    const u = details.url.toLowerCase();
    if (details.webContentsId) {
      const entry = activeJobs.get(details.webContentsId);
      if (entry && /\.m3u8(\?|$)/i.test(u)) {
        const decoy = /test-videos\.co\.uk|bigbuckbunny|sample[-_.]|placeholder/.test(u);
        if (!decoy) {
          try {
            const host = new URL(details.url).hostname.toLowerCase();
            if (!/test-videos|bigbuckbunny|sample|placeholder|google|facebook|doubleclick|popads|propeller|trafficjunky|popcash|disqus|googletag|analytics|pyppo/.test(host)) {
              console.info(`[scraper] Fast-path intercept: ${details.url}`);
              entry.resolve(details.url);
              return cb({ cancel: true });
            }
          } catch {}
        }
      }
    }
    if (/doubleclick|googletagmanager|google-analytics|facebook\.com\/tr|popads|propeller|trafficjunky|popcash/.test(u)) {
      return cb({ cancel: true });
    }
    cb({});
  });

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
          // The persist:scraper session couldn't reach mp4upload at all.
        backgroundThrottling: false,
        webSecurity: true,
        autoplayPolicy: "no-user-gesture-required",
      },
    });

    // Never show this window.
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
    // Video extraction jobs jump the queue — user-facing play must never
    // wait behind background home-page scraping.
    const next = videoQueue.shift() ?? queue.shift();
    if (!next) return;
    slots[i].busy = true;
    pendingBySlot[i] = next;
    beltScripts[i] = next.job.injectBefore ?? null;
    void runJob(i, next);
  }
}

async function runJob(slotIdx: number, p: Pending) {
  const slot = slots![slotIdx];
  const { win } = slot;
  let timer: NodeJS.Timeout | null = null;
  let timedOut = false;
  let fastPathResolved = false;

  try {
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

    activeJobs.set(win.webContents.id, {
      resolve: (url: string) => {
        if (!timedOut && !fastPathResolved) {
          fastPathResolved = true;
          if (timer) clearTimeout(timer);
          p.resolve({ url });
        }
      },
    });

    timer = setTimeout(() => { timedOut = true; }, p.job.timeoutMs);

    await win.loadURL(p.job.url, {
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    }).catch(() => {});

    if (fastPathResolved) return;
    if (timedOut || win.isDestroyed()) {
      throw new Error(`scrape timeout: ${p.job.url}`);
    }

    if (p.job.injectBefore) {
      win.webContents.executeJavaScript(p.job.injectBefore, true).catch(() => {});
    }

    let result: any = null;
    while (!timedOut && !win.isDestroyed()) {
      try {
        result = await win.webContents.executeJavaScript(p.job.injectAfter, true);
        break;
      } catch (e: any) {
        if (timedOut || fastPathResolved) return;
        const msg = String(e?.message || e?.name || e);
        if (msg.includes("context was destroyed") || msg.includes("navigated") || msg.includes("Target closed")) {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        throw e;
      }
    }

    if (fastPathResolved) return;
    if (timer) clearTimeout(timer);
    p.resolve(result);
  } catch (e: any) {
    if (!fastPathResolved) {
      if (timer) clearTimeout(timer);
      p.reject(e instanceof Error ? e : new Error(String(e)));
    }
  } finally {
    activeJobs.delete(win.webContents.id);
    slot.busy = false;
    pendingBySlot[slotIdx] = null;
    beltScripts[slotIdx] = null;
    setTimeout(drain, 0);
  }
}
