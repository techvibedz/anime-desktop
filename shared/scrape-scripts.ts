// Extractor JS strings injected into hidden BrowserWindow instances.
// These run inside the anime site's page context (real browser, the user's
// residential IP → witanime's Cloudflare accepts).
//
// Each script returns a Promise that resolves with the scraped data.
// Electron's webContents.executeJavaScript awaits the returned promise and
// gives us the value directly — no postMessage shim needed (we're in a real
// browser, not React Native).

const HELPERS = `
(function () {
  if (window.__pHelpersInstalled) return;
  window.__pHelpersInstalled = true;
  window.__pUpgrade = function (u) {
    if (!u) return null;
    return String(u).replace(/-\\d+x\\d+(\\.\\w+)$/, '$1').replace(/\\?resize=\\d+,\\d+/, '').replace(/\\?w=\\d+/, '');
  };
  window.__pBestImg = function (el) {
    var img = el.querySelector('img');
    if (!img) return null;
    var src = img.getAttribute('data-image') || img.getAttribute('data-src')
           || (img.getAttribute('srcset') || '').split(' ')[0]
           || img.getAttribute('src') || '';
    return window.__pUpgrade(src);
  };
  window.__pAbsUrl = function (href, base) {
    if (!href) return '';
    if (/^https?:/.test(href)) return href;
    if (href.indexOf('//') === 0) return 'https:' + href;
    return base + (href.charAt(0) === '/' ? '' : '/') + href;
  };
  window.__pWaitFor = function (checkFn, timeoutMs, intervalMs) {
    timeoutMs = timeoutMs || 25000;
    intervalMs = intervalMs || 500;
    return new Promise(function (resolve) {
      var start = Date.now();
      var iv = setInterval(function () {
        var cfActive = !!document.querySelector('#challenge-running, .cf-browser-verification, #challenge-stage, #cf-challenge-running, #cf-please-wait');
        var t = (document.title || '').toLowerCase();
        if (t.indexOf('moment') >= 0 || t.indexOf('لحظة') >= 0) cfActive = true;
        if (!cfActive) {
          try { if (checkFn()) { clearInterval(iv); resolve(true); return; } } catch (e) {}
        }
        if (Date.now() - start > timeoutMs) { clearInterval(iv); resolve(false); }
      }, intervalMs);
    });
  };
})();
`;

const WIT = "https://witanime.you";
const UP4 = "https://w1.anime4up.rest";

/* ── HOME (witanime) ──────────────────────────── */

