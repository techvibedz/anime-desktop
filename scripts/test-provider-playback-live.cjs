// Exercise the real main-process IPC, proxy, and Chromium decoder with live sources.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
app.setPath('userData', path.join(app.getPath('temp'), 'pantoufa-provider-e2e'));
app.on('browser-window-created', (_e, win) => win.on('show', () => win.hide()));
const handlers = new Map();
const register = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (name, handler) => { handlers.set(name, handler); register(name, handler); };
require('../dist-electron/electron/main.js');
const pause = ms => new Promise(r => setTimeout(r, ms));
const invoke = (name, ...args) => handlers.get(name)({}, ...args);
const watch = fs.readFileSync(path.join(__dirname, '../src/pages/Watch.tsx'), 'utf8');
const ast = ts.createSourceFile('Watch.tsx', watch, ts.ScriptTarget.Latest, true);
const proxifySource = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'proxify').getText(ast);
let wiringEffect;
function findWiring(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect' && node.arguments[1]?.getText(ast) === '[resolvedUrl, resolvedType, resolvedEmbed, advanceToNext, stepDownQuality]') wiringEffect = node.getText(ast);
  ts.forEachChild(node, findWiring);
}
findWiring(ast);
if (!wiringEffect) throw Error('Watch playback effect not found');
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const providerHelpers = compile(fs.readFileSync(path.join(__dirname, '../src/lib/videoProviders.ts'), 'utf8'));
const playerWiring = compile(proxifySource + '\n' + wiringEffect);
const guard = setTimeout(() => { console.error('FAIL live test timeout'); app.exit(2); }, 12 * 60 * 1000);
app.whenReady().then(async () => {
  fs.mkdirSync(path.join(app.getPath('temp'), 'pantoufa-e2e'), { recursive: true });
  const devServer = require('node:http').createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html><body style="background:black"></body></html>');
  });
  await new Promise(resolve => devServer.listen(0, '127.0.0.1', resolve));
  const devOrigin = `http://127.0.0.1:${devServer.address().port}`;
  while (!handlers.has('pantoufa:wit-servers')) await pause(100);
  const wit = process.env.PANTOUFA_SKIP_WIT ? null : await invoke('pantoufa:wit-servers', 'https://witanime.site/watch/one-piece/1180');
  const script = require('../dist-electron/shared/scrape-scripts.js').EXTRACT_VIDEO_SERVERS;
  const up4 = process.env.PANTOUFA_SKIP_UP4 ? null : await invoke('pantoufa:scrape', { url:'https://w1.anime4up.rest/episode/انمي-ون-بيس-one-piece-الحلقة-1180-مترجمة/', injectAfter:script, priority:true, timeoutMs:60000 });
  const fixtureData = process.env.PANTOUFA_SERVER_FIXTURES ? JSON.parse(fs.readFileSync(process.env.PANTOUFA_SERVER_FIXTURES,'utf8')) : [];
  const samples = fixtureData.servers || fixtureData;
  const servers = [...(wit?.servers || []), ...(up4?.servers || []), ...samples];
  fs.writeFileSync(path.join(app.getPath('temp'), 'pantoufa-e2e/desktop-live-servers.json'), JSON.stringify({ servers }, null, 2));
  console.log('DISCOVERED', JSON.stringify(servers.map(s => ({ name:s.name, provider:s.provider, iframeUrl:s.iframeUrl }))));
  let failed = 0;
  for (const provider of (process.env.PANTOUFA_PROVIDERS?.split(',') || ['share4max', 'vk', 'streamwish', 'videa', 'videas', 'mega', 'vikingfile'])) {
    const server = servers.find(s => s.provider === provider);
    if (!server) { console.error('FAIL no live example', provider); failed++; continue; }
    const win = new BrowserWindow({ show:false, width:960, height:540, webPreferences:{ sandbox:false, backgroundThrottling:false, autoplayPolicy:'no-user-gesture-required' } });
    win.webContents.on('console-message',(_event,level,message)=>console.log('PLAYER-CONSOLE',provider,message));
    try {
      const resolved = await invoke('pantoufa:direct-extract', { provider, iframeUrl:server.iframeUrl, background:false });
      if (!resolved?.url) {
        throw Error('direct extraction returned null');
      }
      await invoke('pantoufa:set-video-referer', server.iframeUrl);
      win.webContents.setUserAgent(`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`);
      const playerHtml=path.join(app.getPath('temp'),'pantoufa-e2e/provider-player.html');
      fs.writeFileSync(playerHtml,'<!doctype html><html><body style="background:black"></body></html>');
      if (provider === 'videa') await win.loadURL(devOrigin);
      else await win.loadFile(playerHtml);
      console.log('PLAYER-READY',provider);
      win.webContents.debugger.attach('1.3');
      const evaluate=async expression=>{
        const r=await Promise.race([win.webContents.debugger.sendCommand('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true}),pause(10000).then(()=>{throw Error('renderer evaluation timeout '+expression.slice(0,50));})]);
        if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result?.value;
      };
      await evaluate(fs.readFileSync(path.join(__dirname, '../node_modules/hls.js/dist/hls.min.js'), 'utf8')+'\n;true;');
      console.log('PLAYER-LIBRARY',provider);
      await evaluate(`(()=>{
        const video=window.testVideo=document.createElement('video');video.muted=true;document.body.appendChild(video);
        const startedAt=performance.now();video.addEventListener('playing',()=>{window.testFirstFrameMs=performance.now()-startedAt;},{once:true});
        const {STREAM_BUFFER_POLICY,applyAudioIntent,bufferAheadSeconds} = (()=>{const exports={};${providerHelpers};return exports;})();
        const OriginalHls=window.Hls;window.testHlsErrors=[];
        const Hls=class extends OriginalHls{
          constructor(...args){super(...args);this.on(Hls.Events.ERROR,(_e,d)=>window.testHlsErrors.push({type:d.type,details:d.details,fatal:d.fatal,status:d.response?.code}));}
          on(event,listener,context){if(event===OriginalHls.Events.ERROR)window.testPlaybackError=listener;return super.on(event,listener,context);}
        };
        const resolvedUrl=${JSON.stringify(resolved.url)},resolvedType=${JSON.stringify(resolved.type)},resolvedEmbed=${JSON.stringify(server.iframeUrl)};
        const videoRef={current:video},hlsRef={current:null},userAudioIntentRef={current:{muted:true,volume:1}},reextractUsedRef={current:false},hasPlayedRef={current:false},userPausedRef={current:false},partyHoldPlaybackRef={current:false},transportFallbackRef={current:null},stepDownSeekRef={current:0},autoSwitchCountRef={current:0},recoveryRoundRef={current:0};
        let lastBandwidthEstimate=0;const STALL_THRESHOLD_MS=15000;
        window.testRecoveries=[];
        const advanceToNext=()=>window.testRecoveries.push('advance'),stepDownQuality=()=>false,triggerReextract=reason=>window.testRecoveries.push(reason);
        const useEffect=fn=>{window.testCleanup=fn();};
        ${playerWiring}
        window.testHls=hlsRef.current;
        window.testCanFallback=!!hlsRef.current || !!transportFallbackRef.current;
        window.testTransportFallback=()=>{if(hlsRef.current)window.testPlaybackError(null,{fatal:true,type:Hls.ErrorTypes.NETWORK_ERROR,details:'fragLoadError',response:{code:0}});else transportFallbackRef.current?.();};
        video.addEventListener('error',()=>{if(!hlsRef.current && transportFallbackRef.current?.())return;window.testRecoveries.push('video-error-'+video.error?.code);});
        return true;
      })()`);
      console.log('PLAYER-PLAYING',provider);
      const sample=()=>evaluate('JSON.stringify({time:testVideo.currentTime,startupMs:window.testFirstFrameMs,duration:testVideo.duration,width:testVideo.videoWidth,height:testVideo.videoHeight,frames:testVideo.getVideoPlaybackQuality().totalVideoFrames,error:testVideo.error?.code,readyState:testVideo.readyState,buffered:Array.from({length:testVideo.buffered.length},(_,i)=>[testVideo.buffered.start(i),testVideo.buffered.end(i)]),hls:window.testHlsErrors,hlsState:window.testHls?{levels:testHls.levels.length,loading:testHls.loadingEnabled,url:testHls.url,mediaAttached:!!testHls.media}:null,recoveries:window.testRecoveries})').then(JSON.parse);
      let deadline=Date.now()+60000;let result;
      do{result=await sample();if(result.time>=5)break;await pause(500);}while(Date.now()<deadline);
      if(result.time<5||!result.width)throw Error('no decoded playback '+JSON.stringify(result));
      await evaluate('testVideo.currentTime=120;true;');deadline=Date.now()+45000;
      do{result=await sample();if(result.time>=125)break;await pause(500);}while(Date.now()<deadline);
      if(result.time<125)throw Error('seek did not resume '+JSON.stringify(result));
      if(await evaluate('testCanFallback')) {
        const position=result.time;
        await evaluate('testTransportFallback();true;');deadline=Date.now()+45000;
        do{result=await sample();if(result.time>=position+5)break;await pause(500);}while(Date.now()<deadline);
        if(result.time<position+5||result.error||result.recoveries.length)throw Error('proxy fallback did not resume '+JSON.stringify(result));
      }
      console.log('PASS', provider, JSON.stringify(result));
    } catch (e) { failed++; console.error('FAIL', provider, e.message); }
    finally { win.destroy(); }
  }
  devServer.close(); clearTimeout(guard); app.exit(failed ? 1 : 0);
}).catch(e => { console.error(e); app.exit(2); });
