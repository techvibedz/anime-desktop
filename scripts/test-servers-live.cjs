// Live provider sweep: run the REAL main-process extractors for every server
// in a JSON list and probe the resulting media.
// Run with Electron: npx electron scripts/test-servers-live.cjs <server-list.json>
const { app, session, net, protocol, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ts = require('typescript');
app.commandLine.appendSwitch('disable-quic');
app.commandLine.appendSwitch('log-level', '3');
app.setPath('userData', path.join(app.getPath('temp'), 'pantoufa-servers-check'));
app.on('window-all-closed', () => {});
// MEGA plays through the custom scheme; register it like the real app does.
protocol.registerSchemesAsPrivileged([{
  scheme: 'pantoufa-video',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true },
}]);
app.whenReady().then(async () => {
  app.configureHostResolver({ secureDnsMode: 'secure', secureDnsServers: ['https://dns.google/dns-query', 'https://cloudflare-dns.com/dns-query'] });
  const { enqueue } = require('../dist-electron/electron/scraper/host.js');
  const scripts = require('../dist-electron/shared/scrape-scripts.js');
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.ts'), 'utf8');
  const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
  const names = [
    'unpackPacked', 'unpackAllPacked', 'providerRefererForHost', 'allowHost', 'isAdHost', 'extractMp4upload',
    'extractAnime4upCdn', 'fetchViaSystemDns', 'parseAnime4upStreamUrl', 'parseAnime4upSubtitles', 'jsonArrayAfter', 'anime4upEdgeHosts',
    'pickHighestHlsVariant',
    'extractDailymotion', 'extractVidea', 'extractVideaXml', 'extractStreamwish', 'extractDood', 'extractVk',
    'extractOkru', 'extractVid3rb', 'extractViaHtml', 'extractViaCapture', 'resolveMegaStream',
  ];
  const declarations = [];
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) declarations.push(node.getText(ast));
    ts.forEachChild(node, visit);
  };
  visit(ast);
  const mega = source.slice(source.indexOf('type MegaStream ='), source.indexOf('function proxyUrlFor'));
  const ua = source.match(/const PLAYBACK_UA = "([^"]+)"/)[1];
  const decoy = source.match(/const DECOY_RE = (\/.+\/i);/)[1];
  const adHost = source.match(/const AD_HOST_RE = (\/.+\/i);/)[1];
  const ctx = vm.createContext({ session, net, enqueue, ...scripts, PLAYBACK_UA: ua, DECOY_RE: eval(decoy),
    AD_HOST_RE: eval(adHost), dynamicAllowedHosts: new Set(), VIDEO_PROTOCOL: 'pantoufa-video',
    Buffer, URL, Response, Request, AbortSignal, AbortController, ReadableStream, Uint8Array, console, setTimeout, clearTimeout, fetch,
    createDecipheriv: crypto.createDecipheriv, randomBytes: crypto.randomBytes });
  vm.runInContext(ts.transpileModule(mega + '\n' + declarations.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, ctx);

  protocol.handle('pantoufa-video', async (request) => {
    const u = new URL(request.url);
    if (u.hostname === 'mega') return ctx.serveMegaStream(request, u);
    return new Response('not found', { status: 404 });
  });

  // Load the renderer's VTT parser so the sweep verifies the exact code the
  // player uses to paint sidecar subtitles.
  const subsModule = { exports: {} };
  const subsCtx = vm.createContext({ module: subsModule, exports: subsModule.exports, console });
  vm.runInContext(
    ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/lib/subtitles.ts'), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText,
    subsCtx,
  );
  const { parseVtt, cueAt } = subsModule.exports;

  // Real <video> playback of the MEGA custom-scheme stream — extraction alone
  // is not enough; the element must decode frames.
  async function playInWindow(url, timeoutMs = 25000) {
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: false } });
    try {
      await win.loadURL('about:blank');
      return await win.webContents.executeJavaScript(`
        new Promise((resolve) => {
          const v = document.createElement('video');
          v.muted = true;
          v.src = ${JSON.stringify(url)};
          const done = (msg) => { v.remove(); resolve(msg); };
          v.addEventListener('loadedmetadata', () => {
            if (v.videoWidth > 0 || v.duration > 0) done('ok ' + v.videoWidth + 'x' + v.videoHeight + ' ' + v.duration.toFixed(1) + 's');
            else done('err no media');
          });
          v.addEventListener('error', () => done('err ' + (v.error && v.error.code)));
          setTimeout(() => done('err timeout'), ${timeoutMs});
          document.body.appendChild(v);
          v.load();
        })
      `);
    } finally {
      win.destroy();
    }
  }

  // Ad-block regression: the anime4up CDN/player hosts live on the .shop TLD
  // the heuristic blocks; extracted hosts must be exempted at runtime.
  if (ctx.isAdHost('cdn1.k1c6x8p.shop') !== true) throw new Error('ad heuristic must flag .shop hosts');
  ctx.allowHost('https://cdn1.k1c6x8p.shop/?token=x');
  if (ctx.isAdHost('cdn1.k1c6x8p.shop') !== false) throw new Error('allowHost must exempt extracted CDN hosts');
  console.log('PASS ad-block allowlist exempts extracted CDN hosts');

  const extractors = {
    mp4upload: (u) => ctx.extractMp4upload(u),
    videa: (u) => ctx.extractVidea(u),
    streamwish: (u) => ctx.extractStreamwish(u),
    doodstream: (u) => ctx.extractDood(u),
    vk: (u) => ctx.extractVk(u),
    okru: (u) => ctx.extractOkru(u),
    vid3rb: (u) => ctx.extractVid3rb(u),
    dailymotion: (u) => ctx.extractDailymotion(u),
    anime4upcdn: (u) => ctx.extractAnime4upCdn(u),
    mega: (u) => ctx.resolveMegaStream(u),
    // Capture-based mirrors: static HTML pass first, headless capture second.
    voe: async (u) => (await ctx.extractViaHtml(u, 'extract:voe')) || ctx.extractViaCapture(u, 'extract:voe', 32000),
    share4max: async (u) => (await ctx.extractViaHtml(u, 'extract:share4max')) || ctx.extractViaCapture(u, 'extract:share4max', 32000),
    streamruby: async (u) => (await ctx.extractViaHtml(u, 'extract:streamruby')) || ctx.extractViaCapture(u, 'extract:streamruby', 32000),
    uqload: async (u) => (await ctx.extractViaHtml(u, 'extract:uqload')) || ctx.extractViaCapture(u, 'extract:uqload', 25000),
  };

  const servers = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).servers;
  let failed = 0;
  const withTimeout = (promise, ms, label) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
  // Hard exit guard so a wedged headless capture can never hang the sweep.
  const guard = setTimeout(() => { console.error('SWEEP TIMED OUT'); app.exit(2); }, 8 * 60 * 1000);
  for (const server of servers) {
    const fn = extractors[server.provider];
    const started = Date.now();
    if (!fn) { console.log(`SKIP ${server.name || server.provider}: no extractor`); continue; }
    try {
      const result = await withTimeout(fn(server.iframeUrl), 75000, server.provider);
      if (!result?.url) throw Error('extraction returned null');
      let probe;
      if (server.provider === 'mega') {
        probe = await ctx.serveMegaStream(new Request(result.url, { headers: { Range: 'bytes=0-63' } }), new URL(result.url));
        const playback = await playInWindow(result.url);
        if (!playback.startsWith('ok')) throw Error(`<video> playback failed: ${playback}`);
        console.log(`  mega <video>: ${playback}`);
      } else {
        probe = await session.defaultSession.fetch(result.url, {
          headers: { 'User-Agent': ua, Range: 'bytes=0-63', Accept: '*/*' },
          signal: AbortSignal.timeout(15000),
        });
        if (probe.ok && /\.m3u8|mpegurl/i.test(result.url + (probe.headers.get('content-type') || ''))) {
          const body = await probe.text();
          if (!body.startsWith('#EXTM3U')) throw Error('not an HLS playlist');
        }
      }
      if (!(probe.ok || probe.status === 206)) throw Error(`probe HTTP ${probe.status}`);
      // Anime4up ships its Arabic subtitle as a sidecar VTT — it must be
      // extracted AND fetchable, or the episode plays without subtitles.
      if (server.provider === 'anime4upcdn') {
        if (!result.subtitles?.length) throw Error('no sidecar subtitles extracted');
        const vtt = await session.defaultSession.fetch(result.subtitles[0].url, {
          headers: { 'User-Agent': ua, Accept: 'text/vtt, */*' },
          signal: AbortSignal.timeout(15000),
        });
        if (!vtt.ok) throw Error(`subtitle HTTP ${vtt.status}`);
        const vttBody = await vtt.text();
        if (!/^WEBVTT/.test(vttBody)) throw Error('subtitle is not a VTT file');
        const cues = (vttBody.match(/-->/g) || []).length;
        if (cues < 10) throw Error(`suspiciously few subtitle cues (${cues})`);
        // The player's own parser must turn it into renderable cues.
        const parsed = parseVtt(vttBody);
        if (parsed.length < 10) throw Error(`parser produced ${parsed.length} cues`);
        if (!cueAt(parsed, parsed[0].start + 0.01)) throw Error('cueAt missed the first cue');
        console.log(`  subtitle: ${result.subtitles[0].label || '?'} ${parsed.length} cues (player parser OK)`);
      }
      console.log(`PASS ${server.provider} (${server.name || ''}): ${result.type || 'hls'} in ${Date.now() - started}ms`);
    } catch (error) {
      failed++;
      console.error(`FAIL ${server.provider} (${server.name || ''}): ${error.message} [${Date.now() - started}ms]`);
    }
  }
  console.log(failed === 0 ? 'ALL PROVIDERS PASSED' : `${failed} provider(s) failed`);
  clearTimeout(guard);
  app.exit(failed === 0 ? 0 : 1);
}).catch((error) => { console.error(error); app.exit(1); });
