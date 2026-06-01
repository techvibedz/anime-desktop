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
var WANT = ${JSON.stringify(want)};
// Season number from a title — handles latin (season/s/part/cour) and
// arabic (الموسم/الجزء) with arabic-indic digits. Defaults to 1.
function seasonNum(s) {
  s = (s || '').toLowerCase();
  var m = s.match(/\\b(?:season|s|part|cour)\\s*(\\d+)\\b/) || s.match(/الموسم\\s*([\\u0660-\\u0669\\d]+)/) || s.match(/الجزء\\s*([\\u0660-\\u0669\\d]+)/);
  if (!m) return 1;
  var n = m[1].replace(/[\\u0660-\\u0669]/g, function (d) { return String(d.charCodeAt(0) - 0x0660); });
  var v = parseInt(n, 10);
  return isNaN(v) ? 1 : v;
}
// Latin normalization: drop season noise + filler particles so the
// discriminating franchise words dominate the overlap score.
function normLatin(s) {
  return String(s || '').toLowerCase()
    .replace(/\\b(?:season|s|part|cour)\\s*\\d+\\b/g, ' ')
    .replace(/\\b(?:the|a|an|of|to|wa|no|wo|ga|ni)\\b/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\\s+/g, ' ').trim();
}
// Arabic normalization: strip tashkeel, unify alef/teh-marbuta/alef-maqsura,
// keep only arabic letters.
function normArabic(s) {
  return String(s || '')
    .replace(/[\\u064B-\\u065F\\u0670]/g, '')
    .replace(/[\\u0622\\u0623\\u0625]/g, '\\u0627')
    .replace(/\\u0629/g, '\\u0647')
    .replace(/\\u0649/g, '\\u064A')
    .replace(/[^\\u0600-\\u06FF ]+/g, ' ')
    .replace(/\\s+/g, ' ').trim();
}
function toks(s) { return s ? s.split(' ').filter(function (w) { return w.length >= 2; }) : []; }
// Shared-token ratio against the SMALLER token set (0..1) so a short query
// fully contained in a longer title still scores high.
function overlap(a, b) {
  var A = toks(a), B = toks(b);
  if (!A.length || !B.length) return 0;
  var setB = {}; B.forEach(function (w) { setB[w] = true; });
  var common = 0; A.forEach(function (w) { if (setB[w]) common++; });
  return common / Math.min(A.length, B.length);
}
function score(title) {
  var latinWant = normLatin(WANT), latinGot = normLatin(title);
  var arWant = normArabic(WANT), arGot = normArabic(title);
  var latinOverlap = overlap(latinWant, latinGot);
  var arabicOverlap = overlap(arWant, arGot);
  var s = 0;
  if (latinWant && latinGot === latinWant) s = 100;
  else if (latinWant && latinGot.indexOf(latinWant) === 0) s = 85;
  else if (arWant && arGot === arWant) s = 95;
  else s = Math.round(Math.max(latinOverlap, arabicOverlap) * 75);
  // Season agreement tie-breaker.
  var sw = seasonNum(WANT), sg = seasonNum(title);
  if (sw === sg) s += 8; else s -= 12;
  return s;
}
var ok = await window.__pWaitFor(function () {
  return !!document.querySelector('.anime-card-container, .no-results, .search-empty');
}, 15000);
var best = { url: null, score: 0 };
document.querySelectorAll('.anime-card-container').forEach(function (el) {
  var titleEl = el.querySelector('.anime-card-title h3 a');
  var hrefEl = el.querySelector('.anime-card-poster a.overlay');
  var title = (titleEl && titleEl.textContent.trim()) || '';
  var h = hrefEl && hrefEl.getAttribute('href');
  if (!h || !title) return;
  var s = score(title);
  if (s > best.score) best = { url: h, score: s };
});
// ~0.5 token-overlap ratio (≈37 raw) is enough to accept a cross-source match.
return { url: best.score >= 34 ? best.url : null, score: best.score };
})();`;

/* ── VIDEO SERVERS (episode page) ─────────────── */

export const EXTRACT_VIDEO_SERVERS = `(async function(){${HELPERS}
function provider(url) {
  url = (url || '').toLowerCase();
  if (/mp4upload/.test(url)) return 'mp4upload';
  if (/dailymotion|dai\\.ly/.test(url)) return 'dailymotion';
  if (/streamwish|hlswish|wishembed|wishfast|hgcloud|jwembed|vibuxer|audinifer|masukestin|hanerix/.test(url)) return 'streamwish';
  if (/voe\\./.test(url)) return 'voe';
  if (/share4max|megamax/.test(url)) return 'share4max';
  if (/rubyvidhub|streamruby|rubystm|ruby/.test(url)) return 'streamruby';
  if (/doodstream|dood\\.|dsvplay|d-s\\.io|vidply/.test(url)) return 'doodstream';
  if (/uqload/.test(url)) return 'uqload';
  if (/ok\\.ru/.test(url)) return 'okru';
  if (/videa\\.|vidvaita|vidit/.test(url)) return 'videa';
  if (/vk\\.com/.test(url)) return 'vk';
  return 'generic';
}
function badIframe(src) {
  if (!src || src.indexOf('http') !== 0) return true;
  if (/google|facebook|pyppo|popads|disqus/.test(src)) return true;
  // Reject malformed hosts. witanime's loadIframe() decode occasionally
  // fails and points the iframe at "https://undefined/<encoded>", which
  // then dies at playback with ERR_NAME_NOT_RESOLVED. A real provider host
  // always URL-parses and contains a dot.
  try {
    var h = new URL(src).hostname.toLowerCase();
    if (!h || h === 'undefined' || h === 'null' || h.indexOf('.') < 0) return true;
  } catch (e) { return true; }
  return false;
}
// Normalize provider URLs to their EMBED form so they autoplay inside an
// iframe. anime4up often stores the mp4upload WATCH-page URL
// (https://www.mp4upload.com/CODE) in data-watch, which renders the download
// page instead of the player — so mp4upload "doesn't work" from anime4up
// while it works from witanime (which supplies the embed URL directly).
function normalizeEmbed(src) {
  try {
    var u = new URL(src);
    if (/mp4upload/.test(u.hostname)) {
      if (/\\/embed-/.test(u.pathname)) return src; // already embed form
      var m = u.pathname.match(/^\\/([a-z0-9]{8,})/i);
      if (m) return 'https://www.mp4upload.com/embed-' + m[1] + '.html';
    }
  } catch (e) {}
  return src;
}

// Fast lane: check for iframes immediately (most pages render them in the
// initial HTML). Only fall back to the slow __pWaitFor path if nothing found.
var ep = document.querySelector('.main-section h3') || document.querySelector('h1') || document.querySelector('.episode-title');
var an = document.querySelector('.anime-page-link a') || document.querySelector('h1');
var seen = {};
var out = [];

function collect() {
  // anime4up servers: the embed URL lives in a data-watch attribute on
  // each tab <li>; the live iframe is only injected by JS on click and
  // the markup also hides copies inside inert <noscript> tags. Read the
  // attribute directly so we capture every server without depending on
  // click handlers firing inside the headless window. Run before the
  // iframe pass so the default-active server keeps its real label.
  document.querySelectorAll('#episode-servers li[data-watch], #watch-servers li[data-watch], li[data-watch]').forEach(function (li) {
    var src = normalizeEmbed((li.getAttribute('data-watch') || '').trim());
    if (badIframe(src) || seen[src]) return;
    seen[src] = true;
    // The label sits in the <a> alongside a <noscript><iframe></noscript>
    // copy of the embed; with JS enabled the browser exposes that noscript
    // markup as inert text, so reading textContent directly drags the whole
    // iframe URL into the name. Strip those nodes off a clone first.
    var a = li.querySelector('a');
    var name = '';
    if (a) {
      var labelEl = a.cloneNode(true);
      labelEl.querySelectorAll('noscript, iframe, script').forEach(function (n) {
        if (n.parentNode) n.parentNode.removeChild(n);
      });
      name = (labelEl.textContent || '').replace(/\\s+/g, ' ').trim();
    }
    if (!name) name = 'Server ' + (out.length + 1);
    out.push({ id: String(out.length), name: name, iframeUrl: src, provider: provider(src) });
  });
  document.querySelectorAll('iframe').forEach(function (f) {
    var src = normalizeEmbed((f.src || f.getAttribute('data-src') || '').trim());
    if (badIframe(src) || seen[src]) return;
    seen[src] = true;
    out.push({ id: String(out.length), name: 'Server ' + (out.length + 1), iframeUrl: src, provider: provider(src) });
  });
}

// 1st pass: grab whatever iframes are already in the DOM (fast).
collect();

// 2nd pass: wait briefly for JS to swap in server iframes, then collect again.
// Only pull the heavy wait if we have zero servers so far.
if (out.length === 0) {
  var ok = await window.__pWaitFor(function () {
    return !!document.querySelector('iframe, #episode-servers, .server-btn, .anime-page-link, .main-section');
  }, 8000);
} else {
  // At least one iframe visible — short wait for JS to finish rendering tabs.
  await new Promise(function (r) { setTimeout(r, 200); });
}

// Re-collect after JS has finished stitching the page.
collect();

// Click every server tab so we discover all iframes hidden behind
// tabs that weren't initially visible. The 150 ms wait between clicks
// gives each tab's iframe time to render before we scan.
var tabs = document.querySelectorAll('#episode-servers .server-link, .server-btn, [data-server], .servers-list a, ul.servers li a, .episode-servers a, .server-tabs li, .servers-tabs a');
if (tabs.length > 0) {
  var TAB_CAP = 10;
  var TAB_WAIT = 150;
  for (var i = 0; i < tabs.length && i < TAB_CAP; i++) {
    var t = tabs[i];
    var name = (t.textContent || '').trim() || ('Server ' + (i + 1));
    try { t.click(); } catch (e) {}
    await new Promise(function (r) { setTimeout(r, TAB_WAIT); });
    var before = out.length;
    collect();
    for (var j = before; j < out.length; j++) out[j].name = name;
  }
}

// Harvest a DIRECT anime4up link straight off the witanime episode page.
// witanime often embeds the matching anime4up episode (or anime) URL in
// the markup. Using it skips the slow cross-source title-search +
// sibling-number-match chain entirely, so anime4up servers appear fast.
var up4EpisodeUrl = null, up4AnimeUrl = null;
document.querySelectorAll('a[href*="anime4up"]').forEach(function (a) {
  var h = (a.getAttribute('href') || '').trim();
  if (!h) return;
  if (h.indexOf('http') !== 0) h = (h.indexOf('//') === 0 ? 'https:' : 'https://') + h.replace(/^\\/+/, '');
  var dh = h; try { dh = decodeURIComponent(h); } catch (e) {}
  if (/\\/episode\\/|الحلقة/.test(dh)) { if (!up4EpisodeUrl) up4EpisodeUrl = h; }
  else if (/anime4up/.test(h) && !up4AnimeUrl) up4AnimeUrl = h;
});

return {
  servers: out,
  episodeTitle: (ep && ep.textContent.trim()) || '',
  animeTitle: (an && an.textContent.trim()) || '',
  up4EpisodeUrl: up4EpisodeUrl,
  up4AnimeUrl: up4AnimeUrl,
};
})();`;

/* ── VIDEO URL EXTRACTION (embed page) ────────── */
// Returns the first m3u8/mp4 the player tries to fetch. For tokenized
// providers (mp4upload, streamwish, voe) we prefer the live URL from
// fetch/XHR hooks since the packed-JS URL has stale tokens.
// NOTE: Dailymotion is handled separately — we render its iframe directly
// instead of extracting raw URLs (their tokens are too heavily encrypted).

/**
 * Hook installer — designed to run as `injectBefore` so the fetch / XHR
 * interceptors are armed on every navigation BEFORE page scripts execute.
 * Without this, ad-gate redirects swap the document and the
 * later-injected hooks would have already missed the live stream URL.
 *
 * Safe to re-run; the `__vidHookInstalled` guard makes subsequent calls
 * a no-op. Stores captured URLs on `window.__vidHooked` (array).
 */
export const VIDEO_HOOK_INSTALL = `(function () {
  try {
    if (window.__vidHookInstalled) return;
    window.__vidHookInstalled = true;
    window.__vidHooked = [];
    function isVideo(u) { return typeof u === 'string' && /\\.(m3u8|mp4)(\\?|$|#)/i.test(u); }
    function isDecoy(u) {
      var lu = (u || '').toLowerCase();
      return /test-videos\\.co\\.uk|bigbuckbunny|sample[-_.]|placeholder|tos\\.mp4|googleapis\\.com\\/.*oggtheora|\\/lol\\/file\\.mp4/.test(lu);
    }
    function maybe(u) {
      if (!isVideo(u) || isDecoy(u)) return;
      if (window.__vidHooked.indexOf(u) === -1) window.__vidHooked.push(u);
    }
    var oFetch = window.fetch;
    if (oFetch) {
      window.fetch = function (i, init) {
        try { maybe(typeof i === 'string' ? i : (i && i.url)); } catch (e) {}
        return oFetch.apply(this, arguments);
      };
    }
    var oOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u) {
      try { maybe(u); } catch (e) {}
      return oOpen.apply(this, arguments);
    };
    // Scan <video>/<source> tags every 100ms for src changes the player
    // assigns directly (some players bypass fetch entirely).
    setInterval(function () {
      try {
        document.querySelectorAll('video').forEach(function (v) {
          if (v.src) maybe(v.src);
          v.querySelectorAll('source').forEach(function (s) { if (s.src) maybe(s.src); });
        });
      } catch (e) {}
    }, 100);
  } catch (e) {}
})();`;

export const EXTRACT_VIDEO_URL = `(async function(){
// Defensive: install hooks here too in case injectBefore didn't fire
// (e.g. cached page navigation that skipped did-start-navigation).
${VIDEO_HOOK_INSTALL}

function isBadHost(h) {
  h = (h || '').toLowerCase();
  // Known decoy / ad / tracking hosts.
  return /test-videos\\.co\\.uk|bigbuckbunny|sample[-_.]|placeholder|tos\\.mp4|google|facebook|doubleclick|popads|propeller|trafficjunky|popcash|disqus|googleapis|googletag|analytics/.test(h);
}

function isSafeUrl(url) {
  try {
    var h = new URL(url).hostname.toLowerCase();
    if (isBadHost(h)) return false;
    // Accept: same host, subdomain match, or any credible video-looking URL
    // from a reasonable hostname (at least one dot, not an IP-only host).
    // This catches streamwish CDN subdomains that use random-sounding hosts
    // (cybervynx.com, medixiru.com etc.) which were silently rejected by
    // the old hardcoded whitelist.
    return h.includes('.') && !/^\\d+\\.\\d+/.test(h);
  } catch (err) { return false; }
}

function pickFromHooked() {
  var us = (window.__vidHooked || []).slice();
  if (!us.length) return null;
  // Prefer named playlists (master/index/playlist) then any m3u8.
  var m3 = us.find(function (u) { return /(master|playlist|index)\\.m3u8/i.test(u) && isSafeUrl(u); }) ||
           us.find(function (u) { return /\\.m3u8/i.test(u) && isSafeUrl(u); });
  if (m3) return m3;
  return us.find(function (u) { return /\\.mp4/i.test(u) && isSafeUrl(u); }) || null;
}

// Wait until Cloudflare's "Just a moment" challenge has cleared. Some
// providers (streamwish, voe) put their embed pages behind CF.
// 8s max so we don't burn the whole job budget on CF alone.
async function waitForCfChallenge() {
  for (var i = 0; i < 32; i++) {
    var title = (document.title || '').toLowerCase();
    var hasChallenge = !!document.querySelector(
      '#challenge-running, .cf-browser-verification, #challenge-stage, #cf-challenge-running, #cf-please-wait'
    );
    if (!hasChallenge && title.indexOf('just a moment') < 0 && title.indexOf('moment') < 0) {
      return true;
    }
    await new Promise(function (r) { setTimeout(r, 250); });
  }
  return false;
}

// HTML / packed-JS regex pass. Most embeds inline the source URL in
// the initial HTML; this short-circuits the play-button flow entirely
// when the URL is already accessible.
function scanInlineSources() {
  try {
    var html = document.documentElement ? document.documentElement.outerHTML : '';
    // Try packed-player keys first, in priority order. master/index/playlist m3u8 is the strongest signal.
    var patterns = [
      /file\\s*:\\s*["']([^"']+\\.(?:m3u8|mp4)[^"']*)["']/i,
      /source\\s*:\\s*["']([^"']+\\.(?:m3u8|mp4)[^"']*)["']/i,
      /src\\s*:\\s*["']([^"']+\\.(?:m3u8|mp4)[^"']*)["']/i,
      /sources\\s*:\\s*\\[\\s*\\{\\s*[^}]*?(?:file|src)\\s*:\\s*["']([^"']+\\.(?:m3u8|mp4)[^"']*)["']/i,
    ];
    for (var i = 0; i < patterns.length; i++) {
      var m = html.match(patterns[i]);
      if (m && isSafeUrl(m[1])) return m[1];
    }
    // Generic URL scan as a last resort — pick the first URL whose
    // host looks like a real video CDN.
    var rx = /https?:\\/\\/[^"'\\s<>\\\\]+\\.(?:m3u8|mp4)[^"'\\s<>\\\\]*/g;
    var any;
    while ((any = rx.exec(html))) {
      if (isSafeUrl(any[0])) return any[0];
    }
  } catch (e) {}
  return null;
}

function dismissOverlays() {
  var sels = [
    '.cc-window .cc-dismiss', '.cc-window .cc-allow', '.cc-window .cc-btn',
    '#cookieconsent .cc-btn', '#cookieconsent button',
    '.cookie-banner button', '.cookie-consent button',
    '[id*="cookie"] button[class*="accept"]', '[id*="cookie"] button[class*="agree"]',
    '.fc-cta-consent', '.fc-button-label',
    '.ad-close', '.close-ad', '[class*="adClose"]', '[id*="adClose"]',
    '#ad-overlay .close', '.popup-close', '[aria-label*="close" i]',
  ];
  sels.forEach(function (s) {
    document.querySelectorAll(s).forEach(function (el) {
      try { el.click(); } catch (e) {}
    });
  });
}

function trigger() {
  dismissOverlays();
  var sels = [
    '.jw-icon-display', '.jw-display-icon-container',
    '.vjs-big-play-button', '.video-js .vjs-big-play-button',
    '.plyr__control--overlaid', '.plyr--init .plyr__control',
    'button[aria-label*="lay" i]', 'button[title*="lay" i]',
    '[class*="play-btn"]', '[class*="playBtn"]', '[id*="play-button"]',
    '#player .play', '.play-btn', '.play',
    '#player', 'button',
  ];
  sels.forEach(function (sel) {
    var els = document.querySelectorAll(sel);
    for (var i = 0; i < Math.min(els.length, 3); i++) {
      try { els[i].click(); } catch (e) {}
    }
  });
  document.querySelectorAll('video').forEach(function (v) {
    try {
      v.muted = true;
      if (v.paused) v.play().catch(function () {});
      try { v.click(); } catch (e) {}
    } catch (e) {}
  });
}

// Videa-specific extractor: their player loads sources from a known
// XML API.
async function tryVidea() {
  try {
    if (!/videa|vidvaita|vidit/i.test(location.hostname)) return null;
    var m = location.href.match(/[?&]v=([a-zA-Z0-9]+)/) ||
            location.href.match(/\\/player\\/v\\/([a-zA-Z0-9]+)/) ||
            location.href.match(/\\/([a-zA-Z0-9]{8,})(?:\\?|$|\\/)/);
    if (!m) return null;
    var id = m[1];
    var endpoints = [
      location.origin + '/player/xml?platform=desktop&v=' + id,
      location.origin + '/videaplayer_get_xml.php?v=' + id,
    ];
    for (var i = 0; i < endpoints.length; i++) {
      try {
        var ctrl = new AbortController();
        var timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, 4000);
        var r = await fetch(endpoints[i], { credentials: 'include', signal: ctrl.signal });
        clearTimeout(timer);
        if (!r.ok) continue;
        var text = await r.text();
        var src = text.match(/<video_source[^>]*>\\s*<!\\[CDATA\\[([^\\]]+)\\]\\]>/i) ||
                  text.match(/<video_source[^>]*>([^<]+)</i) ||
                  text.match(/https?:\\/\\/[^"<\\s]+\\.(?:m3u8|mp4)[^"<\\s]*/i);
        if (src) return src[1] || src[0];
      } catch (e) {}
    }
    return null;
  } catch (e) { return null; }
}

// ── Run extraction ──
await waitForCfChallenge();

// Fast path A: provider-specific direct extractors.
var pre = await tryVidea();
if (pre) return { url: pre };

// Fast path B: inline-source regex on the loaded page.
var inline = scanInlineSources();
if (inline) return { url: inline };

// Some pages already kicked off the player by autoplay — check hooks
// before doing anything intrusive.
var early = pickFromHooked();
if (early) return { url: early };

// Trigger play and poll for up to 14 s. Was 20 s before; in practice
// any modern player reveals its URL within 5–8 s of click. Anything
// longer than 14 s usually means the embed is permanently broken and
// the user is better off advancing to the next server.
trigger();
await new Promise(function (r) { setTimeout(r, 150); });
trigger();
for (var i = 0; i < 140; i++) {
  var h = pickFromHooked();
  if (h) return { url: h };
  // Re-trigger every 800 ms; some embeds bind their click handler late.
  if (i > 0 && i % 8 === 0) trigger();
  // Inline scan in case JS just injected the URL into the DOM.
  if (i > 0 && i % 10 === 0) {
    var lateInline = scanInlineSources();
    if (lateInline) return { url: lateInline };
  }
  await new Promise(function (r) { setTimeout(r, 100); });
}

// One last inline pass.
var finalInline = scanInlineSources();
if (finalInline) return { url: finalInline };

return null;
})();`;
