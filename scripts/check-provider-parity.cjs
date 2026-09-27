// The provider classifier exists three times: the canonical PROVIDER_POLICIES
// table (src/lib/videoProviders.ts), the injected provider() inside
// EXTRACT_VIDEO_SERVERS (shared/scrape-scripts.ts) and the renderer's local
// classifyProvider (src/lib/scraper.ts). They must all agree.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');

function loadPure(file) {
  const ctx = vm.createContext({ exports: {}, URL, setTimeout, clearTimeout });
  vm.runInContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, ctx);
  return ctx.exports;
}

function extractFunction(file, marker) {
  const text = fs.readFileSync(file, 'utf8');
  const start = text.indexOf(marker);
  if (start < 0) throw new Error(`${file}: marker not found: ${marker}`);
  const open = text.indexOf('{', start);
  if (open < 0) throw new Error(`${file}: opening brace not found after: ${marker}`);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  throw new Error(`${file}: unbalanced braces for: ${marker}`);
}

function evalFunction(snippet, name) {
  const js = ts.transpileModule(snippet, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return new Function(`${js}\nreturn ${name};`)();
}

const canonicalModule = loadPure(path.join(root, 'src/lib/videoProviders.ts'));
const canonical = canonicalModule.classifyProvider;
const policies = canonicalModule.PROVIDER_POLICIES;
// The injected copy lives inside a template literal, so every backslash in the
// emitted JS is stored doubled. Pair-wise replacement halves them back.
const injected = evalFunction(
  extractFunction(path.join(root, 'shared/scrape-scripts.ts'), 'function provider(url, name) {').replace(/\\\\/g, '\\'),
  'provider',
);
const renderer = evalFunction(
  extractFunction(path.join(root, 'src/lib/scraper.ts'), 'function classifyProvider('),
  'classifyProvider',
);

const cases = [
  ['https://www.mp4upload.com/embed-abc123.html?x=1', undefined, 'mp4upload'],
  ['https://cdn1.k1c6x8p.shop/?token=abc', undefined, 'anime4upcdn'],
  ['https://cdn.44y4h0r.shop/Anime4up-S1/mal/1/2/sub/', undefined, 'anime4upcdn'],
  ['https://z4m2r9t.shop/x', undefined, 'anime4upcdn'],
  ['https://mega.nz/file/abc#key', undefined, 'mega'],
  ['https://mega.co.nz/#!abc!key', undefined, 'mega'],
  ['https://dood.to/e/abc', undefined, 'doodstream'],
  ['https://do0od.com/e/x', undefined, 'doodstream'],
  ['https://d0o0d.com/e/x', undefined, 'doodstream'],
  ['https://playmogo.com/e/x', undefined, 'doodstream'],
  ['https://dsvplay.com/e/x', undefined, 'doodstream'],
  ['https://d-s.io/e/x', undefined, 'doodstream'],
  ['https://vidply.com/e/x', undefined, 'doodstream'],
  ['https://ds2play.com/e/x', undefined, 'doodstream'],
  ['https://ds2video.com/e/x', undefined, 'doodstream'],
  ['https://all3do.com/e/x', undefined, 'doodstream'],
  ['https://doply.com/e/x', undefined, 'doodstream'],
  ['https://ok.ru/video/1', undefined, 'okru'],
  ['https://odnoklassniki.ru/video/1', undefined, 'okru'],
  ['https://videa.hu/videok/x', undefined, 'videa'],
  ['https://videakid.hu/video/x', undefined, 'videa'],
  ['https://hgcloud.to/e/x', undefined, 'streamwish'],
  ['https://playerwish.com/e/x', undefined, 'streamwish'],
  ['https://luluvdo.com/e/x', undefined, 'luluvdo'],
  ['https://lulustream.com/e/x', undefined, 'luluvdo'],
  ['https://luluvid.com/e/x', undefined, 'luluvdo'],
  ['https://yonaplay.net/embed.php?id=1', undefined, 'yonaplay'],
  ['https://vid3rb.com/video/1', undefined, 'vid3rb'],
  ['https://anime3rb.com/episode/x/1', undefined, 'vid3rb'],
  ['https://app.videas.fr/embed/x', undefined, 'videas'],
  ['https://dai.ly/x', undefined, 'dailymotion'],
  ['https://www.dailymotion.com/video/x', undefined, 'dailymotion'],
  ['https://voe.sx/e/x', undefined, 'voe'],
  ['https://share4max.com/embed/x', undefined, 'share4max'],
  ['https://megamax.me/embed/x', undefined, 'share4max'],
  ['https://streamruby.com/e/x', undefined, 'streamruby'],
  ['https://rubystm.com/x', undefined, 'streamruby'],
  ['https://rubyvidhub.com/e/x', undefined, 'streamruby'],
  ['https://uqload.io/x', undefined, 'uqload'],
  ['https://vk.com/video-1', undefined, 'vk'],
  ['https://example.com/video', undefined, 'generic'],
  ['https://unknown.example/embed', 'anime4up1', 'anime4upcdn'],
  ['https://unknown.example/embed', 'Anime4Up 2', 'anime4upcdn'],
];

// Generated cases: turn every canonical pattern into a URL it must match, so
// a pattern added to one copy but not the others can never go undetected
// (the static list above only covers patterns we remembered to list).
function sampleForPattern(pattern) {
  return pattern.replace(/\\\\/g, '\\')
    .replace(/\(\?:([^)]*)\)/g, (_, alts) => alts.split('|')[0])
    .replace(/\\d\+?/g, '1')
    .replace(/\\s\*/g, '')
    .replace(/\\\./g, '.')
    .replace(/\\\//g, '/');
}
let generated = 0;
for (const [id, policy] of Object.entries(policies)) {
  if (id === 'generic') continue;
  for (const pattern of policy.patterns) {
    const sample = sampleForPattern(pattern);
    const urls = [
      `https://${sample}/x`,
      `https://cdn.example/${sample}/x`,
      `https://cdn.example/${sample}`,
    ];
    const hit = urls.find((u) => canonical(u) === id);
    if (!hit) continue;
    if (cases.some(([u]) => u === hit)) continue;
    cases.push([hit, undefined, id]);
    generated++;
  }
}

const failures = [];
for (const [url, name, expected] of cases) {
  const got = {
    videoProviders: canonical(url, name),
    injected: injected(url, name),
    renderer: renderer(url, name),
  };
  if (got.videoProviders !== expected || got.injected !== expected || got.renderer !== expected) {
    failures.push({ url, name, expected, got });
  }
}

if (failures.length) {
  for (const { url, name, expected, got } of failures) {
    console.error(`MISMATCH ${url}${name ? ` (name=${JSON.stringify(name)})` : ''}`);
    console.error(`  expected        ${expected}`);
    console.error(`  videoProviders  ${got.videoProviders}`);
    console.error(`  injected        ${got.injected}`);
    console.error(`  renderer        ${got.renderer}`);
  }
  process.exitCode = 1;
} else {
  console.log(`PASS provider classifier parity (${cases.length} cases, ${generated} generated from PROVIDER_POLICIES)`);
}