export const EXTRACT_HOME_WIT = `(async function(){${HELPERS}
var ok = await window.__pWaitFor(function () {
  return !!document.querySelector('.anime-card-container, .lucodeia-slider-slide-item, .episodes-card-container');
}, 18000);
if (!ok) return null;

var featured = [];
document.querySelectorAll('.lucodeia-slider-slide-item').forEach(function (el) {
  var href = el.getAttribute('href') || (el.querySelector('a') && el.querySelector('a').getAttribute('href')) || '';
  if (!href) return;
  href = window.__pAbsUrl(href, '${WIT}');
  var bgMatch = (el.getAttribute('style') || '').match(/url\\(['"]?([^'"()]+)['"]?\\)/);
  var genres = [];
  el.querySelectorAll('.slider-genres a').forEach(function (g) { genres.push(g.textContent.trim()); });
  featured.push({
    title: el.getAttribute('title') || (el.querySelector('.slider-title') && el.querySelector('.slider-title').textContent.trim()) || '',
    href: href,
    image: bgMatch ? window.__pUpgrade(bgMatch[1]) : null,
    description: (el.querySelector('.slider-details p') && el.querySelector('.slider-details p').textContent.trim()) || null,
    genres: genres,
  });
});

var seen = {};
var animes = [];
document.querySelectorAll('.anime-card-container').forEach(function (el) {
  var hrefEl = el.querySelector('.anime-card-poster a.overlay');
  var href = (hrefEl && hrefEl.getAttribute('href')) || '';
  if (!href || seen[href]) return;
  seen[href] = true;
  animes.push({
    title: (el.querySelector('.anime-card-title h3 a') && el.querySelector('.anime-card-title h3 a').textContent.trim()) || '',
    href: href,
    image: window.__pBestImg(el),
    type: (el.querySelector('.anime-card-type a') && el.querySelector('.anime-card-type a').textContent.trim()) || null,
    status: (el.querySelector('.anime-card-status a') && el.querySelector('.anime-card-status a').textContent.trim()) || null,
    description: (el.querySelector('.anime-card-title a') && el.querySelector('.anime-card-title a').getAttribute('data-content')) || null,
    isNew: ((el.querySelector('.anime-card-status a') && el.querySelector('.anime-card-status a').textContent.trim()) || '').indexOf('مستمر') >= 0,
    rating: (el.querySelector('.anime-card-rating') && el.querySelector('.anime-card-rating').textContent.trim()) || null,
  });
});

var episodes = [];
document.querySelectorAll('.episodes-card-container').forEach(function (el) {
  episodes.push({
    title: (el.querySelector('.episodes-card-title h3 a') && el.querySelector('.episodes-card-title h3 a').textContent.trim()) || '',
    href: (el.querySelector('.episodes-card a.overlay') && el.querySelector('.episodes-card a.overlay').getAttribute('href')) || '',
    image: window.__pBestImg(el),
    animeTitle: (el.querySelector('.ep-card-anime-title h3 a') && el.querySelector('.ep-card-anime-title h3 a').textContent.trim()) || '',
    animeHref: (el.querySelector('.ep-card-anime-title h3 a') && el.querySelector('.ep-card-anime-title h3 a').getAttribute('href')) || '',
    isNew: true,
  });
});

return { featured: featured.slice(0, 5), animes: animes, episodes: episodes };
})();`;

/* ── HOME (anime4up) ──────────────────────────── */

export const EXTRACT_HOME_4UP = `(async function(){${HELPERS}
var ok = await window.__pWaitFor(function () { return !!document.querySelector('.anime-card-container'); }, 18000);
if (!ok) return null;
var seen = {};
var animes = [];
document.querySelectorAll('.anime-card-container').forEach(function (el) {
  var hrefEl = el.querySelector('.anime-card-poster a.overlay');
  var href = (hrefEl && hrefEl.getAttribute('href')) || '';
  if (!href || seen[href]) return;
  seen[href] = true;
  animes.push({
    title: (el.querySelector('.anime-card-title h3 a') && el.querySelector('.anime-card-title h3 a').textContent.trim()) || '',
    href: href,
    image: window.__pBestImg(el),
    type: (el.querySelector('.anime-card-type a') && el.querySelector('.anime-card-type a').textContent.trim()) || null,
  });
});
return { animes: animes };
})();`;

/* ── EPISODES (witanime) — decode processedEpisodeData ─── */

