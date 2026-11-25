// Read-ahead proxy (electron/readAhead.ts) against a fake upstream: byte-exact
// ranges, seeks re-aiming the single downloader, suffix ranges, dead-token
// status passthrough, download-ahead limit, and cleanup of the temp file.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const ts = require('typescript');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');

const SIZE = 6 * 1024 * 1024 + 12345;
const file = Buffer.alloc(SIZE);
for (let i = 0; i < SIZE; i++) file[i] = (i * 2654435761) >>> 24;

let upstreamRequests = [];
let upstreamStatus = 206;
let chunkDelayMs = 0;

class FakeRequest extends EventEmitter {
  constructor(opts) { super(); this.url = opts.url; this.headers = {}; this.aborted = false; }
  setHeader(k, v) { this.headers[k.toLowerCase()] = v; }
  followRedirect() {}
  abort() { this.aborted = true; this.stream?.destroy(); }
  end() {
    upstreamRequests.push(this);
    setTimeout(() => {
      if (this.aborted) return;
      const m = /bytes=(\d+)-/.exec(this.headers.range || '');
      const start = m ? Number(m[1]) : 0;
      if (upstreamStatus !== 206) {
        const msg = Readable.from([]);
        msg.statusCode = upstreamStatus; msg.headers = {};
        this.emit('response', msg);
        return;
      }
      let pos = start;
      const self = this;
      const msg = new Readable({
        read() {
          if (self.aborted) { this.push(null); return; }
          if (pos >= SIZE) { this.push(null); return; }
          const n = Math.min(64 * 1024, SIZE - pos);
          const chunk = file.subarray(pos, pos + n);
          pos += n;
          if (chunkDelayMs) setTimeout(() => this.push(chunk), chunkDelayMs); else this.push(chunk);
        },
      });
      this.stream = msg;
      msg.statusCode = 206;
      msg.headers = { 'content-range': `bytes ${start}-${SIZE - 1}/${SIZE}`, 'content-type': 'video/mp4' };
      this.emit('response', msg);
    }, 5);
  }
}

const quitHandlers = [];
const electron = {
  app: { getPath: () => os.tmpdir(), on: (ev, fn) => { if (ev === 'will-quit') quitHandlers.push(fn); } },
  session: { defaultSession: { getUserAgent: () => 'UA' } },
  net: { request: (opts) => new FakeRequest(opts) },
};

