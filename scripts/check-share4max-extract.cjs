const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const ast = ts.createSourceFile('main.ts', fs.readFileSync('electron/main.ts','utf8'), ts.ScriptTarget.Latest, true);
let declaration;
function find(n) { if (ts.isFunctionDeclaration(n) && n.name?.text === 'extractShare4max') declaration=n; ts.forEachChild(n,find); }
find(ast); assert.ok(declaration);
const calls=[];
const context={URL,AbortSignal,console,PLAYBACK_UA:'test',
  session:{defaultSession:{fetch:async(url,init)=>{
    if(init.headers['X-Inertia']==='true') {
      assert.equal(init.headers['X-Inertia-Version'],'live');
      assert.equal(init.headers['X-Inertia-Partial-Component'],'Iframe');
      return Response.json({props:{streams:{data:[{label:'720p',mirrors:[{driver:'mp4upload',link:'https://www.mp4upload.com/low'}]},{label:'1080p',mirrors:[{driver:'mp4upload',link:'http://['},{driver:'mp4upload',link:'https://evil.example/x'},{driver:'mp4upload',link:'https://www.mp4upload.com/high'}]}]}}});
    }
    return new Response('<script data-page="app">{"version":"live","component":"Iframe"}</script>');
  }}},
  extractMp4upload:async(url)=>({url:`https://s99.mp4upload.com/${url.endsWith('high')?'high':'low'}.mp4`,type:'mp4'}),
  fetch:async(url,init)=>{calls.push(url);assert.equal(init.headers.Referer,'https://www.mp4upload.com/');assert.equal(init.headers.Range,'bytes=0-1');return new Response(null,{status:url.includes('high')?403:206});},
};
vm.runInNewContext(ts.transpileModule(declaration.getText(ast)+'\nglobalThis.extractShare4max=extractShare4max;', {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
(async()=>{
  assert.equal((await context.extractShare4max('https://share4max.com/iframe/example')).url,'https://s99.mp4upload.com/low.mp4');
  assert.deepEqual(calls,['https://s99.mp4upload.com/high.mp4','https://s99.mp4upload.com/low.mp4']);
  console.log('PASS Megamax quality fallback, partial manifest and malformed mirror rejection');
})().catch(error=>{console.error(error);process.exitCode=1;});
