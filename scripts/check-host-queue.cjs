// Host queue regression test: priority jump, background slot reservation,
// cancellation, and — the core bug — a job whose executeJavaScript never
// settles must still settle at its timeout and free its slot.
// Loads the real electron/scraper/host.ts in a VM with a stubbed electron.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function makeEmitter() {
  const listeners = new Map();
  return {
    on(ev, fn) { (listeners.get(ev) || listeners.set(ev, []).get(ev)).push(fn); return this; },
    once(ev, fn) {
      const wrap = (...args) => { this.removeListener(ev, wrap); fn(...args); };
      return this.on(ev, wrap);
    },
    removeListener(ev, fn) {
      const arr = listeners.get(ev);
      if (arr) { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); }
      return this;
    },
    emit(ev, ...args) { for (const fn of [...(listeners.get(ev) || [])]) fn(...args); },
  };
}

let nextWebContentsId = 1;
const createdWindows = [];
const loadUrls = [];
const execScripts = [];

class FakeWebContents {
  constructor() {
    this.id = nextWebContentsId++;
    this.emitter = makeEmitter();
    this.debugger = { isAttached: () => false, attach() {}, sendCommand: async () => ({ identifier: 'x' }) };
  }
  on(ev, fn) { this.emitter.on(ev, fn); return this; }
  once(ev, fn) { this.emitter.once(ev, fn); return this; }
  removeListener(ev, fn) { this.emitter.removeListener(ev, fn); return this; }
  emit(ev, ...args) { this.emitter.emit(ev, ...args); }
  setAudioMuted() {}
  setWindowOpenHandler() {}
  stop() {}
  executeJavaScript(script) {
    execScripts.push(script);
    if (script === 'NEVER') return new Promise(() => {});
    if (script === 'OK') return Promise.resolve('OK');
    return Promise.resolve(null);
  }
}

class FakeBrowserWindow {
  constructor() {
    this.wc = new FakeWebContents();
    this.emitter = makeEmitter();
    this.destroyed = false;
    this.urls = [];
    createdWindows.push(this);
  }
  get webContents() { return this.wc; }
  on(ev, fn) { this.emitter.on(ev, fn); return this; }
  once(ev, fn) { this.emitter.once(ev, fn); return this; }
  removeListener(ev, fn) { this.emitter.removeListener(ev, fn); return this; }
  emit(ev, ...args) { this.emitter.emit(ev, ...args); }
  isDestroyed() { return this.destroyed; }
  hide() {}
  setOpacity() {}
  loadURL(url) {
    loadUrls.push(url);
    this.urls.push(url);
    if (url !== 'about:blank') setImmediate(() => this.wc.emit('dom-ready'));
    return Promise.resolve();
  }
}

const electronStub = { BrowserWindow: FakeBrowserWindow };

function loadHost() {
  const file = path.join(__dirname, '..', 'electron', 'scraper', 'host.ts');
  const source = fs.readFileSync(file, 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const require = (name) => {
    if (name === 'electron') return electronStub;
    throw new Error(`unexpected require(${name})`);
  };
  const context = vm.createContext({
    module, exports: module.exports, require, console,
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, Date, Promise, Error, URL, Symbol,
  });
  vm.runInContext(js, context);
  return module.exports;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
]);
const expectReject = (promise, label) => promise.then(
  () => { throw new Error(`${label}: expected rejection`); },
  (e) => e,
);