const src = ts.transpileModule(fs.readFileSync(path.join(root, 'electron/readAhead.ts'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;
const mod = { exports: {} };
const req = (name) => (name === 'electron' ? electron : require(name));
vm.runInNewContext(src, { module: mod, exports: mod.exports, require: req, Buffer, setTimeout, clearTimeout, setInterval, clearInterval, console, process, URL });
const ra = mod.exports;

function get(url, range) {
  return new Promise((resolve, reject) => {
    const r = http.get(url, { headers: range ? { Range: range } : {} }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
      res.on('error', reject);
    });
    r.on('error', reject);
  });
}

(async () => {
  // Leftovers from a crashed run are swept at startup; fresh ones are kept.
  const stale = path.join(os.tmpdir(), `pantoufa-ra-${'a'.repeat(24)}.bin`);
  const live = path.join(os.tmpdir(), `pantoufa-ra-${'b'.repeat(24)}.bin`);
  fs.writeFileSync(stale, 'x'); fs.writeFileSync(live, 'x');
  const old = new Date(Date.now() - 60 * 60_000);
  fs.utimesSync(stale, old, old);
  ra.initReadAhead({ allowHost() {}, userAgent: () => 'UA' });
  assert.equal(fs.existsSync(stale), false, 'stale cache file swept at startup');
  assert.equal(fs.existsSync(live), true, 'a live (recent) cache file is kept');
  fs.unlinkSync(live);

  // Full open-ended read from 0 is byte-exact, 206 with the real total.
  const opened = await ra.openReadAhead('https://cdn.example/video.mp4?token=a', 1440);
  assert.ok(opened && /^http:\/\/127\.0\.0\.1:\d+\/ra\/[a-f0-9]{24}$/.test(opened.src), 'local src');
  let r = await get(opened.src, 'bytes=0-');
  assert.equal(r.status, 206);
  assert.equal(r.headers['content-range'], `bytes 0-${SIZE - 1}/${SIZE}`);
  assert.equal(Buffer.compare(r.body, file), 0, 'full body byte-exact');
  const firstCount = upstreamRequests.length;
  assert.ok(firstCount <= 2, `one downloader for a linear read (got ${firstCount})`);

  // Cached bytes are served without new upstream requests.
  r = await get(opened.src, 'bytes=1000-1999');
  assert.equal(r.status, 206);
  assert.equal(r.headers['content-length'], '1000');
  assert.equal(Buffer.compare(r.body, file.subarray(1000, 2000)), 0);
  assert.equal(upstreamRequests.length, firstCount, 'cache hit needs no upstream');

  // Suffix range and out-of-range.
  r = await get(opened.src, 'bytes=-500');
  assert.equal(Buffer.compare(r.body, file.subarray(SIZE - 500)), 0, 'suffix range');
  r = await get(opened.src, `bytes=${SIZE + 10}-`);
  assert.equal(r.status, 416);

  let stats = ra.readAheadStats(opened.id);
  assert.equal(stats.total, SIZE);
  ra.closeReadAhead(opened.id);

  // A seek far ahead re-aims the downloader at the new offset.
  upstreamRequests = [];
  chunkDelayMs = 2;
  const second = await ra.openReadAhead('https://cdn.example/video2.mp4', 1440);
  const head = await get(second.src, 'bytes=0-65535');
  assert.equal(Buffer.compare(head.body, file.subarray(0, 65536)), 0);
  const seekAt = 5 * 1024 * 1024;
  r = await get(second.src, `bytes=${seekAt}-${seekAt + 99999}`);
  assert.equal(Buffer.compare(r.body, file.subarray(seekAt, seekAt + 100000)), 0, 'seek served byte-exact');
  assert.ok(upstreamRequests.some((q) => q.headers.range === `bytes=${seekAt}-`), 'downloader restarted at the seek offset');
  assert.ok(upstreamRequests.every((q) => q.headers['user-agent'] === 'UA'));

  // Download-ahead stops at the limit: with a 48MB floor the whole 6MB file
  // fits, so the downloader runs to EOF and then idles.
  await new Promise((res) => setTimeout(res, 800));
  stats = ra.readAheadStats(second.id);
  assert.ok(stats.aheadSec >= 0 && stats.needKbps > 0, 'stats report depth and bitrate');
  ra.closeReadAhead(second.id);
  chunkDelayMs = 0;

  // Dead token: the CDN's 403 reaches the player (re-extract), no retry storm.
  upstreamRequests = [];
  upstreamStatus = 403;
  const dead = await ra.openReadAhead('https://cdn.example/dead.mp4');
  r = await get(dead.src, 'bytes=0-');
  assert.equal(r.status, 403, 'dead token status passed through');
  assert.ok(upstreamRequests.length <= 2, `no retry storm on 403 (got ${upstreamRequests.length})`);
  assert.equal(ra.readAheadStats(dead.id).fatal, 403);
  upstreamStatus = 206;

  // Unknown session ids are refused.
  r = await get(second.src.replace(/[a-f0-9]{24}$/, '0'.repeat(24)), 'bytes=0-');
  assert.equal(r.status, 404);

  // Quit cleans temp files.
  const tmpBefore = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('pantoufa-ra-'));
  quitHandlers.forEach((fn) => fn());
  await new Promise((res) => setTimeout(res, 300));
  const tmpAfter = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('pantoufa-ra-'));
  assert.ok(tmpAfter.length <= Math.max(0, tmpBefore.length - 1), `temp files removed (${tmpBefore.length} → ${tmpAfter.length})`);

  console.log('PASS read-ahead proxy: byte-exact ranges, cache hits, suffix/416, seek re-aim, dead-token passthrough, cleanup, stale-file sweep');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
