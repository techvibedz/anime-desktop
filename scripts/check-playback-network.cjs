// Run production functions/effects with controlled DNS, tokens and player events.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const read = file => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const main = read('electron/main.ts');
const watch = read('src/pages/Watch.tsx');
const run = (source, ctx) => vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, ctx);
const functionSource = (source, name) => {
  const ast = ts.createSourceFile('source.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let node;
  function visit(n) {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) node = n;
    ts.forEachChild(n, visit);
  }
  visit(ast);
  assert.ok(node, name);
  return node.getText(ast);
};
const quiet = { info() {}, warn() {}, log() {} };

(async () => {
  // A completed warm-up serves Play instantly, but a cancelled/expired one cannot.
  const cacheSource = read('src/lib/api.ts').match(/type ResolvePayload =[\s\S]*?(?=\/\*\* Called when the main process reports)/)[0];
  let now = 0, calls = 0, pending;
  const direct = { success: true, data: { videoUrl: 'https://cdn.example/video.mp4?token=live', type: 'mp4' } };
  const cache = { exports: {}, Date: { now: () => now }, EXPECT_DIRECT_PROVIDERS: new Set(['streamwish']),
    doResolveVideo: () => { calls++; return pending || Promise.resolve(direct); } };
  run(cacheSource + '\nglobalThis.resolveVideo=resolveVideo;', cache);
  const warm = cache.resolveVideo('embed', 'streamwish', { background: true });
  await warm;
  assert.equal(cache.resolveVideo('embed', 'streamwish'), warm, 'completed warm-up reused for Play');
  assert.equal(calls, 1);
  now = 90001;
  await cache.resolveVideo('embed', 'streamwish');
  assert.equal(calls, 2, 'expired URL extracted afresh');
  let finishWarm;
  pending = new Promise(r => { finishWarm = r; });
  const slowWarm = cache.resolveVideo('slow', 'streamwish', { background: true });
  pending = null;
  const click = cache.resolveVideo('slow', 'streamwish');
  assert.notEqual(click, slowWarm, 'Play never joins a cancellable background job');
  await click;
  finishWarm({ success: false, error: 'cancelled' });
  await slowWarm;
  assert.equal(cache.resolveVideo('slow', 'streamwish'), click, 'late cancellation cannot evict foreground success');
  pending = Promise.resolve({ success: true, data: { videoUrl: 'embed', type: 'iframe' } });
  await cache.resolveVideo('failed', 'streamwish');
  pending = null;
  assert.equal((await cache.resolveVideo('failed', 'streamwish')).data.type, 'mp4', 'iframe miss is not pinned');

  // Removed files are a definitive failure, not a 30-second browser capture.
  let captures = 0, pageFetches = 0;
  const removed = { URL, AbortSignal, Date, console: quiet, PLAYBACK_UA: 'test',
    session: { defaultSession: { fetch: async () => { pageFetches++; return new Response('File was deleted'); } } },
    enqueue: async () => { captures++; return null; },
  };
  run(functionSource(main, 'extractMp4upload') + '\nglobalThis.extractMp4upload=extractMp4upload;', removed);
  assert.equal((await removed.extractMp4upload('https://www.mp4upload.com/embed-deleted.html')).denied, true);
  assert.equal(pageFetches, 1); assert.equal(captures, 0);
  const resolver = { window: { pantoufa: { directExtract: async () => ({ url: '', type: 'mp4', denied: true }) } } };
  run(functionSource(read('src/lib/api.ts'), 'doResolveVideo') + '\nglobalThis.doResolveVideo=doResolveVideo;', resolver);
  assert.equal((await resolver.doResolveVideo('embed', 'mp4upload')).success, false, 'removed file advances instead of mounting a dead iframe');

  const oldServers = [{ name: 'Anime3rb 720p', iframeUrl: 'expired' }];
  const newServers = [{ name: 'Anime3rb 720p', iframeUrl: 'fresh' }];
  let episodeFetches = 0;
  const a3rb = { exports: {}, Date: { now: () => 1000 }, A3RB_SERVERS_TTL: 720000,
    a3rbServersMem: new Map([['test#1', { servers: oldServers, ts: 0 }]]),
    a3rbServersKey: (title, number) => `${title}#${number}`, isDefinitiveMiss: () => false,
    peekAnime3rbTitleUrl: async () => 'https://anime3rb.com/titles/test',
    scrapeAnime3rbEpisodeServers: async () => { episodeFetches++; return newServers; },
  };
  run(functionSource(read('src/lib/api.ts'), 'fetchAnime3rbServers') + '\nglobalThis.fetchAnime3rbServers=fetchAnime3rbServers;', a3rb);
  assert.equal(await a3rb.fetchAnime3rbServers('test', 1), oldServers);
  assert.equal(await a3rb.fetchAnime3rbServers('test', 1, true), newServers, 'token recovery bypasses the cached player URL');
  assert.equal(episodeFetches, 1);
  const refreshSource = watch.match(/const refreshA3rbPlayerUrl = useCallback[\s\S]*?\}, \[a3rbParam, episodeUrl\]\);/)[0];
  const refresh = { a3rbParam: null, episodeUrl: 'https://witanime.site/watch/test/1', useCallback: fn => fn,
    resOf: name => Number(name.match(/(\d+)p/)?.[1] || 0), fetchAnime3rbServers: async (title, number, force) => {
      assert.equal(title, 'test'); assert.equal(number, 1); assert.equal(force, true); return newServers;
    },
  };
  run(refreshSource + '\nglobalThis.refresh=refreshA3rbPlayerUrl;', refresh);
  assert.equal(await refresh.refresh('Anime3rb 720p', 'test', 1), 'fresh', 'cross-source Anime3rb refresh works without an explicit episode URL');

  // Progressive transport falls back from blocked ISP DNS, keeps the Range,
  // and never lets its headers timeout abort a healthy body.
  const timers = new Set();
  const transport = { AbortController, AbortSignal, console: quiet,
    setTimeout: (fn, ms) => { const timer = { fn, ms }; timers.add(timer); return timer; },
    clearTimeout: timer => timers.delete(timer),
    fetch: async () => { throw new TypeError('fetch failed'); },
    session: { defaultSession: { fetch: async (_url, init) => { assert.equal(init.headers.Range, 'bytes=120-'); return new Response('data'); } } },
  };
  run(functionSource(main, 'fetchVideoUpstream') + '\nglobalThis.fetchVideoUpstream=fetchVideoUpstream;', transport);
  const request = { headers: { Range: 'bytes=120-' }, signal: new AbortController().signal };
  assert.equal(await (await transport.fetchVideoUpstream('https://cdn.example/video', request, true)).text(), 'data');
  assert.equal(timers.size, 0);
  let bodySignal;
  transport.fetch = async (_url, init) => { bodySignal = init.signal; return new Response('stream'); };
  await transport.fetchVideoUpstream('https://cdn.example/video', request, true);
  assert.equal(timers.size, 0, 'headers watchdog is cleared before body consumption');
  assert.equal(bodySignal.aborted, false);
  let timeoutFallback = false;
  transport.fetch = (_url, init) => new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(new Error('timeout'))));
  transport.session.defaultSession.fetch = async () => { timeoutFallback = true; return new Response('recovered'); };
  const hung = transport.fetchVideoUpstream('https://cdn.example/video', request, true);
  for (const timer of [...timers]) timer.fn();
  assert.equal(await (await hung).text(), 'recovered');
  assert.ok(timeoutFallback, 'unanswered system DNS switches to Chromium DoH');
  timeoutFallback = false;
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(transport.fetchVideoUpstream('https://cdn.example/video', { ...request, signal: aborted.signal }, true));
  assert.equal(timeoutFallback, false, 'caller cancellation never starts fallback traffic');
  transport.fetch = async () => new Response('denied', { status: 403 });
  assert.equal(await (await transport.fetchVideoUpstream('https://cdn.example/video', request, true)).text(), 'recovered', 'cookie-bearing transport retries Node denial');

  // Real proxy decoding must preserve signed queries, raw paths and seek ranges.
  let handler;
  const requests = [];
  const proxy = { URL, URLSearchParams, Headers, Response, AbortController, AbortSignal,
    VIDEO_PROTOCOL: 'pantoufa-video', REF_PARAM: '__pantoufa_ref', PLAYBACK_UA: 'test',
    mainWindow: null, inFlightProxyTargets: new Set(), console: quiet,
    setTimeout: (fn, ms) => setTimeout(fn, ms).unref(), clearTimeout,
    protocol: { handle: (_name, callback) => { handler = callback; } },
    fetchVideoUpstream: async (url, init) => {
      requests.push({ url, init });
      return new Response('video', { status: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 120-124/1000' } });
    },
  };
  run(functionSource(main, 'mediaChunkRange') + '\n' + functionSource(main, 'registerVideoProxy') + '\nregisterVideoProxy();', proxy);
  const urlCtx = { URL };
  run(functionSource(watch, 'proxify') + '\nglobalThis.proxify=proxify;', urlCtx);
  const signed = 'https://a4.mp4upload.com:183/token//video.mp4?sig=A%2fb%2Bz&name=a%20b~c&flag&dup=1&dup=2';
  const controller = new AbortController();
  const response = await handler({ url: urlCtx.proxify(signed, 'https://www.mp4upload.com/embed-test.html'), method: 'GET', headers: new Headers({ Range: 'bytes=120-' }), signal: controller.signal });
  assert.equal(requests[0].url, signed, 'signed query stays byte-for-byte unchanged');
  assert.equal(requests[0].init.headers.Range, 'bytes=120-');
  assert.equal(response.headers.get('content-range'), 'bytes 120-124/1000');
  assert.equal(await response.text(), 'video');
  controller.abort();
  assert.equal(requests[0].init.signal.aborted, true, 'winning body remains linked to caller cancellation');
  const secondController = new AbortController();
  await handler({ url: urlCtx.proxify(signed, 'https://www.mp4upload.com/'), method: 'GET', headers: new Headers(), signal: secondController.signal });
  secondController.abort();
  assert.equal(requests.at(-1).init.signal.aborted, true, 'cached strategy retains cancellation after headers');
  const before = requests.length;
  await handler({ url: urlCtx.proxify(signed, 'https://www.mp4upload.com/'), method: 'GET', headers: new Headers(), signal: secondController.signal });
  assert.equal(requests.length, before, 'already-aborted requests do not launch strategies');
  proxy.setTimeout = (fn, ms) => ms === 600 || ms === 1200 ? setTimeout(fn, 0) : setTimeout(fn, ms).unref();
  let failures = 0;
  proxy.fetchVideoUpstream = async (_url, init) => {
    failures++;
    if (init.headers.Referer === 'https://cdn.example/') return new Response('denied', { status: 403 });
    throw Error('network timeout');
  };
  const genericRequest = () => ({ url: urlCtx.proxify('https://cdn.example/video.mp4?token=live', 'https://player.example/embed'), method: 'GET', headers: new Headers(), signal: new AbortController().signal });
  assert.equal((await handler(genericRequest())).status, 502, 'mixed auth and transport failure is not classified as expired');
  assert.ok(failures > 4, 'transient routes get bounded retries');
  failures = 0;
  proxy.fetchVideoUpstream = async () => { failures++; return new Response('denied', { status: 403 }); };
  assert.equal((await handler(genericRequest())).status, 410, 'all-auth failures request a fresh token immediately');
  assert.equal(failures, 4, 'dead token does not repeat the strategy race');

  // Run the real Watch wiring effect to verify HLS retry ownership and watchdog.
  const ast = ts.createSourceFile('Watch.tsx', watch, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let effect;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect' && node.arguments[1]?.getText(ast) === '[resolvedUrl, resolvedType, resolvedEmbed, advanceToNext, stepDownQuality]') effect = node.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.ok(effect, 'Watch stream wiring effect found');
  const listeners = new Map();
  const media = { currentTime: 0, duration: 1400, paused: true, ended: false, muted: false, volume: 1,
    ranges: [], plays: 0, reloads: 0,
    get buffered() { return { length: this.ranges.length, start: i => this.ranges[i][0], end: i => this.ranges[i][1] }; },
    play() { this.plays++; this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; },
    load() { this.reloads++; }, removeAttribute() {},
    addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener(name) { listeners.delete(name); },
  };
  class FakeHls {
    static isSupported() { return true; }
    static Events = { FRAG_LOADED: 'frag', LEVEL_LOADED: 'level', MANIFEST_PARSED: 'manifest', ERROR: 'error' };
    static ErrorTypes = { NETWORK_ERROR: 'network', MEDIA_ERROR: 'media' };
    constructor(config) { this.config = config; this.events = new Map(); this.sources = []; this.starts = []; }
    loadSource(url) { this.sources.push(url); } attachMedia() {} stopLoad() {} destroy() {} swapAudioCodec() {} recoverMediaError() {}
    startLoad(position) { this.starts.push(position); } on(name, fn) { this.events.set(name, fn); }
  }
  let clock = 0, tick, cleanup, reextracts = 0, advances = 0;
  const player = { Hls: FakeHls, AbortController, Date: { now: () => clock }, console: quiet,
    resolvedUrl: signed.replace('video.mp4', 'master.m3u8'), resolvedType: 'hls', resolvedEmbed: 'https://player.example/embed',
    videoRef: { current: media }, hlsRef: { current: null }, userAudioIntentRef: { current: {} },
    transportFallbackRef: { current: null }, stepDownSeekRef: { current: 0 }, autoSwitchCountRef: { current: 2 }, recoveryRoundRef: { current: 2 },
    reextractUsedRef: { current: false }, hasPlayedRef: { current: true }, userPausedRef: { current: false }, partyHoldPlaybackRef: { current: false },
    applyAudioIntent: () => false, proxify: urlCtx.proxify, bufferAheadSeconds: (pos, end) => Math.max(0, end - pos),
    STREAM_BUFFER_POLICY: { minBufferForPlaybackSeconds: 4, preferredForwardBufferSeconds: 300 }, STALL_THRESHOLD_MS: 15000, lastBandwidthEstimate: 0,
    window: { pantoufa: { setVideoReferer() {} } }, advanceToNext: () => advances++, stepDownQuality: () => false,
    triggerReextract: () => reextracts++, setInterval: fn => { tick = fn; return 1; }, clearInterval() {},
    useEffect: fn => { cleanup = fn(); },
  };
  run(effect, player);
  assert.equal(player.hasPlayedRef.current, true, 're-extraction retains mid-watch recovery budget');
  assert.equal(player.autoSwitchCountRef.current, 2, 'successful extraction alone cannot reset failure backoff');
  media.ranges = [[100, 105]]; listeners.get('canplay')();
  assert.equal(media.plays, 0, 'distant buffered range cannot release startup');
  media.ranges = [[0, 5]]; listeners.get('canplay')();
  assert.equal(media.plays, 1, 'contiguous startup cushion releases playback');
  listeners.get('playing')();
  assert.equal(player.autoSwitchCountRef.current, 0, 'real playback heals consecutive failures');
  const hls = player.hlsRef.current;
  for (let i = 0; i < 20; i++) hls.events.get('error')(null, { fatal: false, type: 'network', details: 'fragLoadError', response: { code: 503 } });
  assert.equal(hls.starts.length, 0, 'non-fatal errors leave library backoff intact');
  assert.equal(hls.sources.length, 1, 'intermittent errors do not reset or rewrite the signed source');
  media.currentTime = 120;
  hls.events.get('error')(null, { fatal: true, type: 'network', response: { code: 403 } });
  assert.equal(hls.starts.at(-1), 120, 'transport failover resumes the playhead');
  assert.equal(hls.config.startPosition, 120, 'manifest autostart retains the seek after asynchronous parsing');
  assert.equal(hls.sources.length, 2);
  assert.equal(reextracts, 0);
  const beforeHlsResume = media.plays;
  media.paused = true; media.ranges = [[120, 126]]; listeners.get('canplay')();
  assert.equal(media.plays, beforeHlsResume + 1, 'transport fallback releases playback after the replacement buffer fills');
  hls.events.get('error')(null, { fatal: true, type: 'network', response: { code: 403 } });
  assert.equal(reextracts, 1, 'proxy auth rejection refreshes the token');
  cleanup();
  player.resolvedType = 'hls'; player.hasPlayedRef.current = false; media.currentTime = 0; media.ranges = []; media.paused = true; clock = 0;
  run(effect, player);
  const silentHls = player.hlsRef.current;
  clock = 23000; tick();
  assert.equal(silentHls.sources.length, 2, 'silent HLS startup stall tries proxy without waiting for library error');
  assert.ok(silentHls.sources.at(-1).startsWith('pantoufa-video:'));
  assert.equal(player.transportFallbackRef.current(), false, 'silent HLS fallback is bounded');
  cleanup();
  player.resolvedType = 'mp4'; player.resolvedUrl = 'https://videa.hu/video.mp4?token=live'; media.currentTime = 120;
  run(effect, player);
  assert.equal(player.transportFallbackRef.current(), true, 'direct progressive failure tries the dual-DNS proxy once');
  assert.ok(media.src.startsWith('pantoufa-video:'));
  media.currentTime = 0; listeners.get('loadedmetadata')();
  assert.equal(media.currentTime, 120, 'progressive transport switch restores position');
  assert.equal(player.transportFallbackRef.current(), false, 'transport fallback is bounded');
  cleanup();
  assert.equal(player.transportFallbackRef.current, null, 'unmount removes the fallback');

  player.resolvedType = 'mp4'; player.hasPlayedRef.current = false; media.currentTime = 0; media.ranges = []; media.paused = true; clock = 0;
  run(effect, player);
  const previousPlays = media.plays;
  const previousReloads = media.reloads;
  media.readyState = 3; media.ranges = [[0, 1]]; listeners.get('canplay')();
  assert.equal(media.plays, previousPlays + 1, 'progressive canplay starts without waiting for suspended four-second preload');
  listeners.get('playing')(); media.paused = false;
  for (clock = 1000; clock <= 16000; clock += 1000) { listeners.get('stalled')(); tick(); }
  assert.ok(media.src.startsWith('pantoufa-video:'), 'silent mid-watch stall tries the alternate transport');
  assert.equal(media.reloads, previousReloads, 'watchdog uses transport fallback before reloading the same route');
  listeners.get('playing')(); media.paused = false;
  for (; clock <= 33000; clock += 1000) { listeners.get('stalled')(); tick(); }
  assert.equal(media.reloads, previousReloads + 1, 'repeated stalled events cannot hide a frozen stream from watchdog');
  assert.equal(advances, 0, 'transient stall gets in-place recovery before switching');
  cleanup();
  console.log('PASS playback network: warm-cache TTL, transport failover, signed URLs, cancellation, HLS backoff and stall recovery');
})().catch(error => { console.error(error); process.exitCode = 1; });
