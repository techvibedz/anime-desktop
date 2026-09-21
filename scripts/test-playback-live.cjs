// Run with Electron: electron scripts/test-playback-live.cjs <server-list.json>
const { app, session, net } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ts = require('typescript');
app.commandLine.appendSwitch('disable-quic');
app.commandLine.appendSwitch('log-level', '3');
app.setPath('userData', path.join(app.getPath('temp'), 'pantoufa-playback-check'));
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  app.configureHostResolver({ secureDnsMode: 'secure', secureDnsServers: ['https://cloudflare-dns.com/dns-query', 'https://dns.google/dns-query'] });
  const { enqueue } = require('../dist-electron/electron/scraper/host.js');
  const scripts = require('../dist-electron/shared/scrape-scripts.js');
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.ts'), 'utf8');
  const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
  const names = ['extractMp4upload', 'unpackPacked'];
  const declarations = [];
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) declarations.push(node.getText(ast));
    ts.forEachChild(node, visit);
  };
  visit(ast);
  const functions = declarations.join('\n');
  const mega = source.slice(source.indexOf('type MegaStream ='), source.indexOf('function proxyUrlFor'));
  const ua = source.match(/const PLAYBACK_UA = "([^"]+)"/)[1];
  const ctx = vm.createContext({ session, net, enqueue, ...scripts, PLAYBACK_UA: ua, VIDEO_PROTOCOL: 'pantoufa-video',
    Buffer, URL, Response, Request, AbortSignal, Uint8Array, console, setTimeout, clearTimeout,
    createDecipheriv: crypto.createDecipheriv, randomBytes: crypto.randomBytes });
  vm.runInContext(ts.transpileModule(mega + '\n' + functions, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, ctx);
  const servers = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).servers;
  let failed = false;
  for (const server of servers.filter((s) => ['mp4upload', 'mega'].includes(s.provider))) {
    const started = Date.now();
    try {
      const result = server.provider === 'mega' ? await ctx.resolveMegaStream(server.iframeUrl) : await ctx.extractMp4upload(server.iframeUrl);
      if (!result?.url) throw Error('No direct media URL');
      const response = server.provider === 'mega'
        ? await ctx.serveMegaStream(new Request(result.url, { headers: { Range: 'bytes=0-63' } }), new URL(result.url))
        : await session.defaultSession.fetch(result.url, { headers: { 'User-Agent': ua, Referer: 'https://www.mp4upload.com/', Range: 'bytes=0-63' }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw Error(`Media HTTP ${response.status}`);
      const reader = response.body.getReader();
      const first = await reader.read();
      await reader.cancel();
      if (!Buffer.from(first.value || []).includes(Buffer.from('ftyp'))) throw Error('Missing MP4 signature');
      console.log(`PASS ${server.provider}: decrypted/direct MP4 in ${Date.now() - started}ms`);
    } catch (error) { failed = true; console.error(`FAIL ${server.provider}: ${error.message}`); }
  }
  app.exit(failed ? 1 : 0);
}).catch((error) => { console.error(error); app.exit(1); });