(async () => {
  const host = loadHost();
  assert.equal(typeof host.enqueue, 'function', 'enqueue exported');
  assert.equal(typeof host.cancelBackgroundJobs, 'function', 'cancelBackgroundJobs exported');
  assert.equal(typeof host.tryFastPathRequest, 'function', 'tryFastPathRequest exported');

  // ── Phase 1: reservation + priority + cancellation ─────────────────────
  // First enqueue waits out the 500ms slotsReady delay.
  const bg1 = host.enqueue({ url: 'https://src.example/1', injectAfter: 'NEVER', timeoutMs: 8000 });
  await sleep(600); // slots are up; bg1 started
  const bg2 = host.enqueue({ url: 'https://src.example/2', injectAfter: 'NEVER', timeoutMs: 8000 });
  const bg3 = host.enqueue({ url: 'https://src.example/3', injectAfter: 'NEVER', timeoutMs: 8000 });
  const bg4 = host.enqueue({ url: 'https://src.example/4', injectAfter: 'NEVER', timeoutMs: 8000 });
  await sleep(100);
  // 3 slots, one reserved ⇒ at most 2 background jobs in flight.
  const startedBg = loadUrls.filter((u) => u.startsWith('https://src.example/')).length;
  assert.equal(startedBg, 2, `background reservation: expected 2 started, got ${startedBg}`);

  // A priority job must start immediately on the reserved slot.
  const priority = host.enqueue({ url: 'https://src.example/priority', injectAfter: 'OK', timeoutMs: 4000, priority: true });
  assert.equal(await withTimeout(priority, 2000, 'priority job'), 'OK', 'priority job resolves');
  assert.ok(loadUrls.includes('https://src.example/priority'), 'priority job started on the reserved slot');

  // Cancelling background work rejects queued AND in-flight background jobs
  // and must free the slots (the settledPromise race).
  const cancelled = host.cancelBackgroundJobs();
  assert.equal(cancelled, 4, `expected 4 background jobs cancelled, got ${cancelled}`);
  for (const [label, promise] of [['bg1', bg1], ['bg2', bg2], ['bg3', bg3], ['bg4', bg4]]) {
    const err = await withTimeout(expectReject(promise, label), 2000, label);
    assert.match(err.message, /cancelled: playback selected/, `${label} cancellation message`);
  }
  console.log('PASS reservation + priority jump + background cancellation');

  // ── Phase 2: a never-settling executeJavaScript must not wedge the slot ─
  const stuck = host.enqueue({ url: 'https://src.example/stuck', injectAfter: 'NEVER', timeoutMs: 400 });
  const stuckErr = await withTimeout(expectReject(stuck, 'stuck job'), 3000, 'stuck job');
  assert.match(stuckErr.message, /scrape timeout/, 'stuck job settles with timeout error');
  const after = host.enqueue({ url: 'https://src.example/after', injectAfter: 'OK', timeoutMs: 2000 });
  assert.equal(await withTimeout(after, 2000, 'post-timeout job'), 'OK', 'slot freed after timeout');
  console.log('PASS never-settling job settles at timeout and frees its slot');

  // ── Phase 3: fast-path intercept settles a video job immediately ────────
  const videoJob = host.enqueue({
    url: 'https://embed.example/watch', injectAfter: 'NEVER', timeoutMs: 8000, isVideoJob: true,
  });
  await sleep(100);
  const slotWindow = createdWindows.find((w) => w.urls.includes('https://embed.example/watch'));
  assert.ok(slotWindow, 'slot window for video job exists');
  let fastPathCancel = false;
  const handled = host.tryFastPathRequest(
    { webContentsId: slotWindow.wc.id, url: 'https://cdn.example/master.m3u8' },
    (res) => { fastPathCancel = !!res.cancel; },
  );
  assert.equal(handled, true, 'fast-path handles slot m3u8 request');
  assert.equal(fastPathCancel, true, 'fast-path cancels the intercepted request');
  const fastPathResult = await withTimeout(videoJob, 2000, 'fast-path job');
  assert.equal(fastPathResult && fastPathResult.url, 'https://cdn.example/master.m3u8', 'video job resolved by fast path');
  assert.equal(host.tryFastPathRequest({ webContentsId: 999999, url: 'https://cdn.example/master.m3u8' }, () => {}), false, 'non-slot requests pass through');
  console.log('PASS fast-path intercept settles video jobs');

  console.log('ALL host queue checks passed');
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
