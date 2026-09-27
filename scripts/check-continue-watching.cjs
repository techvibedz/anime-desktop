// Desktop continue-watching round-trip: watch → card → X → simulated renderer
// RELOAD → card must stay hidden; watching again must bring it back.
// Run:  node scripts/check-continue-watching.cjs

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// localStorage shim that survives a "reload" (module cache reset, same store).
const storageMap = new Map();
const localStorageShim = {
  getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
  setItem: (k, v) => { storageMap.set(k, String(v)); },
  removeItem: (k) => { storageMap.delete(k); },
};

let cloudRows = [];
const user = { id: 'user-1' };
const fakeSupabase = {
  auth: { getUser: async () => ({ data: { user } }) },
  from: () => ({
    select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: cloudRows, error: null }) }) }) }),
    upsert: async (row) => {
      const i = cloudRows.findIndex((r) => r.episode_href === row.episode_href);
      if (i >= 0) cloudRows[i] = { ...cloudRows[i], ...row };
      else cloudRows.push({ ...row });
      return { error: null };
    },
    delete: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
  }),
};

let moduleCache = {};
function load(file) {
  const key = file;
  if (moduleCache[key]) return moduleCache[key];
  const exports = {};
  moduleCache[key] = exports;
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  new Function('require', 'exports', code)((name) => {
    if (name === './storage') return { storage: localStorageShim };
    if (name === './supabase') return { isSupabaseConfigured: true, supabase: fakeSupabase };
    throw Error(`unexpected import: ${name}`);
  }, exports);
  return exports;
}
const reload = () => { moduleCache = {}; return load(path.join('src/lib/history.ts')); };

(async () => {
  let h = load(path.join('src/lib/history.ts'));
  const ep5 = 'https://witanime.site/watch/some-anime/5';
  const ep4 = 'https://witanime.site/watch/some-anime/4';
  const meta = {
    episodeTitle: 'الحلقة 5',
    animeTitle: 'Some Anime',
    animeHref: 'https://witanime.site/anime/some-anime',
    image: '',
    epNum: 5,
  };

  // 1. Watch → the card appears and syncs to the cloud.
  await h.saveProgress({ ...meta, episodeHref: ep5, positionMs: 120000, durationMs: 1400000 });
  await h.saveProgress({ ...meta, episodeTitle: 'الحلقة 4', epNum: 4, episodeHref: ep4, positionMs: 60000, durationMs: 1400000 });
  assert.equal((await h.getContinueWatching()).length, 1, 'card after watching');
  await new Promise((r) => setTimeout(r, 10));

  // 2. X → hidden immediately, and hidden after a page refresh.
  await h.dismissFromContinue(ep4);
  assert.equal((await h.getContinueWatching()).length, 0, 'hidden right after dismiss');
  h = reload();
  assert.equal((await h.getContinueWatching()).length, 0, 'STILL hidden after refresh');

  // 3. A fresh cloud pull (Home mount) must not resurrect it.
  await h.pullHistoryFromCloud();
  assert.equal((await h.getContinueWatching()).length, 0, 'still hidden after cloud pull');

  // 4. Watching again brings it back (even after another reload).
  await h.saveProgress({ ...meta, episodeHref: ep5, positionMs: 300000, durationMs: 1400000 });
  h = reload();
  await h.pullHistoryFromCloud();
  const row = await h.getContinueWatching();
  assert.equal(row.length, 1, 're-watch brings the card back');
  assert.equal(row[0].positionMs, 300000, 'progress saved');

  console.log('desktop continue-watching checks passed');
  console.log('cloud rows:', cloudRows.map((r) => `${r.episode_href.slice(-1)} pos=${r.position_ms} dismissed=${r.dismissed}`).join(' | '));
})().catch((error) => { console.error(error); process.exitCode = 1; });
