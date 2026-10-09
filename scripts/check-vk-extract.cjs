const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const source = fs.readFileSync('electron/main.ts', 'utf8');
const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
let declaration;
function find(n) {
  if (ts.isFunctionDeclaration(n) && n.name?.text === 'extractVk') declaration = n;
  ts.forEachChild(n, find);
}
find(ast);
assert.ok(declaration, 'actual VK extractor found');
const fn = declaration.getText(ast);
const primary = 'https://vkvd196.okcdn.ru/?sig=valid&expires=1791800000';
const alternate = primary.replace('vkvd196', 'vkvd296');
let blocked = false, failover = 'vkvd296.okcdn.ru';
const calls = [];
const context = { URL, AbortSignal, Set, console, DECOY_RE:/sample[-_.]/,
  PLAYBACK_UA:'test',
  session:{defaultSession:{fetch:async(url)=>{assert.ok(url.startsWith('https://vk.com/video_ext.php'));return new Response(JSON.stringify({files:{mp4_1080:primary,failover_host:failover}}));}}},
  fetch:async(url,options)=>{calls.push(url);assert.equal(options.headers.Range,'bytes=0-1');return new Response(null,{status:blocked&&url===primary?403:206});},
  extractViaCapture:async()=>({url:'https://cdn.example.com/browser.m3u8',type:'hls'}),
};
vm.runInNewContext(ts.transpileModule(fn+'\nglobalThis.extractVk=extractVk;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
(async()=>{
  assert.equal((await context.extractVk('https://vkvideo.ru/video_ext.php?id=1')).url,primary);
  blocked=true;calls.length=0;
  assert.equal((await context.extractVk('https://vkvideo.ru/video_ext.php?id=1')).url,alternate);
  assert.deepEqual(calls,[primary,alternate]);
  failover='okcdn.ru.evil.example';calls.length=0;
  assert.equal((await context.extractVk('https://vkvideo.ru/video_ext.php?id=1')).type,'hls');
  assert.ok(!calls.some(url=>url.includes('evil.example')));
  console.log('PASS VK progressive keys, reachable fallback, signed query and unsafe-host rejection');
})().catch(error=>{console.error(error);process.exitCode=1;});