export const EXTRACT_EPISODES_WIT = `(async function(){${HELPERS}
function decodeEpisodeData(raw) {
  if (!raw) return [];
  try {
    var parts = String(raw).split('.');
    if (parts.length !== 2) return [];
    var encBin = atob(parts[0]);
    var keyBin = atob(parts[1]);
    var bytes = new Uint8Array(encBin.length);
    for (var i = 0; i < encBin.length; i++) bytes[i] = encBin.charCodeAt(i) ^ keyBin.charCodeAt(i % keyBin.length);
    return JSON.parse(new TextDecoder('utf-8').decode(bytes));
  } catch (e) { return []; }
}
function findRaw() {
  try { if (typeof window.processedEpisodeData === 'string') return window.processedEpisodeData; } catch (e) {}
  var scripts = document.querySelectorAll('script');
  for (var i = 0; i < scripts.length; i++) {
    var m = (scripts[i].textContent || '').match(/processedEpisodeData\\s*=\\s*['"]([^'"]+)['"]/);
    if (m) return m[1];
  }
  return null;
}
var ok = await window.__pWaitFor(function () {
  return !!findRaw() || !!document.querySelector('.anime-details-title, .anime-page-link, .anime-thumbnail');
}, 22000);
if (!ok) return null;
// Used to be 2500ms — too slow; 600ms is enough for the late-bound scripts.
await new Promise(function (r) { setTimeout(r, 600); });

var titleEl = document.querySelector('.anime-details-title') || document.querySelector('h1');
var posterImg = document.querySelector('.anime-thumbnail img');
var synopsisEl = document.querySelector('.anime-story');
var genres = [];
document.querySelectorAll('.anime-genres a').forEach(function (a) { genres.push(a.textContent.trim()); });

// Look for an explicit anime4up URL anywhere on the page (witanime
// sometimes lists external mirror links). If present, use it directly
// instead of relying on a fuzzy title search.
var up4Url = null;
document.querySelectorAll('a[href*="anime4up"]').forEach(function (a) {
  var h = a.getAttribute('href') || '';
  if (h && !up4Url) up4Url = h.indexOf('http') === 0 ? h : ('https:' + h);
});

var raw = findRaw();
var decoded = decodeEpisodeData(raw);
var episodes = decoded.map(function (ep) {
  var url = ep.url || '';
  if (url && url.indexOf('http') !== 0) url = '${WIT}/' + url.replace(/^\\//, '');
  var num = typeof ep.number === 'string' ? parseInt(ep.number, 10) : (ep.number || 0);
  return {
    title: ((ep.type || '') + ' ' + (ep.number != null ? ep.number : '')).trim() || ('Episode ' + num),
    number: num,
    type: ep.type || '',
    screenshot: ep.screenshot || '',
    href: url || null,
  };
}).filter(function (e) { return e.href; });
episodes.sort(function (a, b) { return a.number - b.number; });

if (episodes.length === 0) {
  var seen = {};
  document.querySelectorAll('a[href*="/episode/"]').forEach(function (a) {
    var href = a.getAttribute('href') || '';
    if (!href || seen[href]) return;
    seen[href] = true;
    var label = (a.textContent || '').trim();
    var m = label.match(/(\\d+)/) || href.match(/(\\d+)\\/?$/);
    var num = m ? parseInt(m[1], 10) : episodes.length + 1;
    episodes.push({ title: label || ('Episode ' + num), number: num, type: '', screenshot: '', href: href });
  });
  episodes.sort(function (a, b) { return a.number - b.number; });
}

return {
  title: (titleEl && titleEl.textContent.trim()) || '',
  poster: (posterImg && (posterImg.getAttribute('data-image') || posterImg.getAttribute('src'))) || '',
  synopsis: (synopsisEl && synopsisEl.textContent.trim()) || '',
  genres: genres,
  episodes: episodes,
  up4Url: up4Url,
};
})();`;

/* ── EPISODES (anime4up) ──────────────────────── */

export const EXTRACT_EPISODES_4UP = `(async function(){${HELPERS}
function up4Number(href) {
  if (!href) return null;
  try {
    var d = decodeURIComponent(href);
    var m = d.match(/الحلقة[\\s-]*(\\d+)/);
    if (m) return parseInt(m[1], 10);
    var slug = d.replace(/\\/$/, '').split('/').pop() || '';
    var tail = slug.match(/-(\\d+)(?:[-/].*)?$/);
    if (tail) return parseInt(tail[1], 10);
  } catch (e) {}
  return null;
}
var ok = await window.__pWaitFor(function () {
  return !!document.querySelector('a[href*="/episode/"], .anime-details-title');
}, 22000);
if (!ok) return null;
await new Promise(function (r) { setTimeout(r, 500); });

var titleEl = document.querySelector('.anime-details-title') || document.querySelector('h1');
var posterImg = document.querySelector('.anime-thumbnail img');
var synopsisEl = document.querySelector('.anime-story');
var genres = [];
document.querySelectorAll('.anime-genres a').forEach(function (a) { genres.push(a.textContent.trim()); });

var seen = {};
var episodes = [];
document.querySelectorAll('a[href*="/episode/"]').forEach(function (a) {
  var href = a.getAttribute('href') || '';
  if (!href || seen[href]) return;
  var num = up4Number(href);
  if (num == null) return;
  seen[href] = true;
  var label = (a.textContent || '').trim();
  episodes.push({
    title: label || ('الحلقة ' + num),
    number: num, type: '', screenshot: '',
    href: window.__pAbsUrl(href, '${UP4}'),
  });
});
episodes.sort(function (a, b) { return a.number - b.number; });

return {
  title: (titleEl && titleEl.textContent.trim()) || '',
  poster: (posterImg && (posterImg.getAttribute('data-image') || posterImg.getAttribute('src'))) || '',
  synopsis: (synopsisEl && synopsisEl.textContent.trim()) || '',
  genres: genres,
  episodes: episodes,
};
})();`;

