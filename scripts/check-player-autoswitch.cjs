// Auto-switch walk regression guard. The bug this locks down: a failed server's
// broken mark was keyed on a merge-recomputed id, so a discovery re-emission or
// vid3rb token refresh resurrected it — the player ping-ponged between two
// servers ("server failed — auto-switching") and hammered rate-limited sources
// (429) forever. Guards: failure identity agrees with the merge identity
// (token/param volatile, slash/hash normalized), skip-the-current-server,
// bounded walk with capped backoff, full-list recovery only after a long pause.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');

function loadPure(file) {
  const ctx = vm.createContext({ exports: {}, URL, setTimeout, clearTimeout });
  vm.runInContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, ctx);
  return ctx.exports;
}

const {
  serverFailureKey, pickNextServer, autoSwitchDelayMs, recoveryDelayMs, mergeVideoServers,
} = loadPure(path.join(root, 'src/lib/videoProviders.ts'));

// ── serverFailureKey: agrees with the merge identity ──
const a3rb720Stale = { provider: 'vid3rb', iframeUrl: 'https://video.vid3rb.com/player/abc?token=AAA&expires=111#vid3rb=720' };
const a3rb720Fresh = { provider: 'vid3rb', iframeUrl: 'https://video.vid3rb.com/player/abc?token=BBB&expires=222#vid3rb=720' };
const a3rb1080 = { provider: 'vid3rb', iframeUrl: 'https://video.vid3rb.com/player/abc?token=AAA&expires=111#vid3rb=1080' };
assert.equal(serverFailureKey(a3rb720Stale), serverFailureKey(a3rb720Fresh), 'rotated token keeps the same failure key');
assert.notEqual(serverFailureKey(a3rb720Stale), serverFailureKey(a3rb1080), 'each vid3rb quality is its own failure key');
assert.equal(
  serverFailureKey({ provider: 'anime4upcdn', iframeUrl: 'https://anime4up-s1.example/mal/1/2/sub/' }),
  serverFailureKey({ provider: 'generic', iframeUrl: 'https://anime4up-s1.example/mal/1/2/sub' }),
  'slash form and provider re-classification do not change the key (merge identity agreement)',
);

// Merge-agreement, exercised on the real merge: a row stored as /sub and a
// re-emission as /sub/ dedupe to ONE row whose URL is the first form seen;
// the failure mark made against either form must exclude the merged row.
const staleRow = { name: 'Anime4up 1', provider: 'anime4upcdn', iframeUrl: 'https://w1.anime4up.rest/Anime4up-S1/mal/1/2/sub' };
const freshForm = { name: 'Anime4up 1', provider: 'anime4upcdn', iframeUrl: 'https://w1.anime4up.rest/Anime4up-S1/mal/1/2/sub/' };
const merged = mergeVideoServers([[freshForm], [staleRow]]);
assert.equal(merged.length, 1, 'slash forms merge to one row');
assert.equal(
  new Set([serverFailureKey(staleRow)]).has(serverFailureKey(merged[0])),
  true,
  'a mark made against one URL form catches the merged row (the re-emission resurrection)',
);

// ── pickNextServer: skips broken + current, -1 when the walk is exhausted ──
const servers = [
  { provider: 'vid3rb', iframeUrl: 'https://video.vid3rb.com/player/abc?token=AAA#vid3rb=720' },
  { provider: 'anime4upcdn', iframeUrl: 'https://anime4up-s1.example/mal/1/2/sub/' },
  { provider: 'anime4upcdn', iframeUrl: 'https://anime4up-s2.example/mal/1/2/sub/' },
];
const broken = new Set([serverFailureKey(servers[0])]);
assert.equal(pickNextServer(servers, broken, null), 1, 'first non-broken server is picked');
assert.equal(pickNextServer(servers, broken, servers[1].iframeUrl), 2, 'current server is skipped even when unmarked (offline-failure case)');
assert.equal(pickNextServer(servers, new Set(servers.map((s) => serverFailureKey(s))), null), -1, 'all broken → no candidate, walk stops');

// The stale-mark case: the vid3rb row was refreshed in place (new token), the
// mark was made against the stale URL — the refreshed row must still be excluded.
const refreshed = [a3rb720Fresh, ...servers.slice(1)];
assert.equal(pickNextServer(refreshed, broken, null), 1, 'a mark survives the in-place token refresh');

// ── backoff dynamics: growth + caps ──
assert.equal(autoSwitchDelayMs(1), 1200, 'first switch waits 1.2s');
assert.equal(autoSwitchDelayMs(2), 2400, 'wait doubles per consecutive failure');
assert.equal(autoSwitchDelayMs(4), 9600, 'growth stays capped');
assert.equal(autoSwitchDelayMs(50), 9600, 'cap holds');
assert.equal(recoveryDelayMs(0), 45_000, 'first full-list recovery waits 45s');
assert.equal(recoveryDelayMs(1), 90_000, 'recovery wait doubles per failed round');
assert.equal(recoveryDelayMs(10), 300_000, 'recovery wait caps at 5min');

// ── static wiring: the walk must use the helpers + recovery timer ──
const watch = fs.readFileSync(path.join(root, 'src/pages/Watch.tsx'), 'utf8');
assert.match(watch, /if \(!brokenIdsRef\.current\.has\(key\)\) autoSwitchCountRef\.current \+= 1;/, 'failure counter grows on real failures only');
assert.match(watch, /pickNextServer\(sortedServers, brokenIds, activeServerUrlRef\.current\)/, 'walk selects via pickNextServer against the stable set');
assert.match(watch, /every server failed — retrying the full list/, 'all-failed pauses and retries the full list');
assert.match(watch, /autoSwitchDelayMs\(autoSwitchCountRef\.current\)/, 'switch delay comes from the tested backoff helper');
assert.match(watch, /recoveryDelayMs\(recoveryRoundRef\.current\)/, 'recovery delay comes from the tested backoff helper');
assert.match(watch, /autoAdvanceTargetRef\.current === targetUrl/, 'pending switch survives discovery re-runs');
assert.match(watch, /if \(status !== "failed" \|\| !userActivated \|\| isOffline\)/, 'offline failure never auto-walks');

console.log('PASS player auto-switch: identity agreement, bounded walk, capped backoff, full-list recovery');
