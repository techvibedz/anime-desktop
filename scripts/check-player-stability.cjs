// Player-stability regression guard: the stream engine must not be torn down
// by server-list churn or subtitles. These assertions fail if the resolve /
// wiring effects go back to depending on the `sortedServers` array or the
// `resolved` object (which produced the mid-watch "video reloads by itself"
// bug), or if the player callbacks lose their ref-based stable identity.
const assert = require('node:assert/strict');
const fs = require('node:fs');

const src = fs.readFileSync('src/pages/Watch.tsx', 'utf8');

const callbackBody = (name) => {
  const m = src.match(new RegExp(`const ${name} = useCallback\\(([\\s\\S]*?)\\}\\, \\[([^\\]]*)\\]\\);`));
  assert.ok(m, `${name} useCallback found`);
  return { body: m[1], deps: m[2] };
};

// The refs only hold live values because these sync effects exist; without
// them every activation silently dead-ends (resolve effect early-returns).
for (const decl of [
  'useEffect(() => { sortedServersRef.current = sortedServers; }, [sortedServers]);',
  'useEffect(() => { activeIdxRef.current = activeIdx; }, [activeIdx]);',
  'useEffect(() => { brokenIdsRef.current = brokenIds; }, [brokenIds]);',
]) {
  assert.ok(src.includes(decl), `ref sync effect present: ${decl}`);
}

// ── stable callback identities (refs, not state values, in deps) ──
const activate = callbackBody('activateServer');
assert.match(activate.body, /sortedServersRef\.current/, 'activateServer reads servers via ref');
assert.doesNotMatch(activate.body, /sortedServers\[/, 'activateServer does not close over the array');
assert.equal(activate.deps.trim(), '', 'activateServer identity is stable');

const advance = callbackBody('advanceToNext');
assert.match(advance.body, /activeIdxRef\.current/, 'advanceToNext reads activeIdx via ref');
assert.match(advance.body, /sortedServersRef\.current/, 'advanceToNext reads servers via ref');
assert.equal(advance.deps.trim(), '', 'advanceToNext identity is stable');

const stepDown = callbackBody('stepDownQuality');
assert.match(stepDown.body, /sortedServersRef\.current/, 'stepDownQuality reads servers via ref');
assert.match(stepDown.body, /brokenIdsRef\.current/, 'stepDownQuality reads brokenIds via ref');
assert.equal(stepDown.deps.trim(), 'activateServer', 'stepDownQuality only depends on stable activateServer');

// ── resolve effect: activation-driven, not discovery-driven ──
const stripComments = (s) => s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const resolveEffect = src.match(/Deliberately depends on the activation counter[\s\S]*?\}, \[([^\]]*)\]\);/);
assert.ok(resolveEffect, 'resolve effect found');
const resolveCode = stripComments(resolveEffect[0]);
assert.doesNotMatch(resolveCode, /sortedServers\[/, 'resolve effect does not index the live array');
assert.doesNotMatch(resolveCode, /\bactiveIdx\b/, 'resolve effect does not read activeIdx state');
assert.doesNotMatch(resolveEffect[1], /\bsortedServers\b/, 'resolve effect deps exclude the server list');
assert.doesNotMatch(resolveEffect[1], /\bactiveIdx\b/, 'resolve effect deps exclude the selection index');
assert.equal(
  resolveEffect[1].trim(),
  'userActivated, retryNonce, refreshA3rbPlayerUrl, advanceToNext',
  'resolve effect deps are exactly the activation counter + stable callbacks',
);

// Offline playback must re-wire on a refresh: the offline branch resets
// resolved/status but the resolve effect is activation-keyed now.
const offlineBranch = src.match(/const offline: ServerWithSource = \{[\s\S]*?serverDiscoveryGuardRef\.current\.next\(\);[\s\S]*?\};/);
assert.ok(offlineBranch, 'offline branch found');
assert.match(offlineBranch[0], /setRetryNonce/, 'offline refresh re-triggers the resolve effect');

// ── wiring effect: primitive deps so subtitle attach can't recreate the engine ──
for (const decl of ['const resolvedUrl = resolved?.url;', 'const resolvedType = resolved?.type;', 'const resolvedEmbed = resolved?.embed;']) {
  assert.ok(src.includes(decl), `wiring primitives declared: ${decl}`);
}
assert.ok(
  src.includes('}, [resolvedUrl, resolvedType, resolvedEmbed, advanceToNext, stepDownQuality]);'),
  'wiring effect depends on primitives + stable callbacks, never the resolved object',
);

// ── resume effect must not re-seek on a new resolved object (subtitle attach) ──
assert.ok(src.includes('}, [episodeUrl, resolvedUrl]);'), 'resume effect keys on the stream URL only');

console.log('PASS player stability: stable callbacks, discovery-proof resolve effect, primitive-keyed wiring');