/* ── SEARCH / LISTING / RECENT ────────────────── */

export const EXTRACT_SEARCH = `(async function(){${HELPERS}
var ok = await window.__pWaitFor(function () {
  return !!document.querySelector('.anime-card-container, .no-results, .search-empty');
}, 18000);
var seen = {};
var results = [];
document.querySelectorAll('.anime-card-container').forEach(function (el) {
  var href = (el.querySelector('.anime-card-poster a.overlay') && el.querySelector('.anime-card-poster a.overlay').getAttribute('href')) || '';
  var title = (el.querySelector('.anime-card-title h3 a') && el.querySelector('.anime-card-title h3 a').textContent.trim()) || '';
  if (!href || !title || seen[href]) return;
  seen[href] = true;
  results.push({ title: title, href: href, image: window.__pBestImg(el), type: null, status: null, synopsis: null });
});
return { results: results };
})();`;

export const EXTRACT_LISTING = `(async function(){${HELPERS}
var ok = await window.__pWaitFor(function () { return !!document.querySelector('.anime-card-container'); }, 20000);
if (!ok) return { items: [] };
var seen = {};
var items = [];
document.querySelectorAll('.anime-card-container').forEach(function (el) {
  var href = (el.querySelector('.anime-card-poster a.overlay') && el.querySelector('.anime-card-poster a.overlay').getAttribute('href')) || '';
  if (!href || seen[href] || href.indexOf('/anime/') < 0) return;
  seen[href] = true;
  items.push({
    title: (el.querySelector('.anime-card-title h3 a, .anime-card-title a') && el.querySelector('.anime-card-title h3 a, .anime-card-title a').textContent.trim()) || '',
    href: href,
    image: window.__pBestImg(el),
    type: (el.querySelector('.anime-card-type a') && el.querySelector('.anime-card-type a').textContent.trim()) || null,
    status: (el.querySelector('.anime-card-status a') && el.querySelector('.anime-card-status a').textContent.trim()) || null,
  });
});
return { items: items };
})();`;

