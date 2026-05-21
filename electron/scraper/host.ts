// Hidden BrowserWindow pool that runs scrape jobs.
//
// Each slot is one off-screen BrowserWindow we can navigate to anime sites.
// We process jobs serially per slot but multiple slots in parallel so home
// (witanime + anime4up) and detail (primary + cross-source) loads finish in
// the time of the slowest single fetch.
//
// CF challenges resolve naturally because each window IS a real Chromium
// instance running with the user's residential IP.

import { BrowserWindow, session } from "electron";

// 3 parallel BrowserWindows. Two wasn't enough when home, wit-detail and
// 4up-detail all want a slot at the same time. Three covers the worst case
// without using too much RAM.
const SLOT_COUNT = 3;

export type ScrapeJob = {
  url: string;
  injectBefore?: string;
  injectAfter: string; // a JS expression that resolves to the data
  timeoutMs: number;
  isVideoJob?: boolean;
};

type Pending = {
  job: ScrapeJob;
  resolve: (v: any) => void;
  reject: (e: Error) => void;
};

const queue: Pending[] = [];
const slots: (Pending | null)[] = Array.from({ length: SLOT_COUNT }, () => null);

let started = false;

export function enqueue(job: ScrapeJob): Promise<any> {
  return new Promise((resolve, reject) => {
    queue.push({ job, resolve, reject });
    void drain();
  });
}

async function drain() {
  for (let i = 0; i < slots.length; i++) {
    if (slots[i] !== null) continue;
    const next = queue.shift();
    if (!next) return;
    slots[i] = next;
    void runJob(i, next);
  }
}

function getBaseDomain(host: string): string {
  const parts = host.toLowerCase().split(".");
  if (parts.length >= 2) {
    return parts.slice(-2).join(".");
  }
  return host;
}

function isWhitelistedVideoDomain(host: string): boolean {
  const h = host.toLowerCase();
  return /streamwish|hgcloud|wishfast|wishembed|jwembed|hlswish|vibuxer|audinifer|masukestin|hanerix|mp4upload|voe|doodstream|dood|uqload|share4max|megamax|videa|okru|vk|dailymotion|dai\.ly/.test(h);
}

let sessionInitialized = false;
const activeJobs = new Map<number, { isVideoJob: boolean, url: string, onFastPath: (url: string) => void }>();

function initSessionIfNeeded() {
  if (sessionInitialized) return;
  sessionInitialized = true;
  const ses = session.fromPartition("persist:scraper");
  ses.webRequest.onBeforeRequest((details, cb) => {
    const u = details.url.toLowerCase();

    if (details.webContentsId) {
      const job = activeJobs.get(details.webContentsId);
      if (job && job.isVideoJob && /\.m3u8(\?|$)/i.test(u) && !/test-videos\.co\.uk/.test(u)) {
        console.info(`[scraper] Fast-path network intercept: ${details.url}`);
        job.onFastPath(details.url);
        return cb({ cancel: true });
      }
    }

    if (/doubleclick|googletagmanager|google-analytics|facebook\.com\/tr|popads|propeller|trafficjunky|popcash/.test(u)) {
      return cb({ cancel: true });
    }
    cb({});
  });
}

