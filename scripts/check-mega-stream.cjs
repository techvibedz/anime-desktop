// Exercise the production protocol handlers against encrypted bytes, including seeking.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ts = require('typescript');
const path = require('node:path');
const policy = vm.createContext({ exports: {}, URL });
vm.runInContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/lib/videoProviders.ts'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, policy);
assert.equal(policy.exports.validateMediaUrl('pantoufa-video://mega/abcdefghijklmnopqrstuvwx.mp4', 'mega'), true);
assert.equal(policy.exports.validateMediaUrl('pantoufa-video://other/abcdefghijklmnopqrstuvwx.mp4', 'mega'), false);
const source = fs.readFileSync(path.join(__dirname, '../electron/main.ts'), 'utf8');
const section = source.slice(source.indexOf('type MegaStream ='), source.indexOf('function proxyUrlFor'));
const rawKey = crypto.randomBytes(32);
const key = Buffer.from(rawKey.subarray(0, 16).map((byte, i) => byte ^ rawKey[i + 16]));
const nonce = Buffer.alloc(16); rawKey.copy(nonce, 0, 16, 24);
const plain = crypto.randomBytes(4096);
plain.write('ftyp', 4);
const cipher = crypto.createCipheriv('aes-128-ctr', key, nonce);
const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
let failUpstream = false;
const context = vm.createContext({
  Buffer, URL, Response, Request, Uint8Array, AbortSignal, console,
  randomBytes: crypto.randomBytes, createDecipheriv: crypto.createDecipheriv,
  VIDEO_PROTOCOL: 'pantoufa-video',
  net: { fetch: async (_, init) => {
    assert.equal(JSON.parse(init.body)[0].ssl, 2);
    return new Response(JSON.stringify([{ g: 'https://download.test/file', s: plain.length }]));
  } },
  session: { defaultSession: { fetch: async (url, init) => {
    assert.equal(init.headers.Range, undefined);
    const range = url.match(/\/(\d+)-(\d+)$/);
    assert.ok(range, 'MEGA requires a byte range URL');
    if (failUpstream) return new Response('quota', { status: 509 });
    return new Response(encrypted.subarray(+range[1], +range[2] + 1));
  } } },
});
vm.runInContext(ts.transpileModule(section, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
async function main() {
  assert.equal(await context.resolveMegaStream('https://notmega.nz/file/abcdefgh#' + rawKey.toString('base64url')), null);
  const stream = await context.resolveMegaStream('https://mega.nz/embed/abcdefgh#' + rawKey.toString('base64url'));
  assert.ok(stream?.url.startsWith('pantoufa-video://mega/'));
  // Every link shape anime sites circulate must resolve to the same bytes.
  const keyB64url = rawKey.toString('base64url');
  const keyB64 = rawKey.toString('base64');
  const shapes = [
    `https://mega.nz/file/abcdefgh#${keyB64url}`,
    `https://mega.nz/#!/abcdefgh!${keyB64url}`,
    `https://mega.nz/embed#!/abcdefgh!${keyB64url}`,
    `https://mega.nz/embed#abcdefgh!${keyB64url}`,
    `https://mega.nz/file/!abcdefgh!${keyB64url}`,
    `https://mega.nz/file/abcdefgh!${keyB64url}`,
    `https://mega.co.nz/file/abcdefgh#${keyB64url}`,
    `https://mega.nz/file/abcdefgh#${keyB64}`,
    `https://mega.nz/folder/xyz12345/file/abcdefgh#${keyB64url}`,
  ];
  for (const shape of shapes) {
    const s = await context.resolveMegaStream(shape);
    assert.ok(s?.url.startsWith('pantoufa-video://mega/'), `shape must resolve: ${shape}`);
    const r = await context.serveMegaStream(new Request(s.url, { headers: { Range: 'bytes=0-31' } }), new URL(s.url));
    assert.equal(r.status, 206, `shape must decrypt: ${shape}`);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), plain.subarray(0, 32), `shape bytes: ${shape}`);
  }
  for (const [start, end] of [[0, 63], [17, 111], [2049, 4095]]) {
    const response = await context.serveMegaStream(new Request(stream.url, { headers: { Range: `bytes=${start}-${end}` } }), new URL(stream.url));
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('Content-Range'), `bytes ${start}-${end}/${plain.length}`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), plain.subarray(start, end + 1));
  }
  const bad = await context.serveMegaStream(new Request(stream.url, { headers: { Range: 'bytes=8000-' } }), new URL(stream.url));
  assert.equal(bad.status, 416);
  // An evicted/unknown token must signal re-extract, not a dead 404.
  const gone = await context.serveMegaStream(new Request('pantoufa-video://mega/missingtoken12345678.mp4'), new URL('pantoufa-video://mega/missingtoken12345678.mp4'));
  assert.equal(gone.status, 410);
  assert.equal(gone.headers.get('X-Pantoufa-Reextract'), '1');
  failUpstream = true;
  const failed = await context.serveMegaStream(new Request(stream.url), new URL(stream.url));
  assert.equal(failed.status, 502);
  console.log('MEGA production handler: legacy+modern links, decrypt, unaligned seek, invalid range, expired token, upstream failure passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