export const EXTRACT_RECENT = `(async function(){${HELPERS}
// Derive the parent anime URL from an episode URL by stripping the
// /episode/ prefix + الحلقة-N suffix. Mirrors lib/favorites.toAnimeUrl.
function toAnimeUrl(href) {
  if (!href) return null;
  if (href.indexOf('/anime/') >= 0) return href;
  if (href.indexOf('/episode/') < 0) return null;
  try {
    var d = decodeURIComponent(href);
    var stripped = d.replace(/-?الحلقة[-\\s]*\\d+[^/]*/, '');
    var converted = stripped.replace('/episode/', '/anime/');
    if (converted !== d && converted.indexOf('/anime/') >= 0) {
      var u = new URL(converted);
      return u.origin + u.pathname.split('/').map(function (seg, i) {
        return i === 0 ? seg : encodeURIComponent(decodeURIComponent(seg));
      }).join('/');
    }
  } catch (e) {}
  return null;
}

var ok = await window.__pWaitFor(function () {
  return !!document.querySelector('.anime-card-container, .episodes-card-container');
}, 20000);
var seen = {};
var episodes = [];
document.querySelectorAll('.anime-card-container').forEach(function (el) {
  var href = (el.querySelector('.anime-card-poster a.overlay') && el.querySelector('.anime-card-poster a.overlay').getAttribute('href')) || '';
  if (!href || seen[href]) return;
  seen[href] = true;
  var animeTitle = (el.querySelector('.anime-card-title h3 a, .anime-card-title a') && el.querySelector('.anime-card-title h3 a, .anime-card-title a').textContent.trim()) || '';
  var badge = (el.querySelector('.anime-card-status, [class*="episode"]') && el.querySelector('.anime-card-status, [class*="episode"]').textContent.trim()) || '';
  // Look for an explicit anime-page link in the card; fall back to slug-derived URL.
  var animePageEl = el.querySelector('.anime-card-title a[href*="/anime/"], .ep-card-anime-title a[href*="/anime/"], a[href*="/anime/"]');
  var animeHref = (animePageEl && animePageEl.getAttribute('href')) || toAnimeUrl(href) || href;
  episodes.push({
    title: badge ? (animeTitle + ' - ' + badge) : animeTitle,
    href: href, image: window.__pBestImg(el),
    animeTitle: animeTitle, animeHref: animeHref, isNew: true,
  });
});
return { episodes: episodes };
})();`;

/* ── TITLE MATCH (cross-source) ───────────────── */

export const EXTRACT_TITLE_MATCH = (want: string) => `(async function(){${HELPERS}
function norm(s) {
  // Keep Arabic characters too — they often carry the discriminating
  // information (e.g. "كيمي نو نا وا" vs "كيمي نو نا" partial matches).
  return String(s || '').toLowerCase()
    .replace(/\\b(season|s|part|cour|الموسم|الجزء)\\s*\\d+\\b/g, '')
    .replace(/[\\(\\[][^\\)\\]]*[\\)\\]]/g, '')
    .replace(/[^a-z0-9\\u0600-\\u06FF ]+/g, ' ')
    .replace(/\\s+/g, ' ').trim();
}
function tokens(s, minLen) {
  return s.split(' ').filter(function (w) { return w.length >= (minLen || 2); });
}
var ok = await window.__pWaitFor(function () {
  return !!document.querySelector('.anime-card-container, .no-results, .search-empty');
}, 15000);
var want = norm(${JSON.stringify(want)});
var wantWords = tokens(want, 2);
var best = { url: null, score: 0 };
document.querySelectorAll('.anime-card-container').forEach(function (el) {
  var raw = (el.querySelector('.anime-card-title h3 a') && el.querySelector('.anime-card-title h3 a').textContent) || '';
  var t = norm(raw);
  var h = el.querySelector('.anime-card-poster a.overlay') && el.querySelector('.anime-card-poster a.overlay').getAttribute('href');
  if (!h || !t) return;
  var score = 0;
  if (t === want) score = 100;
  else if (t.indexOf(want) === 0 || want.indexOf(t) === 0) score = 80;
  else {
    var gotWords = tokens(t, 2);
    var set = {};
    wantWords.forEach(function (w) { set[w] = true; });
    var common = 0;
    gotWords.forEach(function (w) { if (set[w]) common++; });
    // Coverage-based score: how many of the search-term words show up.
    var coverage = wantWords.length > 0 ? (common / wantWords.length) : 0;
    score = Math.round(coverage * 70);
    // First-word match gets a boost (titles usually start with the franchise).
    if (wantWords[0] && gotWords[0] === wantWords[0]) score += 15;
  }
  if (score > best.score) best = { url: h, score: score };
});
// Loosened threshold from 30 to 20 — better to over-match than miss entirely.
return { url: best.score >= 20 ? best.url : null, score: best.score };
})();`;

/* ── VIDEO SERVERS (episode page) ─────────────── */

