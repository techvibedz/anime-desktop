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
  const { isIP } = require('node:net');
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

  // Source-edge resolution: Google's answer for anime4up/anime3rb is the parked
  // black-hole anycast (188.114.96/97.x); Cloudflare's is the reachable edge.
  // The resolver must probe Cloudflare's answers first, step over a black-holed
  // candidate, and never waste a probe on the parked IP while a real edge answers.
  const edgeFn = main.match(/let sourceEdgeIpsPromise[\s\S]*?(?=\/\/ Pull the real \.mp4 URL)/)?.[0];
  assert.ok(edgeFn, 'Source edge resolver found');
  const { EventEmitter } = require('node:events');
  const probes = [];
  const edgeContext = {
    isIP, AbortSignal, Promise, Set, URL, Buffer, Math, console, setTimeout, clearTimeout,
    fetch: async (url) => ({
      json: async () => (url.includes('cloudflare')
        ? { Answer: [{ data: '172.67.201.154' }, { data: '104.21.44.172' }] }
        : { Answer: [{ data: '188.114.96.7' }] }),
    }),
    https: {
      get: (url, opts, cb) => {
        let ip = null;
        if (opts.lookup) opts.lookup('host', {}, (_e, addr) => { ip = addr; });
        probes.push(ip);
        const req = new EventEmitter();
        req.destroy = () => req.emit('error', new Error('socket hang up'));
        if (ip === '104.21.44.172') {
          setImmediate(() => {
            const res = new EventEmitter();
            res.statusCode = 200;
            cb(res);
            res.emit('data', Buffer.from('EDGE-OK'));
            res.emit('end');
          });
        } else {
          setTimeout(() => req.emit('timeout'), 5);
        }
        return req;
      },
    },
  };
  run(`${edgeFn}\nglobalThis.fetchSourceViaWorkingEdge = fetchSourceViaWorkingEdge;`, edgeContext);
  const edgeBody = await edgeContext.fetchSourceViaWorkingEdge('https://w1.anime4up.rest/episode/', {}, 5000);
  assert.equal(edgeBody, 'EDGE-OK', 'reachable edge serves the request');
  assert.deepEqual(probes, ['172.67.201.154', '104.21.44.172'], 'Cloudflare answers probed first, parked IP never touched');
  // Self-calibration: the edge that answered goes to the front of the list.
  await edgeContext.fetchSourceViaWorkingEdge('https://w1.anime4up.rest/episode/', {}, 5000);
  assert.deepEqual(probes.slice(2), ['104.21.44.172'], 'working edge remembered');
  console.log('PASS Anime3rb request spacing, player DNS fallback, and source-edge probing');
})().catch((error) => { console.error(error); process.exitCode = 1; });
