// Read-ahead proxy for progressive (single-file MP4) streams.
//
// Chromium buffers a progressive <video> only ~15-25s ahead, however fast the
// link (measured 2026-11-25 on a 3.7MB/s mp4upload file: a 15s→25s sawtooth),
// then stops reading until playback drains it. So vid3rb / mp4upload / videa
// could never build a cushion: any route dip longer than ~15s stalled the
// picture, and links that average above the bitrate still stuttered. HLS gets
// a 300s buffer from hls.js; this gives progressive files the same.
//
// The <video> plays http://127.0.0.1:<port>/ra/<id> instead of the CDN URL.
// One upstream connection per stream (vid3rb 503s a second one) downloads as
// fast as the route allows into a sparse temp file, up to ~10 minutes of video
// ahead of the playhead; the player's range requests are answered from that
// file the moment the bytes exist. Seeks re-aim the downloader. Requests go
// through net.request on the default session, so the DoH resolver, the dead
// Cloudflare edge tunnel and the canonical Referer stamping all still apply.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { app, net, session } from "electron";

type Interval = [number, number]; // [start, end)

const AHEAD_SECONDS = 600;            // download this much video ahead of the playhead
const MIN_AHEAD_BYTES = 48 << 20;     // …but never less than 48MB
const ASSUMED_RUNTIME_SEC = 24 * 60;  // bitrate = size / runtime until told otherwise
const COVER_WINDOW = 3 << 20;         // a downloader this close behind a read will reach it soon
const READ_CHUNK = 256 << 10;
// Safety net only: the renderer closes a stream when it drops it. A long user
// pause must not lose the session (the <video> re-requests on resume).
const IDLE_CLOSE_MS = 30 * 60_000;
const CLOSE_GRACE_MS = 15_000;
const MAX_SESSIONS = 3;
const META_TIMEOUT_MS = 25_000;
const DATA_TIMEOUT_MS = 45_000;

// Electron types IncomingMessage as a plain emitter; at runtime it is a Node
// Readable, so pause/resume give real TCP backpressure.
const flow = (m: Electron.IncomingMessage, on: boolean) => {
  const r = m as unknown as NodeJS.ReadableStream;
  if (on) r.resume(); else r.pause();
};

let allowHostHook: (url: string) => void = () => {};
let uaHook: () => string = () => session.defaultSession.getUserAgent();

class RaSession {
  readonly id = crypto.randomBytes(12).toString("hex");
  readonly file: string;
  total = -1;
  contentType = "video/mp4";
  runtimeSec = ASSUMED_RUNTIME_SEC;
  fatal: { status: number } | null = null;
  private fd: number | null = null;
  private have: Interval[] = [];
  private waiters = new Set<() => void>();
  private readers = 0;
  primaryPos = 0;
  lastUsed = Date.now();
  // downloader
  private req: Electron.ClientRequest | null = null;
  private msg: Electron.IncomingMessage | null = null;
  private dlStart = -1;
  dlPos = -1;
  private paused = false;
  private failures = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private queued = 0;
  private generation = 0;
  // throughput samples (bytes written) for stats
  private rate: { t: number; b: number }[] = [];
  finalHost = "";
  closed = false;

  constructor(readonly url: string) {
    this.file = path.join(app.getPath("temp"), `pantoufa-ra-${this.id}.bin`);
  }

  private ensureFd(): number {
    if (this.fd == null) this.fd = fs.openSync(this.file, "w+");
    return this.fd;
  }

  private notify() {
    const list = [...this.waiters];
    this.waiters.clear();
    for (const w of list) { try { w(); } catch {} }
  }

  wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const fire = () => { if (done) return; done = true; clearTimeout(t); this.waiters.delete(fire); resolve(); };
      const t = setTimeout(fire, ms);
      this.waiters.add(fire);
    });
  }

  /** End of the contiguous cached run starting at pos (pos itself if none). */
  contiguousEnd(pos: number): number {
    for (const [s, e] of this.have) if (s <= pos && pos < e) return e;
    return pos;
  }

  private addInterval(s: number, e: number) {
    if (e <= s) return;
    const out: Interval[] = [];
    let ns = s, ne = e, placed = false;
    for (const [a, b] of this.have) {
      if (b < ns) out.push([a, b]);
      else if (a > ne) { if (!placed) { out.push([ns, ne]); placed = true; } out.push([a, b]); }
      else { ns = Math.min(ns, a); ne = Math.max(ne, b); }
    }
    if (!placed) out.push([ns, ne]);
    this.have = out;
  }

  private nextGap(from: number): number {
    let pos = from;
    for (const [s, e] of this.have) {
      if (e <= pos) continue;
      if (s > pos) break;
      pos = e;
    }
    return this.total > 0 && pos >= this.total ? -1 : pos;
  }

  aheadLimitBytes(): number {
    if (this.total <= 0) return MIN_AHEAD_BYTES;
    return Math.max(MIN_AHEAD_BYTES, Math.round(this.total * AHEAD_SECONDS / Math.max(60, this.runtimeSec)));
  }

  /** Is the downloader positioned to deliver `pos` (possibly paused)? */
  covers(pos: number): boolean {
    if (!this.req) return false;
    return this.dlStart <= pos && pos <= this.dlPos + COVER_WINDOW;
  }

  /** Aim the downloader: keep it running from the end of the cached run at the
   *  playhead until it is aheadLimit in front, then pause. */
  pump() {
    if (this.closed || this.fatal) return;
    const from = this.primaryPos;
    const gap = this.nextGap(from);
    if (gap < 0) { this.stopDownload(); return; }            // cached to EOF
    const ahead = gap - from;
    if (ahead >= this.aheadLimitBytes()) {
      if (this.msg && !this.paused) { this.paused = true; try { flow(this.msg, false); } catch {} }
      return;
    }
    if (this.covers(gap)) {
      if (this.paused) { this.paused = false; try { if (this.msg) flow(this.msg, true); } catch {} }
      return;
    }
    if (this.retryTimer) return; // backing off after an upstream error
    this.startDownload(gap);
  }

  stopDownload() {
    this.generation++;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    const r = this.req;
    this.req = null; this.msg = null; this.paused = false;
    if (r) { try { r.abort(); } catch {} }
  }

  startDownload(pos: number) {
    this.stopDownload();
    if (this.closed) return;
    const gen = this.generation;
    this.dlStart = pos;
    this.dlPos = pos;
    let req: Electron.ClientRequest;
    try {
      allowHostHook(this.url);
      req = net.request({ url: this.url, session: session.defaultSession, redirect: "manual", useSessionCookies: true });
      req.setHeader("User-Agent", uaHook());
      req.setHeader("Accept", "*/*");
      req.setHeader("Accept-Language", "en-US,en;q=0.9");
      req.setHeader("Range", `bytes=${pos}-`);
    } catch { this.scheduleRetry(gen); return; }
    this.req = req;
    req.on("redirect", (_s, _m, redirectUrl) => {
      try { allowHostHook(redirectUrl); this.finalHost = new URL(redirectUrl).host; } catch {}
      try { req.followRedirect(); } catch {}
    });
    req.on("response", (msg) => {
      if (gen !== this.generation) { try { req.abort(); } catch {} return; }
      const status = msg.statusCode;
      const header = (n: string) => { const h = msg.headers[n]; return Array.isArray(h) ? h[0] || "" : String(h || ""); };
      if (status === 401 || status === 403 || status === 404 || status === 410) {
        // Dead/expired token: let the player's own error path re-extract.
        this.fatal = { status };
        this.notify();
        try { req.abort(); } catch {}
        return;
      }
      if (status !== 206 && !(status === 200 && pos === 0)) {
        try { req.abort(); } catch {}
        this.scheduleRetry(gen);
        return;
      }
      const cr = /bytes\s+(\d+)-(\d+)\/(\d+)/i.exec(header("content-range"));
      if (cr) this.total = Number(cr[3]);
      else if (status === 200) this.total = Number(header("content-length") || -1);
      const ct = header("content-type");
      if (ct && !/text\/html/i.test(ct)) this.contentType = ct;
      if (!this.finalHost) { try { this.finalHost = new URL(this.url).host; } catch {} }
      this.failures = 0;
      this.msg = msg;
      this.notify();
      msg.on("data", (chunk: Buffer) => {
        if (gen !== this.generation) return;
        const at = this.dlPos;
        this.dlPos += chunk.length;
        this.queued += chunk.length;
        if (this.queued > (8 << 20)) { try { flow(msg, false); } catch {} }
        this.writing = this.writing.then(() => new Promise<void>((resolve) => {
          if (this.closed) { resolve(); return; }
          let fd: number;
          try { fd = this.ensureFd(); } catch { resolve(); return; }
          fs.write(fd, chunk, 0, chunk.length, at, (err) => {
            this.queued -= chunk.length;
            if (!err) {
              this.addInterval(at, at + chunk.length);
              const now = Date.now();
              this.rate.push({ t: now, b: chunk.length });
              while (this.rate.length && now - this.rate[0].t > 20_000) this.rate.shift();
              this.notify();
            }
            if (gen === this.generation && this.queued < (2 << 20) && !this.paused) { try { flow(msg, true); } catch {} }
            if (gen === this.generation) this.pump();
            resolve();
          });
        }));
      });
      msg.on("end", () => {
        if (gen !== this.generation) return;
        // Stay "downloading" until the last writes land, or a reader waiting
        // on those bytes would see no downloader and open a redundant one.
        void this.writing.then(() => {
          if (gen !== this.generation) return;
          this.req = null; this.msg = null;
          this.pump();
        });
      });
      msg.on("error", () => { if (gen === this.generation) this.scheduleRetry(gen); });
    });
    req.on("error", () => { if (gen === this.generation) this.scheduleRetry(gen); });
    req.end();
  }

  private scheduleRetry(gen: number) {
    if (gen !== this.generation || this.closed) return;
    this.req = null; this.msg = null;
    this.failures++;
    if (this.failures > 6) {
      this.fatal = { status: 502 };
      this.notify();
      return;
    }
    const delay = Math.min(4000, 400 * 2 ** (this.failures - 1));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (gen === this.generation && !this.closed) this.pump();
    }, delay);
  }

  read(pos: number, len: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (this.fd == null) { reject(new Error("no data")); return; }
      const buf = Buffer.allocUnsafe(len);
      fs.read(this.fd, buf, 0, len, pos, (err, n) => (err ? reject(err) : resolve(n === len ? buf : buf.subarray(0, n))));
    });
  }

  closeTimer: ReturnType<typeof setTimeout> | null = null;
  addReader() { this.readers++; this.lastUsed = Date.now(); }
  removeReader() { this.readers = Math.max(0, this.readers - 1); this.lastUsed = Date.now(); }
  get idle() { return this.readers === 0 && Date.now() - this.lastUsed > IDLE_CLOSE_MS; }

  stats() {
    const now = Date.now();
    const recent = this.rate.filter((r) => now - r.t <= 10_000);
    const span = recent.length ? Math.max(1000, now - recent[0].t) : 0;
    const bytes = recent.reduce((n, r) => n + r.b, 0);
    const bytesPerSec = this.total > 0 ? this.total / Math.max(60, this.runtimeSec) : 0;
    const aheadBytes = Math.max(0, this.contiguousEnd(this.primaryPos) - this.primaryPos);
    return {
      total: this.total,
      kbps: span ? Math.round(bytes / 1024 / (span / 1000)) : 0,
      needKbps: Math.round(bytesPerSec / 1024),
      aheadSec: bytesPerSec > 0 ? Math.round(aheadBytes / bytesPerSec) : 0,
      downloading: !!this.req && !this.paused,
      host: this.finalHost,
      fatal: this.fatal?.status || 0,
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.stopDownload();
    this.notify();
    const fd = this.fd;
    this.fd = null;
    void this.writing.finally(() => {
      if (fd != null) { try { fs.closeSync(fd); } catch {} }
      fs.unlink(this.file, () => {});
    });
  }
}

