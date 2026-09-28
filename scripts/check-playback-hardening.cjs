// Playback hardening checks: proxy chunking (HLS segments must never be
// truncated), user audio intent enforcement, and the anime4up dead-edge
// failover (probe the parsed master, swap to the sibling, deny when neither
// plays). Follows the repo's extract-function-and-run-it-in-a-VM style.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function run(source, context) {
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
}

(async () => {
  const main = fs.readFileSync('electron/main.ts', 'utf8');
  const providers = fs.readFileSync('src/lib/videoProviders.ts', 'utf8');
  const watch = fs.readFileSync('src/pages/Watch.tsx', 'utf8');

  // ── 1. mediaChunkRange: segments whole, progressive chunked ──
  const chunkSrc = main.match(/function mediaChunkRange[\s\S]*?(?=\nfunction registerVideoProxy)/)?.[0];
  assert.ok(chunkSrc, 'mediaChunkRange found');
  const chunkCtx = {};
  run(`${chunkSrc}\nglobalThis.mediaChunkRange = mediaChunkRange;`, chunkCtx);
  const chunk = chunkCtx.mediaChunkRange;
  assert.equal(chunk(true, true, null), 'bytes=0-33554431', 'HLS segment gets a wide 32MB window, never the 1MB truncation');
  assert.equal(chunk(true, true, 'bytes=0-'), 'bytes=0-', 'client byte-range segment Range left untouched');
  assert.equal(chunk(true, false, null), 'bytes=0-1048575', 'progressive first chunk stays 1MB');
  assert.equal(chunk(true, false, 'bytes=0-'), 'bytes=0-1048575', 'progressive open Range capped at first chunk');
  assert.equal(chunk(true, false, 'bytes=1048576-'), 'bytes=1048576-5242879', 'progressive steady chunk capped at 4MB');
  assert.equal(chunk(true, false, 'bytes=100-999'), 'bytes=100-999', 'bounded progressive Range untouched');
  assert.equal(chunk(false, false, 'bytes=0-'), 'bytes=0-', 'non-media Range untouched');

  // ── 2. applyAudioIntent: heal drift without fighting the user ──
  const audioSrc = providers.match(/export function applyAudioIntent[\s\S]*?(?=\n\nexport function createGenerationGuard)/)?.[0]?.replace(/^export /, '');
  assert.ok(audioSrc, 'applyAudioIntent found');
  const audioCtx = {};
  run(`${audioSrc}\nglobalThis.applyAudioIntent = applyAudioIntent;`, audioCtx);
  const apply = audioCtx.applyAudioIntent;
  const drift = { muted: true, volume: 0 };
  assert.equal(apply(drift, { muted: false, volume: 1 }), true, 'element bias muted → restored');
  assert.deepEqual(drift, { muted: false, volume: 1 });
  const userMute = { muted: false, volume: 1 };
  assert.equal(apply(userMute, { muted: true, volume: 1 }), true, 'deliberate user mute enforced after remount');
  assert.equal(userMute.muted, true);
  const clean = { muted: false, volume: 0.4 };
  assert.equal(apply(clean, { muted: false, volume: 0.4 }), false, 'no drift → no change');
  const clamped = { muted: false, volume: 0.5 };
  assert.equal(apply(clamped, { muted: false, volume: 7 }), true, 'out-of-range intent clamped');
  assert.equal(clamped.volume, 1);
  assert.ok(/applyAudioIntent\(v, userAudioIntentRef\.current\)/.test(watch), 'player enforces the audio intent on stream start');
  assert.ok(watch.split('applyAudioIntent(v, userAudioIntentRef.current)').length - 1 >= 2, 'enforced both at wiring and on playing');
  assert.ok((watch.match(/userAudioIntentRef\.current = \{/g) || []).length >= 4, 'every user control records intent');

  // ── 3. anime4upStreamAlive: tri-state, only a real playlist is alive ──
  const aliveSrc = main.match(/async function anime4upStreamAlive[\s\S]*?(?=\nasync function extractAnime4upCdn)/)?.[0];
  assert.ok(aliveSrc, 'anime4upStreamAlive found');
  const makeAliveCtx = (sessionFetch, systemFetch) => {
    const calls = { system: 0 };
    const ctx = {
      PLAYBACK_UA: 'test', AbortSignal, console, calls,
      session: { defaultSession: { fetch: sessionFetch } },
      fetch: async (...args) => { calls.system++; return systemFetch(...args); },
    };
    run(`${aliveSrc}\nglobalThis.anime4upStreamAlive = anime4upStreamAlive;`, ctx);
    return ctx;
  };
  const okPlaylist = { ok: true, status: 200, text: async () => '#EXTM3U\n#EXT-X-STREAM-INF...' };
  const deadEdge = { ok: false, status: 403, text: async () => '<html>blocked</html>' };

  let ctx = makeAliveCtx(async () => okPlaylist, async () => { throw new Error('unused'); });
  assert.equal(await ctx.anime4upStreamAlive('https://cdn2.example/master.m3u8'), 'alive', 'live playlist accepted');
  assert.equal(ctx.calls.system, 0, 'definitive answer needs no system fallback');

  ctx = makeAliveCtx(async () => deadEdge, async () => { throw new Error('unused'); });
  assert.equal(await ctx.anime4upStreamAlive('https://cdn1.example/master.m3u8'), 'dead', '403 edge is definitively dead');
  assert.equal(ctx.calls.system, 0, 'an answered 403 does not retry through the OS resolver');

  ctx = makeAliveCtx(async () => { throw new Error('tarpit'); }, async () => okPlaylist);
  assert.equal(await ctx.anime4upStreamAlive('https://cdn1.example/master.m3u8'), 'alive', 'dead DoH edge rescued by system DNS');

  ctx = makeAliveCtx(async () => { throw new Error('tarpit'); }, async () => deadEdge);
  assert.equal(await ctx.anime4upStreamAlive('https://cdn1.example/master.m3u8'), 'dead', 'system DNS 403 is dead');

  ctx = makeAliveCtx(async () => { throw new Error('tarpit'); }, async () => { throw new Error('offline'); });
  assert.equal(await ctx.anime4upStreamAlive('https://cdn1.example/master.m3u8'), 'unknown', 'unanswered probe is unknown, not dead');

  ctx = makeAliveCtx(async () => ({ ok: true, status: 200, text: async () => '<html>not a playlist</html>' }), async () => { throw new Error('unused'); });
  assert.equal(await ctx.anime4upStreamAlive('https://cdn1.example/master.m3u8'), 'dead', 'non-playlist 200 is dead');

  // Static: the extractor must allow the host BEFORE probing (the ad blocker
  // would cancel the probe), probe the primary, retry the sibling with a
  // probe, and deny when neither plays (so the player advances instead of
  // painting a broken iframe).
  const extractSrc = main.match(/async function extractAnime4upCdn[\s\S]*?(?=\n\/\/ Some ISPs and poisoned)/)?.[0];
  assert.ok(extractSrc, 'extractAnime4upCdn found');
  assert.ok(extractSrc.indexOf('allowHost(stream);') < extractSrc.indexOf('anime4upStreamAlive(stream)'), 'primary host allowed before its probe');
  assert.match(extractSrc, /if \(\(await anime4upStreamAlive\(stream\)\) === "dead"\)/, 'only a definitive dead primary is dropped');
  assert.match(extractSrc, /if \(siblingStream && siblingStream !== primaryStream\)/, 'sibling probed only when it is a different stream');
  assert.match(extractSrc, /\(await anime4upStreamAlive\(siblingStream\)\) !== "dead"/, 'unknown sibling attempted, dead sibling skipped');
  assert.match(extractSrc, /refused \|\| streamDead/, 'dead edge is reported as denied');
  assert.match(extractSrc, /if \(!stream && html && siblingUrl/, 'sibling tried only when the primary page actually loaded');

  console.log('PASS playback hardening: segment chunking, audio intent, anime4up dead-edge failover');
})().catch((error) => { console.error(error); process.exitCode = 1; });
