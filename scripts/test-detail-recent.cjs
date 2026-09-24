const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const { app, BrowserWindow } = require('electron');

const base = 'https://w1.anime4up.rest';
const detailUrl = `${base}/anime/mirai-nikki/`;
const detailHtml = `<h1 class="anime-details-title">Mirai Nikki</h1>
  <div class="anime-thumbnail"><img src="/poster.jpg"></div>
  <div class="anime-story">A survival story.</div>
  <div class="anime-genres"><a>Action</a></div>
  <div id="episodesList"><a title="الحلقة 1" href="/episode/episode-1/">1</a>
  <a title="الحلقة 2" href="/episode/episode-2/">2</a></div>`;
const recentHtml = `<div class="anime-card-container"><img src="/a.jpg"><a href="/episode/a-1/">الحلقة 1</a><a href="/anime/a/">Anime A</a></div>
  <div class="anime-card-container"><a href="/episode/a-2/">الحلقة 2</a><a href="/anime/a/">Anime A</a></div>
  <div class="anime-card-container"><a href="/episode/b-1/">الحلقة 1</a><a href="/anime/b/">Anime B</a></div>
  <a href="/episode/page/2/">Next</a>`;
const nextHtml = `<div class="anime-card-container"><a href="/episode/c-1/">الحلقة 1</a><a href="/anime/c/">Anime C</a></div>`;
const searchHtml = `<div class="anime-card-title"><h3><a href="/anime/mirai-nikki/">Mirai Nikki</a></h3></div>`;

app.whenReady().then(async () => {
  const source = fs.readFileSync('src/lib/scraper.ts', 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const win = new BrowserWindow({ show: false });
  try {
    await win.loadURL('about:blank');
    const result = await win.webContents.executeJavaScript(`(async () => {
      const module = { exports: {} }, exports = module.exports, require = () => ({});
      window.pantoufa = { fetchHtml: async (url) => url.includes('search_param') ? ${JSON.stringify(searchHtml)} : ${JSON.stringify(detailHtml)}, scrape: async () => null };
      ${js}
      const detail = await module.exports.scrapeAnime4upDetailDirect(${JSON.stringify(detailUrl)});
      const match = await module.exports.searchAnime4upDirect('Mirai Nikki');
      const page1 = module.exports.parseAnime4upRecentHtml(${JSON.stringify(recentHtml)}, 1);
      const page2 = module.exports.parseAnime4upRecentHtml(${JSON.stringify(nextHtml)}, 2);
      let failure = '';
      try { await module.exports.scrapeEpisodesPage(${JSON.stringify(detailUrl)}); }
      catch (error) { failure = error.message; }
      return { detail, match, page1, page2, failure };
    })()`);
    assert.match(result.detail.title, /Mirai Nikki/i);
    assert.equal(result.detail.episodes.length, 2, 'detail episodes');
    assert.ok(result.detail.poster.startsWith('https://'), 'detail poster');
    assert.equal(result.match, detailUrl, 'fallback title search');
    assert.equal(result.page1.episodes.length, 2, 'recent anime dedup');
    assert.equal(result.page2.episodes.length, 1, 'recent page 2');
    assert.ok(result.page1.hasNext && !result.page2.hasNext, 'recent pagination');
    assert.match(result.failure, /Anime details unavailable/);
    console.log(`PASS detail ${result.detail.episodes.length} episodes; recent ${result.page1.episodes.length}+${result.page2.episodes.length} cards; null scrape handled`);
  } finally {
    win.destroy();
    app.quit();
  }
}).catch((error) => { console.error(error); app.exit(1); });