const sessions = new Map<string, RaSession>(); // by id
let server: http.Server | null = null;
let port = 0;
let starting: Promise<number> | null = null;

function sweep() {
  for (const [id, s] of sessions) if (s.idle || s.closed) { s.close(); sessions.delete(id); }
}

async function serve(req: http.IncomingMessage, res: http.ServerResponse) {
  const m = /^\/ra\/([a-f0-9]{24})(?:[/?]|$)/.exec(req.url || "");
  const s = m ? sessions.get(m[1]) : null;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  if (!s || s.closed) { res.writeHead(404); res.end(); return; }
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); res.end(); return; }
  s.addReader();
  let aborted = false;
  res.on("close", () => { aborted = true; s.removeReader(); });
  try {
    const range = /bytes=(\d*)-(\d*)/.exec(String(req.headers.range || ""));
    let start = range && range[1] ? Number(range[1]) : 0;
    // This request is now the playhead.
    s.primaryPos = start;
    s.pump();
    const metaDeadline = Date.now() + META_TIMEOUT_MS;
    while (s.total < 0 && !s.fatal && !aborted && !s.closed && Date.now() < metaDeadline) await s.wait(1000);
    if (aborted) return;
    if (s.fatal || s.total < 0) { res.writeHead(s.fatal?.status || 504); res.end(); return; }
    const total = s.total;
    if (range && !range[1] && range[2]) start = Math.max(0, total - Number(range[2])); // suffix range
    if (start >= total) { res.writeHead(416, { "Content-Range": `bytes */${total}` }); res.end(); return; }
    const end = range && range[1] && range[2] ? Math.min(total - 1, Number(range[2])) : total - 1;
    s.primaryPos = start;
    s.pump();
    res.writeHead(range ? 206 : 200, {
      "Content-Type": s.contentType,
      "Accept-Ranges": "bytes",
      "Content-Length": String(end - start + 1),
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${total}` } : {}),
    });
    if (req.method === "HEAD") { res.end(); return; }
    let cur = start;
    let lastData = Date.now();
    while (cur <= end && !aborted && !s.closed) {
      const avail = Math.min(s.contiguousEnd(cur), end + 1);
      if (avail > cur) {
        const buf = await s.read(cur, Math.min(READ_CHUNK, avail - cur));
        if (aborted || !buf.length) break;
        cur += buf.length;
        lastData = Date.now();
        s.primaryPos = cur;
        s.lastUsed = lastData;
        if (!res.write(buf)) {
          await new Promise<void>((r) => {
            const done = () => { res.off("drain", done); res.off("close", done); r(); };
            res.on("drain", done);
            res.on("close", done);
          });
        }
        s.pump();
        continue;
      }
      if (s.fatal) break;
      s.primaryPos = cur;
      s.pump();
      if (Date.now() - lastData > DATA_TIMEOUT_MS) break;
      await s.wait(1500);
    }
    res.end();
  } catch {
    try { if (!res.headersSent) res.writeHead(502); res.end(); } catch {}
  }
}

function ensureServer(): Promise<number> {
  if (port) return Promise.resolve(port);
  if (starting) return starting;
  starting = new Promise<number>((resolve, reject) => {
    const srv = http.createServer((req, res) => { void serve(req, res); });
    srv.keepAliveTimeout = 30_000;
    srv.on("error", (e) => { starting = null; reject(e); });
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      port = typeof addr === "object" && addr ? addr.port : 0;
      server = srv;
      resolve(port);
    });
  });
  return starting;
}

export function initReadAhead(opts: { allowHost: (url: string) => void; userAgent: () => string }) {
  allowHostHook = opts.allowHost;
  uaHook = opts.userAgent;
  // A crash or a killed process skips the quit cleanup and leaves a cache file
  // (up to a whole episode) in %TEMP%. Sweep leftovers older than 10 minutes —
  // a second instance's live files are younger and keep being written.
  try {
    const dir = app.getPath("temp");
    const cutoff = Date.now() - 10 * 60_000;
    for (const name of fs.readdirSync(dir)) {
      if (!/^pantoufa-ra-[a-f0-9]{24}\.bin$/.test(name)) continue;
      const full = path.join(dir, name);
      try { if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full); } catch {}
    }
  } catch {}
  setInterval(sweep, 30_000).unref?.();
  app.on("will-quit", () => {
    for (const s of sessions.values()) s.close();
    sessions.clear();
    try { server?.close(); } catch {}
  });
}

/** Start (or reuse) a read-ahead session for a progressive URL; returns the
 *  local URL the <video> should play. */
export async function openReadAhead(url: string, runtimeSec?: number): Promise<{ src: string; id: string } | null> {
  if (!/^https?:\/\//i.test(url)) return null;
  sweep();
  for (const s of sessions.values()) {
    if (s.url === url && !s.closed && !s.fatal) {
      if (s.closeTimer) { clearTimeout(s.closeTimer); s.closeTimer = null; }
      if (runtimeSec && runtimeSec > 60) s.runtimeSec = runtimeSec;
      s.lastUsed = Date.now();
      return { src: `http://127.0.0.1:${await ensureServer()}/ra/${s.id}`, id: s.id };
    }
  }
  const p = await ensureServer();
  // Bound disk/bandwidth: evict the least recently used streams.
  while (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0];
    oldest.close();
    sessions.delete(oldest.id);
  }
  const s = new RaSession(url);
  if (runtimeSec && runtimeSec > 60) s.runtimeSec = runtimeSec;
  sessions.set(s.id, s);
  s.startDownload(0); // first bytes + total size before the player even asks
  return { src: `http://127.0.0.1:${p}/ra/${s.id}`, id: s.id };
}

export function readAheadStats(id: string) {
  const s = sessions.get(id);
  return s && !s.closed ? s.stats() : null;
}

export function setReadAheadRuntime(id: string, runtimeSec: number) {
  const s = sessions.get(id);
  if (s && runtimeSec > 60) { s.runtimeSec = runtimeSec; s.pump(); }
}

/** The player dropped this stream. Closed after a short grace so an
 *  immediate re-wire of the same URL (transport retry, effect re-run) reuses
 *  the cache instead of downloading it again. */
export function closeReadAhead(id: string) {
  const s = sessions.get(id);
  if (!s || s.closeTimer) return;
  s.closeTimer = setTimeout(() => {
    s.closeTimer = null;
    s.close();
    sessions.delete(id);
  }, CLOSE_GRACE_MS);
}
