const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function run(source, context) {
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
}

(async () => {
  const scraper = fs.readFileSync('src/lib/scraper.ts', 'utf8');
  const gate = scraper.match(/let a3rbLastFetchAt = 0;[\s\S]*?(?=function a3rbSlugify)/)?.[0];
  assert.ok(gate, 'Anime3rb request gate found');
  const starts = [];
  const gateContext = {
    Date, Promise, setTimeout, A3RB_BASE: 'https://anime3rb.com',
    window: { pantoufa: { fetchHtml: async () => { starts.push(Date.now()); return 'ok'; } } },
  };
  run(`${gate}\nglobalThis.a3rbFetch = a3rbFetch;`, gateContext);
  await Promise.all([1, 2, 3].map((n) => gateContext.a3rbFetch(`https://anime3rb.com/episode/test/${n}`)));
  assert.equal(starts.length, 3);
  assert.ok(starts[1] - starts[0] >= 650 && starts[2] - starts[1] >= 650, 'Anime3rb requests stay spaced');

  const main = fs.readFileSync('electron/main.ts', 'utf8');
  const fn = main.match(/async function extractVid3rb\([\s\S]*?(?=function registerVideoProxy)/)?.[0];
  assert.ok(fn, 'Anime3rb player extractor found');
  const playerHtml = 'video_sources = [{"src":"https://video.vid3rb.com/1080.mp4","res":"1080"},{"src":"https://video.vid3rb.com/720.mp4","res":"720"}];';
  let fallbackCalls = 0;
  const playerContext = {
    session: { defaultSession: { fetch: async () => { throw new Error('Chromium DNS unavailable'); } } },
    fetchViaSystemDns: async () => { fallbackCalls++; return playerHtml; },
    PLAYBACK_UA: 'test', AbortSignal, setTimeout, console, URL,
  };
  run(`${fn}\nglobalThis.extractVid3rb = extractVid3rb;`, playerContext);
  const result = await playerContext.extractVid3rb('https://video.vid3rb.com/player/test#vid3rb=720');
  assert.equal(result.url, 'https://video.vid3rb.com/720.mp4');
  assert.equal(fallbackCalls, 1);
  console.log('PASS Anime3rb request spacing and player DNS fallback');
})().catch((error) => { console.error(error); process.exitCode = 1; });
