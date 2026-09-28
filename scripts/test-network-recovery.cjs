// Network-change recovery: signature detection + reset behaviour.
// Follows test-network-fallback.cjs: extract the main-process block, run it in
// a VM with mocked Electron/os APIs, assert the observable side effects.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function run(source, context) {
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
}

const flush = () => new Promise((r) => setImmediate(r));

(async () => {
  const main = fs.readFileSync('electron/main.ts', 'utf8');
  const sources = [
    main.match(/const DOH_SERVERS = \[[\s\S]*?\];/)?.[0],
    main.match(/const VIRTUAL_ADAPTER_RE = [^\n]*/)?.[0],
    main.match(/async function probeDoh[\s\S]*?(?=\nasync function syncSecureDnsMode)/)?.[0],
    main.match(/async function probeSystemResolver[\s\S]*?(?=\n\/\/ 'secure' has NO)/)?.[0],
    main.match(/async function syncSecureDnsMode[\s\S]*?(?=\nasync function resetNetworkState)/)?.[0],
    main.match(/async function resetNetworkState[\s\S]*?(?=let networkSignature)/)?.[0],
    main.match(/function currentNetworkSignature[\s\S]*?(?=\/\/ Poll the non-internal)/)?.[0],
    main.match(/function watchNetworkChanges[\s\S]*?(?=\/\/ Pull the real)/)?.[0],
  ];
  assert.ok(sources.every(Boolean), 'network-change block found in main.ts');
  // The module-level watcher state the extracted functions close over.
  const block = ['let networkSignature = ""; let networkResetTimer = null;', ...sources].join('\n');

  const WIFI = {
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    'Wi-Fi': [
      { address: '192.168.1.5', family: 'IPv4', internal: false },
      { address: 'fe80::1', family: 'IPv6', internal: false },
    ],
    eth0: [{ address: '10.0.0.7', family: 'IPv4', internal: false }],
    'vEthernet (Default Switch)': [{ address: '172.18.0.1', family: 'IPv4', internal: false }],
    'Tailscale': [{ address: '100.64.0.2', family: 'IPv4', internal: false }],
  };

  const makeContext = () => {
    const calls = { seq: [], resolver: 0, connections: 0, sent: [], modes: [], dohProbes: 0, systemProbes: 0 };
    const timers = [];
    const ctx = {
      calls,
      timers,
      interval: null,
      resume: null,
      sourceEdgeIpsPromise: Promise.resolve(['1.2.3.4']),
      networkInterfaces: () => WIFI,
      app: { configureHostResolver: (opts) => { calls.modes.push(opts); calls.seq.push('configure'); } },
      session: { defaultSession: {
        clearHostResolverCache: async () => { calls.resolver++; calls.seq.push('resolver'); },
        closeAllConnections: async () => { calls.connections++; calls.seq.push('connections'); },
      } },
      mainWindow: { isDestroyed: () => false, webContents: { send: (ch, ...a) => { calls.sent.push([ch, ...a]); calls.seq.push('send'); } } },
      fetch: async (url) => {
        if (String(url).includes('generate_204')) { calls.systemProbes++; return { ok: false, status: 0 }; }
        calls.dohProbes++;
        return { ok: false, status: 503, json: async () => ({}) };
      },
      AbortSignal: { timeout: () => undefined },
      setTimeout: (cb, ms) => {
        const t = { cb, ms };
        if (ms >= 3000) { cb(); return t; } // DoH retry gap: run immediately
        timers.push(t);                       // debounce: test controls it
        return t;
      },
      clearTimeout: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
      setInterval: (cb, ms) => { ctx.interval = { cb, ms }; return 1; },
      powerMonitor: { on: (event, cb) => { if (event === 'resume') ctx.resume = cb; } },
      console,
      Object, Promise, Set, URL, Math, Date,
    };
    ctx.globalThis = ctx;
    return ctx;
  };

  const load = (ctx) =>
    run(`${block}\nglobalThis.currentNetworkSignature = currentNetworkSignature;\nglobalThis.resetNetworkState = resetNetworkState;\nglobalThis.watchNetworkChanges = watchNetworkChanges;`, ctx);

  // ── signature: real addresses only (no internal/IPv6/virtual), sorted ──
  let ctx = makeContext();
  load(ctx);
  assert.equal(ctx.currentNetworkSignature(), '10.0.0.7|192.168.1.5', 'internal, IPv6, and virtual adapters excluded');

  // ── reset: clears + DoH decision complete BEFORE the renderer is notified ──
  ctx = makeContext();
  load(ctx);
  assert.notEqual(ctx.sourceEdgeIpsPromise, null);
  await ctx.resetNetworkState('interface change');
  assert.equal(ctx.sourceEdgeIpsPromise, null, 'stale edge-IP memo dropped');
  assert.equal(ctx.calls.resolver, 1, 'host resolver cache cleared');
  assert.equal(ctx.calls.connections, 1, 'stale connections closed');
  assert.deepEqual(ctx.calls.seq, ['resolver', 'connections', 'configure', 'send'], 'renderer notified only after the network stack is reset');
  assert.equal(ctx.calls.dohProbes, 6, 'three DoH endpoints probed twice before downgrading');
  assert.equal(ctx.calls.modes[0].secureDnsMode, 'secure', 'DoH down + system DNS down → stay secure (automatic buys nothing)');

  // DoH unreachable but the system resolver works → automatic fallback.
  ctx = makeContext();
  ctx.fetch = async (url) => {
    if (String(url).includes('generate_204')) { ctx.calls.systemProbes++; return { ok: true, status: 204 }; }
    ctx.calls.dohProbes++;
    return { ok: false, status: 503 };
  };
  load(ctx);
  await ctx.resetNetworkState('interface change');
  assert.equal(ctx.calls.systemProbes, 1);
  assert.equal(ctx.calls.modes[0].secureDnsMode, 'automatic', 'DoH down + system DNS up → automatic (mobile policy)');

  // DoH reachable → secure (single probe round, no downgrade).
  ctx = makeContext();
  ctx.fetch = async (url) => {
    if (String(url).includes('generate_204')) throw new Error('unused');
    ctx.calls.dohProbes++;
    return { ok: true, status: 200, json: async () => ({ Answer: [{ data: '104.21.44.172' }] }) };
  };
  load(ctx);
  await ctx.resetNetworkState('resume from sleep');
  assert.equal(ctx.calls.dohProbes, 3, 'reachable DoH needs a single probe round');
  assert.equal(ctx.calls.modes[0].secureDnsMode, 'secure', 'reachable DoH keeps secure mode');

  // A 200 with no DNS answer (captive portal) must not count as reachable.
  ctx = makeContext();
  ctx.fetch = async (url) => {
    if (String(url).includes('generate_204')) return { ok: false, status: 0 };
    ctx.calls.dohProbes++;
    return { ok: true, status: 200, json: async () => ({ Answer: [] }) };
  };
  load(ctx);
  await ctx.resetNetworkState('interface change');
  assert.equal(ctx.calls.modes[0].secureDnsMode, 'secure', 'empty DoH answer is not reachability');

  // ── watcher: debounce collapses a flap burst into one reset ──
  ctx = makeContext();
  load(ctx);
  ctx.watchNetworkChanges();
  assert.equal(ctx.interval.ms, 5000, 'interface poll installed');
  assert.ok(ctx.resume, 'resume listener installed');
  ctx.networkInterfaces = () => ({ 'Wi-Fi': [{ address: '172.20.10.3', family: 'IPv4', internal: false }] });
  ctx.interval.cb(); // switch noticed → 2s debounce
  assert.equal(ctx.timers.length, 1, 'debounce scheduled');
  ctx.networkInterfaces = () => ({ 'Wi-Fi': [{ address: '172.20.10.9', family: 'IPv4', internal: false }] });
  ctx.interval.cb(); // flap mid-debounce → previous timer cancelled
  assert.equal(ctx.timers.length, 1, 'flap collapsed into one pending reset');
  assert.equal(ctx.timers[0].ms, 2000);
  const debounce = ctx.timers.pop();
  await debounce.cb();
  await flush();
  assert.deepEqual(ctx.calls.sent, [['pantoufa:network-changed']], 'one reset for the burst');
  assert.equal(ctx.calls.resolver, 1);

  // Resume from sleep resets even when the IP never changed.
  ctx.resume();
  assert.equal(ctx.timers.length, 1, 'resume schedules a reset');
  const resumeReset = ctx.timers.pop();
  await resumeReset.cb();
  await flush();
  assert.equal(ctx.calls.sent.length, 2, 'resume reset notified');

  // A destroyed window must not break the reset.
  ctx = makeContext();
  ctx.mainWindow.isDestroyed = () => true;
  load(ctx);
  await ctx.resetNetworkState('interface change');
  assert.deepEqual(ctx.calls.sent, [], 'no send to a destroyed window');

  console.log('PASS network-change signature, reset ordering, DoH fallback, and watcher debounce');
})().catch((error) => { console.error(error); process.exitCode = 1; });