async function runJob(slotIdx: number, p: Pending) {
  let win: BrowserWindow | null = null;
  let timer: NodeJS.Timeout | null = null;
  let timedOut = false;
  
  try {
    initSessionIfNeeded();

    win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      webPreferences: {
        offscreen: false,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
        partition: "persist:scraper", // shares cookies between scrape jobs
        backgroundThrottling: false,
        webSecurity: true,
      },
    });

    activeJobs.set(win.webContents.id, {
      isVideoJob: !!p.job.isVideoJob,
      url: p.job.url,
      onFastPath: (url: string) => {
        if (!timedOut) {
          timedOut = true;
          if (timer) clearTimeout(timer);
          p.resolve({ url });
          setTimeout(() => { try { if (win && !win.isDestroyed()) win.destroy(); } catch {} }, 3000);
        }
      }
    });

    // Block popup windows created by ads when play buttons are clicked
    win.webContents.setWindowOpenHandler((details) => {
      console.info(`[scraper] Blocked popup window: ${details.url}`);
      try {
        const primaryHost = new URL(p.job.url).hostname;
        const targetHost = new URL(details.url).hostname;
        const primaryBase = getBaseDomain(primaryHost);
        const targetBase = getBaseDomain(targetHost);
        
        // If the popup is to the same base domain or a whitelisted video domain,
        // navigate the main window to it instead of letting a new window open.
        if (primaryBase === targetBase || isWhitelistedVideoDomain(targetHost)) {
          console.info(`[scraper] Redirecting main window to popup URL: ${details.url}`);
          setTimeout(() => {
            if (win && !win.isDestroyed()) {
              win.loadURL(details.url, {
                userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
              }).catch(() => {});
            }
          }, 0);
        }
      } catch (e) {
        console.error(`[scraper] setWindowOpenHandler error:`, e);
      }
      return { action: "deny" };
    });

    // Block top-level ad redirects away from the video embed host domain
    win.webContents.on("will-navigate", (event, navigationUrl) => {
      try {
        const primaryHost = new URL(p.job.url).hostname;
        const targetHost = new URL(navigationUrl).hostname;
        const primaryBase = getBaseDomain(primaryHost);
        const targetBase = getBaseDomain(targetHost);

        // 1. Same base domain is always allowed
        if (primaryBase === targetBase) {
          return;
        }

        // 2. Legitimate transitions between whitelisted streaming/CDN domains are allowed
        if (isWhitelistedVideoDomain(primaryHost) && isWhitelistedVideoDomain(targetHost)) {
          console.info(`[scraper] Allowed legitimate video domain transition: ${primaryHost} -> ${targetHost}`);
          return;
        }

        // Block everything else as an ad redirect
        console.info(`[scraper] Blocked ad redirect navigation: ${primaryHost} -> ${targetHost}`);
        event.preventDefault();
      } catch (e) {
        event.preventDefault();
      }
    });

    // Hard timeout — mark BEFORE destroying so awaiters can react.
    timer = setTimeout(() => {
      timedOut = true;
      try { win?.destroy(); } catch {}
    }, p.job.timeoutMs);

    if (p.job.injectBefore) {
      // Inject before-load hooks at every navigation event
      win.webContents.on("did-start-navigation", () => {
        if (!win || win.isDestroyed()) return;
        win.webContents.executeJavaScript(p.job.injectBefore!, true).catch(() => {});
      });
    }

    await win.loadURL(p.job.url, {
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    }).catch(() => { /* tolerate goto timeouts; the script handles waits */ });

    // Guard against the timeout having destroyed the window already.
    if (timedOut || !win || win.isDestroyed()) {
      throw new Error(`scrape timeout after ${p.job.timeoutMs}ms: ${p.job.url}`);
    }

    let result: any = null;
    while (!timedOut && win && !win.isDestroyed()) {
      try {
        result = await win.webContents.executeJavaScript(p.job.injectAfter, true);
        break;
      } catch (e: any) {
        if (timedOut) throw new Error(`scrape timeout after ${p.job.timeoutMs}ms: ${p.job.url}`);
        const msg = String(e?.message || e?.name || e);
        if (msg.includes("context was destroyed") || msg.includes("navigated") || msg.includes("Target closed")) {
          console.info(`[scraper] Context destroyed (likely navigation). Re-injecting in 1s...`);
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        throw e;
      }
    }

    if (timer) clearTimeout(timer);
    p.resolve(result);
  } catch (e: any) {
    if (timer) clearTimeout(timer);
    p.reject(e instanceof Error ? e : new Error(String(e)));
  } finally {
    if (win && !win.isDestroyed()) activeJobs.delete(win.webContents.id);
    try { if (win && !win.isDestroyed()) win.destroy(); } catch {}
    slots[slotIdx] = null;
    setTimeout(drain, 0);
  }
}
