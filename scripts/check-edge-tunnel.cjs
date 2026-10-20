// Edge tunnel: a black-holed address must not stall a reachable one, and
// CONNECT must pipe bytes end to end.
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync('electron/edgeTunnel.ts', 'utf8');
const tunnel = {};
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText,
  { exports: tunnel, require, setTimeout, clearTimeout, URL, AbortSignal, fetch, Date, Error, Promise, Number });

(async () => {
  const echo = net.createServer((s) => s.pipe(s));
  await new Promise((r) => echo.listen(0, '127.0.0.1', r));
  const port = echo.address().port;

  // A connect that never answers (TEST-NET-1 is unroutable) must be hedged past.
  const started = Date.now();
  const socket = await tunnel.connectHost('example.test', port, [Promise.resolve(['192.0.2.1']), Promise.resolve(['127.0.0.1'])]);
  assert.ok(Date.now() - started < 2000, 'black-holed edge did not stall the reachable one');
  assert.equal(socket.remoteAddress, '127.0.0.1');
  socket.destroy();

  // The last good address is tried first next time.
  const again = Date.now();
  (await tunnel.connectHost('example.test', port, [Promise.resolve(['192.0.2.1', '127.0.0.1'])])).destroy();
  assert.ok(Date.now() - again < 250, 'remembered good edge is tried first');

  await assert.rejects(tunnel.connectHost('nothing.test', port, [Promise.resolve([])]), /no reachable address/);

  // CONNECT through the tunnel reaches the echo server.
  const tunnelPort = await tunnel.startEdgeTunnel();
  const reply = await new Promise((resolve, reject) => {
    const c = net.connect(tunnelPort, '127.0.0.1', () => c.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`));
    let buf = '';
    c.on('data', (d) => {
      buf += d;
      if (buf.includes('\r\n\r\n') && !buf.includes('ping')) c.write('ping');
      if (buf.endsWith('ping')) { c.destroy(); resolve(buf); }
    });
    c.on('error', reject);
  });
  assert.match(reply, /^HTTP\/1\.1 200/);
  echo.close();
  console.log('PASS edge tunnel: hedged connect past black-holed edge, good-edge memory, CONNECT piping');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
