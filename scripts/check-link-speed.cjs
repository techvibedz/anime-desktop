// Throughput-aware ranking (src/lib/linkSpeed.ts) + diverse warm-up
// (selectWarmupServers). Regression for "servers are slow / not working":
// a reachable server on a crawling route must rank after one that keeps up,
// siblings on the same crawling box must inherit "slow", and the warm-up must
// reach a second provider instead of resolving three qualities of one.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');

function loadPure(file, extra = {}) {
  const ctx = vm.createContext({ exports: {}, URL, setTimeout, clearTimeout, console, Date, Promise, ...extra });
  vm.runInContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, ctx);
  return ctx.exports;
}

const speed = loadPure(path.join(root, 'src/lib/linkSpeed.ts'), { window: {} });
const providers = loadPure(path.join(root, 'src/lib/videoProviders.ts'));

// vid3rb signs 2.4× the bitrate into speed=.
assert.equal(speed.progressiveNeedKbps('Anime3rb 720p', 'https://video.vid3rb.com/video/x?speed=189&token=t'), 79);
assert.equal(speed.progressiveNeedKbps('Anime3rb 1080p', 'https://example.com/a.mp4'), 180);
assert.equal(speed.progressiveNeedKbps('Some 480p', ''), 45);

// Verdicts: headroom, zero rate = slow, unknown need = no verdict.
assert.equal(speed.verdictOf({ kbps: 79, needKbps: 79, host: 'h', at: Date.now() }), 'slow');
assert.equal(speed.verdictOf({ kbps: 200, needKbps: 79, host: 'h', at: Date.now() }), 'fast');
assert.equal(speed.verdictOf({ kbps: 0, needKbps: 164, host: 'h', at: Date.now() }), 'slow');
assert.equal(speed.verdictOf({ kbps: 50, needKbps: 0, host: 'h', at: Date.now() }), null);

// Host inheritance: a crawling box makes unmeasured siblings slow; a fast box
// re-judges each sibling against its own bitrate.
speed.__resetSpeedForTests();
const s720 = { name: 'Anime3rb 720p', iframeUrl: 'p720', provider: 'vid3rb', source: 'anime3rb' };
const s480 = { name: 'Anime3rb 480p', iframeUrl: 'p480', provider: 'vid3rb', source: 'anime3rb' };
const s1080 = { name: 'Anime3rb 1080p', iframeUrl: 'p1080', provider: 'vid3rb', source: 'anime3rb' };
speed.recordSpeed('p720', { kbps: 23, needKbps: 79, host: 'files-5.vid3rb.com' });
let hosts = speed.groupHosts([s720, s480, s1080]);
assert.equal(hosts.get(speed.groupKey(s480)), 'files-5.vid3rb.com');
assert.equal(speed.serverVerdict(s480, hosts.get(speed.groupKey(s480))), 'slow', '480p on a crawling box inherits slow');
assert.equal(speed.serverVerdict(s1080, hosts.get(speed.groupKey(s1080))), 'slow');

speed.__resetSpeedForTests();
speed.recordSpeed('p480', { kbps: 120, needKbps: 34, host: 'files-2.vid3rb.com' });
hosts = speed.groupHosts([s480, s720, s1080]);
assert.equal(speed.serverVerdict(s720, hosts.get(speed.groupKey(s720))), 'fast', '120KB/s covers 720p (90 × 1.3)');
assert.equal(speed.serverVerdict(s1080, hosts.get(speed.groupKey(s1080))), 'slow', '120KB/s cannot carry 1080p');

// Unresponsive streams rank as slow.
speed.__resetSpeedForTests();
speed.recordUnresponsive('dead');
assert.equal(speed.serverVerdict({ name: 'x', iframeUrl: 'dead', provider: 'vid3rb' }, null), 'slow');

// Subscribers hear new readings (the player re-ranks on them).
let ticks = 0;
const off = speed.subscribeSpeed(() => { ticks++; });
speed.recordSpeed('z', { kbps: 1, needKbps: 1, host: '' });
off();
speed.recordSpeed('z', { kbps: 1, needKbps: 1, host: '' });
assert.equal(ticks, 1);