export const EXTRACT_VIDEO_SERVERS = `(async function(){${HELPERS}
function provider(url) {
  url = (url || '').toLowerCase();
  if (/mp4upload/.test(url)) return 'mp4upload';
  if (/dailymotion|dai\\.ly/.test(url)) return 'dailymotion';
  if (/streamwish|hlswish|wishembed|wishfast|hgcloud|jwembed/.test(url)) return 'streamwish';
  if (/voe\\./.test(url)) return 'voe';
  if (/share4max|megamax/.test(url)) return 'share4max';
  if (/doodstream|dood\\./.test(url)) return 'doodstream';
  if (/uqload/.test(url)) return 'uqload';
  if (/ok\\.ru/.test(url)) return 'okru';
  if (/videa\\./.test(url)) return 'videa';
  if (/vk\\.com/.test(url)) return 'vk';
  return 'generic';
}
function badIframe(src) {
  if (!src || src.indexOf('http') !== 0) return true;
  if (/google|facebook|pyppo|popads|disqus/.test(src)) return true;
  return false;
}
var ok = await window.__pWaitFor(function () {
  return !!document.querySelector('iframe, #episode-servers, .server-btn, .anime-page-link, .main-section');
}, 25000);
if (!ok) return null;
await new Promise(function (r) { setTimeout(r, 1500); });

var ep = document.querySelector('.main-section h3') || document.querySelector('h1') || document.querySelector('.episode-title');
var an = document.querySelector('.anime-page-link a') || document.querySelector('h1');
var seen = {};
var out = [];
function collect() {
  document.querySelectorAll('iframe').forEach(function (f) {
    var src = (f.src || f.getAttribute('data-src') || '').trim();
    if (badIframe(src) || seen[src]) return;
    seen[src] = true;
    out.push({ id: String(out.length), name: 'Server ' + (out.length + 1), iframeUrl: src, provider: provider(src) });
  });
}
collect();

var tabs = document.querySelectorAll('#episode-servers .server-link, .server-btn, [data-server], .servers-list a, ul.servers li a, .episode-servers a, .server-tabs li, .servers-tabs a');
// Cap tab iterations + use a shorter wait — most sites swap the iframe
// synchronously after click. Was 25 tabs * 900ms = up to 22s; now 12 * 350ms = ~4s.
var TAB_CAP = 12;
var TAB_WAIT = 350;
for (var i = 0; i < tabs.length && i < TAB_CAP; i++) {
  var t = tabs[i];
  var name = (t.textContent || '').trim() || ('Server ' + (i + 1));
  try { t.click(); } catch (e) {}
  await new Promise(function (r) { setTimeout(r, TAB_WAIT); });
  var before = out.length;
  collect();
  for (var j = before; j < out.length; j++) out[j].name = name;
}

return {
  servers: out,
  episodeTitle: (ep && ep.textContent.trim()) || '',
  animeTitle: (an && an.textContent.trim()) || '',
};
})();`;

/* ── VIDEO URL EXTRACTION (embed page) ────────── */
// Returns the first m3u8/mp4 the player tries to fetch. For tokenized
// providers (mp4upload, streamwish, voe) we prefer the live URL from
// fetch/XHR hooks since the packed-JS URL has stale tokens.

