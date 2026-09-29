// Host throttle + direct-extract dedupe: a 429/503 records a per-hostname
// cooldown (server Retry-After honoured, 1.5s floor, 30s cap) that every
// player-page fetch awaits, and concurrent pantoufa:direct-extract calls for
// one provider+URL share a single extraction promise. Follows the repo's
// extract-and-run-it-in-a-VM style (see check-playback-hardening.cjs).
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
  const blockSrc = main.match(/\/\/ ── Host throttle[\s\S]*?(?=\nasync function anime4upStreamAlive)/)?.[0];
  assert.ok(blockSrc, 'host-throttle block found in main.ts');

  const makeCtx = () => {
    const ctx = {
      now: 1_000_000,
      waits: [],
      Map, Promise, Math, URL, console,
      Date: { now: () => ctx.now, parse: Date.parse },
      setTimeout: (cb, ms) => { ctx.waits.push(ms); cb(); return 0; },
      clearTimeout: () => {},
    };
    run(
      `${blockSrc}\nglobalThis.hostThrottleUntil = hostThrottleUntil;\nglobalThis.noteHostThrottle = noteHostThrottle;\nglobalThis.hostCooldownRemaining = hostCooldownRemaining;\nglobalThis.awaitHostCooldown = awaitHostCooldown;\nglobalThis.dedupeInFlight = dedupeInFlight;`,
      ctx,
    );
    return ctx;
  };

  // ── recording: 1.5s floor, Retry-After honoured, 30s cap ──
  const ctx = makeCtx();
  ctx.noteHostThrottle('a.example', null);
  assert.equal(ctx.hostCooldownRemaining('a.example'), 1500, 'no Retry-After → 1.5s floor');
  ctx.noteHostThrottle('b.example', 4000);
  assert.equal(ctx.hostCooldownRemaining('b.example'), 4000, 'Retry-After honoured');
  ctx.noteHostThrottle('c.example', 90_000);
  assert.equal(ctx.hostCooldownRemaining('c.example'), 30_000, 'cooldown capped at 30s');
  ctx.noteHostThrottle('d.example', 0);
  assert.equal(ctx.hostCooldownRemaining('d.example'), 1500, 'zero delay still floors at 1.5s');

  // ── expiry: countdown runs on the clock, expired entries are dropped ──
  ctx.now += 1000;
  assert.equal(ctx.hostCooldownRemaining('b.example'), 3000, 'remaining shrinks with the clock');
  ctx.now += 3000;
  assert.equal(ctx.hostCooldownRemaining('b.example'), 0, 'expired cooldown reports zero');
  assert.equal(ctx.hostThrottleUntil.has('b.example'), false, 'expired entry deleted');
  assert.equal(ctx.hostCooldownRemaining('cold.example'), 0, 'unknown host is never cooling');

  // ── awaitHostCooldown: waits out the cooldown, bounded by capMs ──
  ctx.noteHostThrottle('w.example', 4000);
  await ctx.awaitHostCooldown('https://w.example/Anime4up-S1/mal/1/1/sub/', 5000);
  assert.deepEqual(ctx.waits, [4000], 'awaits the full remaining window under the cap');
  ctx.noteHostThrottle('x.example', 4000);
  await ctx.awaitHostCooldown('x.example', 1000);
  assert.deepEqual(ctx.waits, [4000, 1000], 'capMs bounds a long cooldown');
  await ctx.awaitHostCooldown('cold.example');
  assert.deepEqual(ctx.waits, [4000, 1000], 'no cooldown → no wait');

  // ── dedupeInFlight: concurrent calls share one promise, cleared on settle ──
  const inflight = new Map();
  let created = 0;
  let release;
  const factory = () => { created++; return new Promise((r) => { release = r; }); };
  const first = ctx.dedupeInFlight(inflight, 'p|u', factory);
  const second = ctx.dedupeInFlight(inflight, 'p|u', factory);
  assert.equal(first, second, 'concurrent callers share the one promise');
  assert.equal(created, 1, 'factory runs once');
  release('value');
  assert.equal(await first, 'value', 'callers get the original resolution shape');
  await flush();
  assert.equal(inflight.has('p|u'), false, 'entry removed after settle');
  const third = ctx.dedupeInFlight(inflight, 'p|u', () => { created++; return Promise.resolve('fresh'); });
  assert.notEqual(third, first, 'a settled call no longer dedupes');
  assert.equal(await third, 'fresh');
  assert.equal(created, 2, 'third call runs the factory again');

  // A rejected extraction is shared, then evicted so the next call retries.
  let rejected = 0;
  const bad = ctx.dedupeInFlight(inflight, 'r|x', () => { rejected++; return Promise.reject(new Error('boom')); });
  assert.equal(ctx.dedupeInFlight(inflight, 'r|x', () => { rejected++; return Promise.resolve('nope'); }), bad, 'concurrent rejection is shared');
  await bad.catch((e) => assert.equal(e.message, 'boom'));
  await flush();
  assert.equal(inflight.has('r|x'), false, 'rejected entry removed after settle');
  assert.equal(await ctx.dedupeInFlight(inflight, 'r|x', () => { rejected++; return Promise.resolve('retry'); }), 'retry');
  assert.equal(rejected, 2, 'rejected extraction is not cached');

  // ── wiring: the real call sites consult/record ──
  assert.ok(/awaitHostCooldown\(opts\.url\)/.test(main), 'fetch-html awaits the cooldown before each attempt');
  assert.ok(/noteHostThrottle\(hostFrom\(opts\.url\), retryAfter\)/.test(main), 'fetch-html records 429/503 cooldowns');
  assert.ok(/awaitHostCooldown\(url\)/.test(main), 'extractAnime4upCdn awaits the cooldown before its player fetch');
  assert.ok(/noteHostThrottle\(hostFrom\(url\), retryAfter\)/.test(main), 'extractAnime4upCdn records 429/503 cooldowns');
  assert.ok(/awaitHostCooldown\(playerUrl\)/.test(main), 'extractVid3rb awaits the cooldown before each attempt');
  assert.ok(/noteHostThrottle\(hostFrom\(playerUrl\), retryAfter\)/.test(main), 'extractVid3rb records 429/503 cooldowns');
  assert.ok(
    /dedupeInFlight\(\s*directExtractInFlight,\s*`\$\{opts\.provider\}\|\$\{opts\.iframeUrl\}\|\$\{opts\.background \? "bg" : "fg"\}`,/.test(main)
      && (main.match(/awaitHostCooldown\(opts\.url\)/g) || []).length >= 2,
    'direct-extract dedupes concurrent identical extractions, keyed by class (fg/bg) and gated on the edge path too',
  );

  console.log('PASS host throttle: cooldown floor/cap/expiry, await cap, in-flight dedupe');
})().catch((error) => { console.error(error); process.exitCode = 1; });