// Graded tiers: headroom decides the order, not pass/fail (a 52KB/s anime3rb
// 480p at 2× must rank below anime4up at 1.9MB/s).
const at = Date.now();
assert.equal(speed.tierOf({ kbps: 1900, needKbps: 110, host: '', at }), 'great');
assert.equal(speed.tierOf({ kbps: 52, needKbps: 26, host: '', at }), 'good');
assert.equal(speed.tierOf({ kbps: 238, needKbps: 180, host: '', at }), 'ok');
assert.equal(speed.tierOf({ kbps: 66, needKbps: 141, host: '', at }), 'slow');
assert.equal(speed.tierOf(null), null);
assert.ok(speed.tierRank('great') < speed.tierRank('good'));
assert.ok(speed.tierRank('ok') < speed.tierRank(null), 'measured ok outranks unmeasured');
assert.ok(speed.tierRank(null) < speed.tierRank('slow'), 'unmeasured outranks slow');

// File size over runtime is the real bitrate: the 465MB mp4upload "FHD" file
// needs ~323KB/s, not the 180 guessed from its label.
speed.setExpectedDurationSec(null);
assert.equal(speed.progressiveNeedKbps('Mp4upload FHD', 'https://a3.mp4upload.com:183/d/x/video.mp4', 465117205), 315);
speed.setExpectedDurationSec(100 * 60);
assert.equal(speed.progressiveNeedKbps('Movie', 'https://x/video.mp4', 1_200_000_000), 195);
speed.setExpectedDurationSec(null);
assert.equal(speed.progressiveNeedKbps('Anime3rb 720p', 'https://video.vid3rb.com/video/x?speed=189', 465117205), 79, 'vid3rb speed= still wins');
assert.equal(speed.progressiveNeedKbps('Some 480p', '', 1000), 45, 'tiny/unknown size falls back to the label');

// Playback proof beats a probe: a stream that rebuffered ranks slow.
speed.__resetSpeedForTests();
speed.recordSpeed('mp', { kbps: 3000, needKbps: 90, host: 'a3.mp4upload.com' });
assert.equal(speed.serverTier({ name: 'x', iframeUrl: 'mp', provider: 'mp4upload' }, null), 'great');
speed.markPlaybackSlow('mp', 315);
assert.equal(speed.serverTier({ name: 'x', iframeUrl: 'mp', provider: 'mp4upload' }, null), 'slow');
assert.equal(speed.serverVerdict({ name: 'x', iframeUrl: 'mp', provider: 'mp4upload' }, null), 'slow');

// An inherited host reading never vouches for more than "ok".
speed.__resetSpeedForTests();
speed.recordSpeed('p480', { kbps: 2000, needKbps: 34, host: 'files-2.vid3rb.com' });
hosts = speed.groupHosts([s480, s720]);
assert.equal(speed.serverTier(s720, hosts.get(speed.groupKey(s720))), 'ok');

// Warm-up spreads across providers before a second quality of one.
const list = [
  { name: 'Anime3rb 1080p', provider: 'vid3rb', iframeUrl: 'a' },
  { name: 'Anime3rb 720p', provider: 'vid3rb', iframeUrl: 'b' },
  { name: 'Anime3rb 480p', provider: 'vid3rb', iframeUrl: 'c' },
  { name: 'hgcloud FHD', provider: 'streamwish', iframeUrl: 'd' },
  { name: 'megamax', provider: 'share4max', iframeUrl: 'e' },
  { name: 'ok.ru', provider: 'okru', iframeUrl: 'f' },
];
const warm = providers.selectWarmupServers(list, 4).map((s) => s.provider);
assert.deepEqual([...new Set(warm)].length, 4, `warm-up should cover 4 providers, got ${warm}`);
assert.ok(warm.includes('share4max'), 'megamax must be warmed alongside vid3rb');

console.log('check-link-speed: ok');