export const EXTRACT_VIDEO_URL = `(async function(){
if (window.__vidHookInstalled) { /* already hooked from a previous call */ }
else {
  window.__vidHookInstalled = true;
  window.__vidHooked = [];
  function isVideo(u) { return typeof u === 'string' && /\\.(m3u8|mp4)(\\?|$)/i.test(u); }
  function isDecoy(u) {
    var lu = (u || '').toLowerCase();
    return /test-videos\\.co\\.uk|bigbuckbunny|sample[-_.]|placeholder|tos\\.mp4|googleapis\\.com\\/.*oggtheora|\\/lol\\/file\\.mp4/.test(lu);
  }
  function maybe(u) { if (isVideo(u) && !isDecoy(u) && window.__vidHooked.indexOf(u) === -1) window.__vidHooked.push(u); }
  var oFetch = window.fetch;
  if (oFetch) window.fetch = function (i, init) { try { maybe(typeof i === 'string' ? i : (i && i.url)); } catch (e) {} return oFetch.apply(this, arguments); };
  var oOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) { try { maybe(u); } catch (e) {} return oOpen.apply(this, arguments); };
  setInterval(function () {
    document.querySelectorAll('video').forEach(function (v) {
      if (v.src) maybe(v.src);
      v.querySelectorAll('source').forEach(function (s) { if (s.src) maybe(s.src); });
    });
  }, 100);
}

function pick(i) {
  var us = (window.__vidHooked || []).slice();
  if (!us.length) return null;
  function isSafeMp4(url) {
    try {
      var h = new URL(url).hostname.toLowerCase();
      var e = location.hostname.toLowerCase();
      if (h === e || h.indexOf(e) !== -1 || e.indexOf(h) !== -1) return true;
      return /streamwish|hgcloud|wishfast|wishembed|jwembed|hlswish|vibuxer|audinifer|masukestin|hanerix|mp4upload|voe|doodstream|dood|uqload|share4max|megamax|videa|okru|vk|dailymotion|dai\\.ly/.test(h);
    } catch(err) { return false; }
  }

  var m3 = us.find(function (u) { return /master\\.m3u8|playlist\\.m3u8|index\\.m3u8/i.test(u); }) || us.find(function (u) { return /\.m3u8/i.test(u); });
  if (m3) return m3;

  // Wait 2.5s (25 iterations) to give .m3u8 a chance before settling for a safe .mp4
  if (i >= 25) {
    var mp4 = us.find(function (u) { return /\.mp4/i.test(u) && isSafeMp4(u); });
    if (mp4) return mp4;
  }

  // Last resort
  if (i === 199) {
    return us.find(function (u) { return /\.mp4/i.test(u); });
  }

  return null;
}
function trigger() {
  ['.jw-icon-display', '.vjs-big-play-button', '.plyr__control--overlaid', 'button[aria-label*="lay" i]', '.play', 'button'].forEach(function (sel) {
    var el = document.querySelector(sel); if (el) { try { el.click(); } catch (e) {} }
  });
  document.querySelectorAll('video').forEach(function (v) { try { v.muted = true; v.play().catch(function () {}); } catch (e) {} });
}

// Dailymotion: hit the metadata API directly (works without play interaction).
async function tryDailymotion() {
  try {
    var m = location.href.match(/(?:dailymotion\\.com\\/(?:embed\\/)?video\\/|dai\\.ly\\/)([a-zA-Z0-9]+)/);
    if (!m) return null;
    var r = await fetch('https://www.dailymotion.com/player/metadata/video/' + m[1], { credentials: 'omit' });
    var d = await r.json();
    if (!d || !d.qualities) return null;
    var order = ['1080','720','480','380','240'];
    for (var i = 0; i < order.length; i++) {
      var arr = d.qualities[order[i]];
      if (arr && arr.length) {
        var mp4 = arr.find(function (v) { return v.type === 'video/mp4'; });
        if (mp4 && mp4.url) return mp4.url;
      }
    }
    return null;
  } catch (e) { return null; }
}

var dm = await tryDailymotion();
if (dm) return { url: dm };

// Trigger play; poll the hook for up to 20 s. Re-trigger frequently
// because some embeds need multiple nudges to bind the click handler
// (cookie consent overlays, ad gating, late-loaded player JS, etc).
trigger();
await new Promise(function (r) { setTimeout(r, 100); });
trigger();
for (var i = 0; i < 200; i++) {
  var h = pick(i);
  if (h) return { url: h };
  if (i % 5 === 0) trigger();
  await new Promise(function (r) { setTimeout(r, 100); });
}

// HTML fallback — scan for packed-JS file:/src: URLs
var html = document.documentElement.outerHTML || '';
var packed = html.match(/file\\s*:\\s*["']([^"']+\\.(?:m3u8|mp4)[^"']*)["']/i);
if (packed) return { url: packed[1] };
var generic = html.match(/https?:\\/\\/[^"'\\s<>]+\\.(?:m3u8|mp4)[^"'\\s<>]*/);
if (generic) return { url: generic[0] };

return null;
})();`;
