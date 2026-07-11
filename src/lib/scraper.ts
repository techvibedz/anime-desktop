// Thin wrapper around window.pantoufa.scrape (preload-exposed IPC).
// Mirrors the mobile app's lib/scraper/index.ts so the higher-level
// lib/api.ts can be ported almost verbatim.

import {
  EXTRACT_HOME_WIT,
  EXTRACT_HOME_4UP,
  EXTRACT_EPISODES_WIT,
  EXTRACT_EPISODES_4UP,
  EXTRACT_SEARCH,
  EXTRACT_RECENT,
  EXTRACT_LISTING,
  EXTRACT_TITLE_MATCH,
  EXTRACT_TITLE_MATCH_A3RB,
  EXTRACT_VIDEO_SERVERS,
  EXTRACT_VIDEO_URL,
  VIDEO_HOOK_INSTALL,
} from "./scripts";
import { fuzzyScore } from "./fuzzy";

const WIT_BASE = "https://witanime.you";
const UP4_BASE = "https://w1.anime4up.rest";
const A3RB_BASE = "https://anime3rb.com";
const ALL_ANIME_PATH = encodeURIComponent("قائمة-الانمي");

function enqueue<T>(job: {
  url: string;
  injectBefore?: string;
  injectAfter: string;
  timeoutMs: number;
  isVideoJob?: boolean;
  priority?: boolean;
}): Promise<T> {
  return window.pantoufa.scrape(job) as Promise<T>;
}

export type RawAnime = {
  title: string; href: string; image: string | null;
  type: string | null; status: string | null; description: string | null;
  isNew: boolean; rating: string | null;
};
export type RawFeatured = {
  title: string; href: string; image: string | null;
  description: string | null; genres: string[];
};
export type RawEpisodeCard = {
  title: string; href: string; image: string | null;
  animeTitle: string; animeHref: string; isNew: boolean;
};

export async function scrapeWitanimeHome() {
  return enqueue<{ featured: RawFeatured[]; animes: RawAnime[]; episodes: RawEpisodeCard[] }>({
    url: `${WIT_BASE}/`, injectAfter: EXTRACT_HOME_WIT, timeoutMs: 35000,
  });
}

export async function scrapeAnime4upHome() {
  return enqueue<{ animes: Pick<RawAnime, "title" | "href" | "image" | "type">[] }>({
    url: `${UP4_BASE}/home8/`, injectAfter: EXTRACT_HOME_4UP, timeoutMs: 35000,
  });
}

export type RawDetail = {
  title: string; poster: string; synopsis: string; genres: string[];
  episodes: { title: string; number: number; type: string; screenshot: string; href: string | null }[];
  /** Direct anime4up link discovered on the wit page (when present). */
  up4Url?: string | null;
};

export async function scrapeEpisodesPage(animeUrl: string) {
  const is4up = /anime4up/i.test(animeUrl);
  return enqueue<RawDetail>({
    url: animeUrl,
    injectAfter: is4up ? EXTRACT_EPISODES_4UP : EXTRACT_EPISODES_WIT,
    timeoutMs: 35000,
  });
}

export async function scrapeSearch(query: string) {
  const url = `${WIT_BASE}/?s=${encodeURIComponent(query)}&search_param=animes`;
  return enqueue<{ results: { title: string; href: string; image: string | null; type: string | null; status: string | null; synopsis: string | null }[] }>({
    url, injectAfter: EXTRACT_SEARCH, timeoutMs: 25000,
  });
}

export async function scrapeRecent(page = 1) {
  const url = `${WIT_BASE}/episode/page/${page}/`;
  return enqueue<{ episodes: RawEpisodeCard[] }>({
    url, injectAfter: EXTRACT_RECENT, timeoutMs: 30000,
  });
}

export async function scrapeGenre(arabicSlug: string, page = 1) {
  const url = page === 1
    ? `${WIT_BASE}/anime-genre/${arabicSlug}/`
    : `${WIT_BASE}/anime-genre/${arabicSlug}/page/${page}/`;
  return enqueue<{ items: { title: string; href: string; image: string | null; type: string | null; status: string | null; synopsis: null }[] }>({
    url, injectAfter: EXTRACT_LISTING, timeoutMs: 30000,
  });
}

export async function scrapeAllAnime(page = 1) {
  const url = page === 1
    ? `${WIT_BASE}/${ALL_ANIME_PATH}/`
    : `${WIT_BASE}/${ALL_ANIME_PATH}/page/${page}/`;
  return enqueue<{ items: { title: string; href: string; image: string | null; type: string | null; status: string | null; synopsis: null }[] }>({
    url, injectAfter: EXTRACT_LISTING, timeoutMs: 30000,
  });
}

export async function findCrossSourceUrl(
  title: string,
  primarySource: "witanime" | "anime4up",
): Promise<string | null> {
  if (!title) return null;
  const wantTarget = primarySource === "witanime" ? "anime4up" : "witanime";
  const base = wantTarget === "anime4up" ? UP4_BASE : WIT_BASE;
  const searchUrl = `${base}/?search_param=animes&s=${encodeURIComponent(title)}`;
  try {
    const r = await enqueue<{ url: string | null; score: number }>({
      url: searchUrl, injectAfter: EXTRACT_TITLE_MATCH(title), timeoutMs: 40000,
    });
    return r.url;
  } catch {
    return null;
  }
}

export type RawServer = { id: string; name: string; iframeUrl: string; provider: string };

export async function scrapeVideoServers(episodeUrl: string) {
  console.info(`[scraper] scraping video servers from: ${episodeUrl}`);
  const result = await enqueue<{ servers: RawServer[]; episodeTitle: string; animeTitle: string; up4EpisodeUrl?: string | null; up4AnimeUrl?: string | null }>({
    // priority: the user is sitting on the watch page waiting for this —
    // it must never queue behind background home/listing scrapes.
    url: episodeUrl, injectAfter: EXTRACT_VIDEO_SERVERS, timeoutMs: 25000, priority: true,
  });
  if (!result || !Array.isArray(result.servers)) {
    console.warn(`[scraper] failed to scrape ${episodeUrl}, returning empty result`);
    return { servers: [], episodeTitle: '', animeTitle: '', up4EpisodeUrl: null, up4AnimeUrl: null };
  }
  console.info(`[scraper] extracted ${result.servers.length} servers, episode: ${result.episodeTitle}`);
  return result;
}

// Classify a server URL into the provider id the resolver special-cases.
// Mirrors the provider() helper inside EXTRACT_VIDEO_SERVERS.
function classifyProvider(url: string): string {
  const u = (url || "").toLowerCase();
  if (/mp4upload/.test(u)) return "mp4upload";
  if (/dailymotion|dai\.ly/.test(u)) return "dailymotion";
  if (/streamwish|hlswish|wishembed|wishfast|hgcloud|jwembed|vibuxer|audinifer|masukestin|hanerix|playerwish/.test(u)) return "streamwish";
  if (/voe\./.test(u)) return "voe";
  if (/share4max|megamax/.test(u)) return "share4max";
  if (/rubyvidhub|streamruby|rubystm|ruby/.test(u)) return "streamruby";
  if (/doodstream|dood\.|dsvplay|d-s\.io|vidply/.test(u)) return "doodstream";
  if (/uqload/.test(u)) return "uqload";
  if (/ok\.ru/.test(u)) return "okru";
  if (/videa\.|vidvaita|vidit/.test(u)) return "videa";
  if (/vk\.com/.test(u)) return "vk";
  if (/vid3rb|anime3rb/.test(u)) return "vid3rb";
  // witanime's current default hosts. Give them their own ids so they aren't
  // classified "generic" and dropped by the witanime-generic filter in
  // doFetchVideoServers — they play via the iframe fallback.
  if (/luluvdo|lulustream|luluvid/.test(u)) return "luluvdo";
  if (/yonaplay/.test(u)) return "yonaplay";
  return "generic";
}

// Normalize mp4upload URLs to the canonical embed form so they autoplay.
// anime4up hands out two broken-for-us shapes:
//   1. watch-page URLs (https://mp4upload.com/CODE) → render the download page
//   2. embed URLs on the bare host (https://mp4upload.com/embed-CODE.html) →
//      301-redirect to www.mp4upload.com, so the iframe's real URL ends up on
//      a different host than the one we tracked for referer / did-fail-load,
//      and the embed renders blank.
// Force https://www.mp4upload.com/embed-CODE.html in every case so the URL we
// load, force a Referer for, and track for failure all agree.
function normalizeEmbedUrl(src: string): string {
  try {
    const u = new URL(src);
    if (/mp4upload/.test(u.hostname)) {
      const embedM = u.pathname.match(/\/embed-([a-z0-9]+)\.html/i);
      if (embedM) return `https://www.mp4upload.com/embed-${embedM[1]}.html`;
      const codeM = u.pathname.match(/^\/([a-z0-9]{8,})/i);
      if (codeM) return `https://www.mp4upload.com/embed-${codeM[1]}.html`;
    }
  } catch {}
  return src;
}

// Read anime4up's server list straight from the episode page HTML. anime4up
// serves every server as a <li data-watch="EMBED_URL"><a>NAME</a></li> in the
// initial response, so a single privileged GET (no CORS, no headless render)
// returns all servers fast and reliably — the headless window trips
// anime4up's ad redirects / JS gates and frequently comes back empty.
function parseUp4Servers(html: string): RawServer[] {
  // Constrain to the #episode-servers list when present to avoid menu/li noise.
  let scope = html;
  const segStart = html.indexOf('id="episode-servers"');
  if (segStart >= 0) {
    const segEnd = html.indexOf("</ul>", segStart);
    if (segEnd > segStart) scope = html.slice(segStart, segEnd);
  }
  const out: RawServer[] = [];
  const seen = new Set<string>();
  const re = /<li[^>]*\sdata-watch=["']([^"']+)["'][^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(scope))) {
    const src = normalizeEmbedUrl((m[1] || "").trim());
    if (!src || src.indexOf("http") !== 0 || seen.has(src)) continue;
    if (/google|facebook|pyppo|popads|disqus/.test(src)) continue;
    try {
      const h = new URL(src).hostname.toLowerCase();
      if (!h || h === "undefined" || h === "null" || h.indexOf(".") < 0) continue;
    } catch { continue; }
    seen.add(src);
    const name = (m[2] || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() || `Server ${out.length + 1}`;
    out.push({ id: String(out.length), name, iframeUrl: src, provider: classifyProvider(src) });
  }
  return out;
}

export async function scrapeAnime4upServersDirect(episodeUrl: string): Promise<RawServer[]> {
  const html = await window.pantoufa.fetchHtml?.(episodeUrl, UP4_BASE + "/");
  if (!html) return [];
  return parseUp4Servers(html);
}

// ── witanime direct server decode ──
// witanime no longer ships plain server iframes. Each episode page carries an
// obfuscated registry — `_zX` = a base64 JSON array of reversed+base64 embed
// URLs, `_zK` = per-server decode config — that the site's gh100.js
// `renderModuleContent()` decodes on click to build the iframe. The headless
// scrape depends on those clicks firing AND the site JS running past its
// Cloudflare gate, which frequently comes back empty → "no servers". Decoding
// the registry straight from the static HTML (privileged GET, no headless) is
// fast and reliable — mirrors the anime4up direct path. Ported 1:1 from gh100.
// ponytail: FRAMEWORK_HASH is hardcoded in gh100.js and only yonaplay embeds
// need it appended; if witanime rotates it, re-read gh100.js. Cap: this one
// constant. Everything else is derived per-response from _zX/_zK.
const WIT_FRAMEWORK_HASH = "23a97133-caf3-4eb4-9466-93d0a4ff8198";

function witDecodeServer(res: string, cfg: { d?: number[]; k?: string }): string | null {
  try {
    if (!res || !cfg || !Array.isArray(cfg.d) || !cfg.k) return null;
    const s = res.split("").reverse().join("").replace(/[^A-Za-z0-9+/=]/g, "");
    const off = cfg.d[parseInt(atob(cfg.k), 10)];
    if (off == null || off < 0) return null;
    const decoded = atob(s);
    let out = decoded.slice(0, decoded.length - off);
    if (/^https:\/\/yonaplay\.net\/embed\.php\?id=\d+$/.test(out)) out += "&apiKey=" + WIT_FRAMEWORK_HASH;
    return out;
  } catch { return null; }
}

function parseWitServers(html: string): RawServer[] {
  const zx = html.match(/_zX\s*=\s*"([^"]+)"/);
  const zk = html.match(/_zK\s*=\s*"([^"]+)"/);
  if (!zx || !zk) return [];
  let reg: string[], cfg: { d?: number[]; k?: string }[];
  try {
    reg = JSON.parse(atob(zx[1]));
    cfg = JSON.parse(atob(zk[1]));
  } catch { return []; }
  if (!Array.isArray(reg) || !Array.isArray(cfg)) return [];
  // Server labels sit in <span class="ser"> in data-server-id (= registry) order.
  const names: string[] = [];
  const nre = /<span[^>]*class=["']ser["'][^>]*>([\s\S]*?)<\/span>/gi;
  let nm: RegExpExecArray | null;
  while ((nm = nre.exec(html))) names.push(nm[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());
  const out: RawServer[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < reg.length; i++) {
    const url = witDecodeServer(reg[i], cfg[i]);
    if (!url || url.indexOf("http") !== 0 || seen.has(url)) continue;
    if (/google|facebook|pyppo|popads|disqus/.test(url)) continue;
    try {
      const h = new URL(url).hostname.toLowerCase();
      if (!h || h === "undefined" || h === "null" || h.indexOf(".") < 0) continue;
    } catch { continue; }
    seen.add(url);
    out.push({ id: String(out.length), name: names[i] || `Server ${out.length + 1}`, iframeUrl: normalizeEmbedUrl(url), provider: classifyProvider(url) });
  }
  return out;
}

// Full witanime episode-page parse (servers + display titles) from one static
// GET. Returns null on fetch/decode failure so the caller falls back to the
// headless scrape (older episodes that predate the _zX/_zK scheme still render
// plain iframes the headless pass can read).
export async function scrapeWitanimeEpisodePageDirect(
  episodeUrl: string,
): Promise<{ servers: RawServer[]; episodeTitle: string; animeTitle: string } | null> {
  const html = await window.pantoufa.fetchHtml?.(episodeUrl, WIT_BASE + "/");
  if (!html) return null;
  const servers = parseWitServers(html);
  if (servers.length === 0) return null;
  const deent = (s: string) =>
    s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
  let episodeTitle = "";
  const h3 = html.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
  if (h3) episodeTitle = deent(h3[1].replace(/<[^>]+>/g, ""));
  let animeTitle = "";
  const link = html.match(/anime-page-link[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
  if (link) animeTitle = deent(link[1].replace(/<[^>]+>/g, ""));
  if (!animeTitle && episodeTitle) animeTitle = episodeTitle.replace(/الحلقة\s*\d+.*$/, "").trim();
  return { servers, episodeTitle, animeTitle };
}

// Full episode-page parse (servers + display titles) from a single static GET.
// Used when the PRIMARY episode is an anime4up URL: the headless render takes
// many seconds and frequently trips anime4up's ad gates, while the static HTML
// reliably carries the entire server list — so this path shows servers
// near-instantly. Returns null when the fetch fails or no servers parse, in
// which case the caller falls back to the headless scrape.
export async function scrapeAnime4upEpisodePageDirect(
  episodeUrl: string,
): Promise<{ servers: RawServer[]; episodeTitle: string; animeTitle: string } | null> {
  const html = await window.pantoufa.fetchHtml?.(episodeUrl, UP4_BASE + "/");
  if (!html) return null;
  const servers = parseUp4Servers(html);
  if (servers.length === 0) return null;
  const deent = (s: string) =>
    s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
  // Episode title: prefer the page heading, fall back to <title> minus the
  // site-name suffix.
  let episodeTitle = "";
  const h3 = html.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
  if (h3) episodeTitle = deent(h3[1].replace(/<[^>]+>/g, ""));
  if (!episodeTitle) {
    const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (t) episodeTitle = deent(t[1]).split(/\s*[|–-]\s*(?:anime4up|أنمي فور أب).*/i)[0].trim();
  }
  // Anime title: the breadcrumb/anime-page link, else strip "الحلقة N" off
  // the episode title.
  let animeTitle = "";
  const link = html.match(/anime-page-link[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)
    || html.match(/<a[^>]*href=["'][^"']*\/anime\/[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
  if (link) animeTitle = deent(link[1].replace(/<[^>]+>/g, ""));
  if (!animeTitle && episodeTitle) {
    animeTitle = episodeTitle.replace(/الحلقة\s*\d+.*$/, "").replace(/\bepisode\s*\d+.*$/i, "").trim();
  }
  return { servers, episodeTitle, animeTitle };
}

// ── Direct (no-headless) cross-source search + episode list for anime4up ──
// Both anime4up's search results and anime episode lists are served in the
// initial static HTML, so a privileged GET parses them reliably — the headless
// render trips anime4up's ad redirects / JS gates and frequently returns
// nothing (so "One Piece" et al. get "no cross-source match" even though the
// anime clearly exists). These mirror EXTRACT_TITLE_MATCH / EXTRACT_EPISODES_4UP.

// Roman-numeral season markers ("Mushoku Tensei III", anime3rb's own lowercase
// "mushoku-tensei-ii-…" slug). MAL/witanime romaji titles number later seasons
// this way, never "season 3", and anime3rb slugs mirror it — so this MUST work
// case-insensitively (the catalog matcher lowercases both sides). Multi-letter
// romans (ii..ix) are unambiguous, so match any case. Single-letter V/X collide
// with real words, so only accept them UPPERCASE. "I" is season 1 (the default)
// and too collision-prone (English pronoun) to ever match.
// ponytail: a bare "VII"/"II" in a non-season title (e.g. "Final Fantasy VII")
// is misread as a season; acceptable — vanishingly rare in this catalog, and it
// only affects season-equality in matching. Extend the map for season XI+.
const ROMAN_SEASON: Record<string, number> = {
  II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10,
};
function tm_romanSeason(orig: string): number {
  const s = orig || "";
  const multi = s.match(/\b(VIII|VII|VI|IV|IX|III|II)\b/i);
  if (multi) return ROMAN_SEASON[multi[1].toUpperCase()];
  const single = s.match(/\b(X|V)\b/); // uppercase-only for the word-colliding singles
  return single ? ROMAN_SEASON[single[1]] : 0;
}
export function tm_seasonNum(orig: string): number {
  const s = (orig || "").toLowerCase();
  const m =
    // Ordinal-before-keyword form FIRST: "7th Season", "2nd Part", "3rd Cour".
    // It's unambiguous, while the keyword-number form below can misfire on a
    // number that merely FOLLOWS the keyword: anime3rb's
    // "…-4th-season-2-nensei-hen-1-gakki" read as season 2 ("season 2"
    // matched before "4th season" was even tried) and hard-rejected the
    // correct catalog entry.
    s.match(/\b(\d+)(?:st|nd|rd|th)\s+(?:season|part|cour)\b/) ||
    s.match(/\b(?:season|s|part|cour)\s*(\d+)\b/) ||
    s.match(/الموسم\s*([٠-٩\d]+)/) ||
    s.match(/الجزء\s*([٠-٩\d]+)/);
  if (m) {
    const n = m[1].replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
    const v = parseInt(n, 10);
    if (!isNaN(v)) return v;
  }
  return tm_romanSeason(orig) || 1;
}
function tm_normLatin(s: string): string {
  return String(s || "").toLowerCase()
    .replace(/\b(?:season|s|part|cour)\s*\d+\b/g, " ")
    .replace(/\b(?:the|a|an|of|to|wa|no|wo|ga|ni)\b/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ").trim();
}
function tm_normArabic(s: string): string {
  return String(s || "")
    .replace(/[ً-ٰٟ]/g, "")
    .replace(/[آأإ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[^؀-ۿ ]+/g, " ")
    .replace(/\s+/g, " ").trim();
}
function tm_toks(s: string): string[] {
  return s ? s.split(" ").filter((w) => w.length >= 2) : [];
}
function tm_overlap(a: string, b: string): number {
  const A = tm_toks(a), B = tm_toks(b);
  if (!A.length || !B.length) return 0;
  const setB: Record<string, boolean> = {};
  B.forEach((w) => { setB[w] = true; });
  let common = 0;
  A.forEach((w) => { if (setB[w]) common++; });
  return common / Math.min(A.length, B.length);
}
function tm_score(want: string, title: string): number {
  const latinWant = tm_normLatin(want), latinGot = tm_normLatin(title);
  const arWant = tm_normArabic(want), arGot = tm_normArabic(title);
  const latinOverlap = tm_overlap(latinWant, latinGot);
  const arabicOverlap = tm_overlap(arWant, arGot);
  let s: number;
  if (latinWant && latinGot === latinWant) s = 100;
  else if (latinWant && latinGot.indexOf(latinWant) === 0) s = 85;
  else if (arWant && arGot === arWant) s = 95;
  else s = Math.round(Math.max(latinOverlap, arabicOverlap) * 75);
  const sw = tm_seasonNum(want), sg = tm_seasonNum(title);
  if (sw === sg) s += 8; else s -= 12;
  return s;
}

// Search anime4up for `searchTitle` via a direct GET and return the best-scoring
// anime page URL (or null). Threshold matches EXTRACT_TITLE_MATCH (>=34).
//
// `scoreTitle` is what candidates are scored against and defaults to the search
// term. Callers that fall back to truncated search variants (e.g. "Boku no
// Hero" for "Boku no Hero Academia 7th Season") MUST pass the full title here —
// otherwise the season is stripped from the comparison and a different season's
// anime page outscores the correct one, so the episode lookup later fails and
// no anime4up servers show up.
export async function searchAnime4upDirect(
  searchTitle: string,
  scoreTitle: string = searchTitle,
): Promise<string | null> {
  if (!searchTitle) return null;
  const url = `${UP4_BASE}/?search_param=animes&s=${encodeURIComponent(searchTitle)}`;
  const html = await window.pantoufa.fetchHtml?.(url, UP4_BASE + "/");
  if (!html) return null;
  // anime4up cards expose the anime URL twice (overlay <a> + title <h3><a>).
  // Pull the title link so we get the URL and display title together.
  const re = /class=["'][^"']*anime-card-title[^"']*["'][^>]*>\s*<h3[^>]*>\s*<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  let best: { url: string | null; score: number } = { url: null, score: 0 };
  while ((m = re.exec(html))) {
    const href = (m[1] || "").trim();
    const cardTitle = (m[2] || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (!href || href.indexOf("/anime/") < 0 || !cardTitle) continue;
    const s = tm_score(scoreTitle, cardTitle);
    if (s > best.score) best = { url: href.indexOf("http") === 0 ? href : UP4_BASE + href, score: s };
  }
  // Fallback: if the card markup didn't match (layout drift), scan every
  // /anime/ anchor and score it by its link text — failing that, by the
  // human-readable slug derived from the URL.
  if (!best.url || best.score < 34) {
    const seen = new Set<string>();
    const are = /<a[^>]*href=["']([^"']*\/anime\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let a: RegExpExecArray | null;
    while ((a = are.exec(html))) {
      let href = (a[1] || "").trim();
      if (!href) continue;
      if (href.indexOf("http") !== 0) href = UP4_BASE + (href.charAt(0) === "/" ? "" : "/") + href;
      if (seen.has(href)) continue;
      seen.add(href);
      let label = (a[2] || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      if (!label) {
        try {
          const slug = decodeURIComponent(new URL(href).pathname.replace(/\/$/, "").split("/").pop() || "");
          label = slug.replace(/[-_]+/g, " ").trim();
        } catch {}
      }
      if (!label) continue;
      const s = tm_score(scoreTitle, label);
      if (s > best.score) best = { url: href, score: s };
    }
  }
  return best.score >= 34 ? best.url : null;
}

// Episode number for an anime4up link. The URL slug is NOT reliable: anime4up
// uses random hash slugs (…-الحلقة-wtgjd/), so the number must come from the
// anchor's title attribute ("… الحلقة 20"). Falls back to the slug only when a
// title number is unavailable (older pages embed the number in the URL).
function up4EpisodeNumber(href: string, title?: string): number | null {
  // Prefer the human-readable episode number from the title attribute.
  if (title) {
    const tm = title.match(/الحلقة\s*(\d+)/) || title.match(/\bepisode\s*(\d+)/i) || title.match(/\bep\s*(\d+)/i);
    if (tm) return parseInt(tm[1], 10);
  }
  if (!href) return null;
  try {
    const d = decodeURIComponent(href);
    // Only trust a URL number when it directly follows الحلقة (…-الحلقة-21-…).
    // A bare trailing -\d+ would wrongly match hash slugs, so don't use it.
    const m = d.match(/الحلقة[\s-]+(\d+)\b/);
    if (m) return parseInt(m[1], 10);
  } catch {}
  return null;
}

// Parse an anime4up anime page's episode list straight from static HTML.
// Captures the full <a> tag so we can read the episode number from its title
// attribute (the URL hash slug carries no reliable number).
function parseUp4Episodes(
  html: string,
): { title: string; number: number; type: string; screenshot: string; href: string }[] {
  // Constrain to the episodes-list container when present. The page chrome
  // (the "latest episodes" rail on paginated pages) carries /episode/ links
  // from the NEWEST part of the series, which widen the parsed number range —
  // findUp4EpisodeAcrossPages then sees the wanted episode "within this
  // page's range but missing", concludes numbering gap, and gives up even
  // though the neighbouring page actually has it (verified live: One Piece
  // /page/16/ parses as 420–1165 unscoped, 420–467 scoped).
  const segStart = html.indexOf("episodes-list-content");
  if (segStart >= 0) {
    const segEnd = html.indexOf("pagination", segStart);
    html = html.slice(segStart, segEnd > segStart ? segEnd : undefined);
  }
  const out: { title: string; number: number; type: string; screenshot: string; href: string }[] = [];
  const seen = new Set<string>();
  // Match an episode anchor and grab the whole opening tag so title= (which may
  // appear before OR after href=) is in scope.
  const re = /<a\b([^>]*\bhref=["'][^"']*\/episode\/[^"']+["'][^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const tag = m[1] || "";
    const hrefM = tag.match(/\bhref=["']([^"']+)["']/i);
    if (!hrefM) continue;
    let href = (hrefM[1] || "").trim();
    if (!href) continue;
    if (href.indexOf("http") !== 0) href = href.indexOf("//") === 0 ? "https:" + href : UP4_BASE + (href.charAt(0) === "/" ? "" : "/") + href;
    if (seen.has(href)) continue;
    const titleM = tag.match(/\btitle=["']([^"']*)["']/i);
    const title = titleM ? titleM[1] : undefined;
    const num = up4EpisodeNumber(href, title);
    if (num == null) continue;
    seen.add(href);
    out.push({ title: "الحلقة " + num, number: num, type: "", screenshot: "", href });
  }
  out.sort((a, b) => a.number - b.number);
  return out;
}

export async function scrapeAnime4upEpisodesDirect(
  animeUrl: string,
): Promise<{ title: string; number: number; type: string; screenshot: string; href: string }[]> {
  const html = await window.pantoufa.fetchHtml?.(animeUrl, UP4_BASE + "/");
  if (!html) return [];
  return parseUp4Episodes(html);
}

function up4PageUrl(animeUrl: string, page: number): string {
  const base = animeUrl.replace(/\/+$/, "");
  return page <= 1 ? base + "/" : `${base}/page/${page}/`;
}

function up4MaxPage(html: string): number {
  let max = 1;
  const re = /\/page\/(\d+)\//g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const v = parseInt(m[1], 10);
    if (!isNaN(v) && v > max) max = v;
  }
  return max;
}

// anime4up PAGINATES anime episode lists (newest-first, ~40 episodes per page;
// One Piece spans 25 pages), so a page-1 parse only ever sees the newest chunk.
// Episodes older than that chunk used to be unresolvable — the cross-source
// lookup found the anime page, parsed page 1, missed the episode, and anime4up
// servers NEVER showed for it no matter how often it retried. This walks the
// pagination toward the requested episode number instead: estimate the target
// page from the numbers on page 1, fetch it, and correct the estimate from
// what that page actually shows. Bounded to a handful of fetches.
// Returns { url } on a hit. On a miss, `definitive` says whether the answer is
// final: true = the anime page was reachable, its episode list parsed, and the
// episode is genuinely absent (single-page list exhausted, or a numbering gap)
// — retrying can't change that. false = a transient miss (no HTML, empty list
// from an ad gate, a page fetch that failed) that a retry might recover. The
// watch screen uses this to stop the "attempt 9…" retry storm on titles an
// episode simply doesn't exist for.
export async function findUp4EpisodeAcrossPages(
  animeUrl: string,
  epNumber: number,
): Promise<{ url: string | null; definitive: boolean }> {
  const html = await window.pantoufa.fetchHtml?.(animeUrl, UP4_BASE + "/");
  if (!html) return { url: null, definitive: false };
  const eps = parseUp4Episodes(html);
  const hit = eps.find((e) => e.number === epNumber);
  if (hit) return { url: hit.href, definitive: false };
  if (eps.length === 0) return { url: null, definitive: false };
  const maxPage = up4MaxPage(html);
  // Single-page episode list fully parsed and the episode isn't in it → final.
  if (maxPage <= 1) return { url: null, definitive: true };
  const lo = eps[0].number;
  const hi = eps[eps.length - 1].number;
  const perPage = Math.max(eps.length, 1);
  // Episode within page 1's range but absent → a numbering gap (special /
  // movie), not a pagination miss; other pages won't have it either.
  if (epNumber >= lo && epNumber <= hi) return { url: null, definitive: true };
  // First estimate. Direction-agnostic: newest-first lists put older episodes
  // on higher pages (epNumber < lo), oldest-first the reverse — the correction
  // loop below converges either way because it re-reads each page's range.
  const clamp = (p: number) => Math.min(Math.max(p, 2), maxPage);
  let page = clamp(
    1 + Math.ceil((epNumber < lo ? lo - epNumber : epNumber - hi) / perPage),
  );
  const visited = new Set<number>([1]);
  for (let i = 0; i < 5; i++) {
    if (visited.has(page)) break;
    visited.add(page);
    const ph = await window.pantoufa.fetchHtml?.(up4PageUrl(animeUrl, page), UP4_BASE + "/");
    if (!ph) return { url: null, definitive: false };
    const pe = parseUp4Episodes(ph);
    if (pe.length === 0) return { url: null, definitive: false };
    const phit = pe.find((e) => e.number === epNumber);
    if (phit) return { url: phit.href, definitive: false };
    const plo = pe[0].number;
    const phi = pe[pe.length - 1].number;
    // Within this page's range but missing → a numbering gap, stop.
    if (epNumber >= plo && epNumber <= phi) return { url: null, definitive: true };
    // Derive the sort order by comparing this page's numbers to page 1's:
    // anime4up lists newest-first (numbers DECREASE as the page increases),
    // but derive it rather than assume so an ordering flip can't strand us.
    const numbersDecreaseWithPage = phi < lo;
    const distance = epNumber < plo ? plo - epNumber : epNumber - phi;
    const step = Math.max(1, Math.ceil(distance / perPage));
    const needLowerNumbers = epNumber < plo;
    page = clamp(needLowerNumbers === numbersDecreaseWithPage ? page + step : page - step);
  }
  // Ran out of hops without proving absence — treat as transient (may resolve
  // on a later retry as the page estimate converges).
  return { url: null, definitive: false };
}

// ── anime3rb (third server source) ──
// anime3rb serves its pages statically (Laravel/Livewire — the full payload
// is in the initial HTML) and uses PREDICTABLE URLs: /titles/<slug> for the
// anime page and /episode/<slug>/<number> for episodes, with clean
// Str::slug-style slugs ("Dr. Stone: Science Future Part 3" →
// dr-stone-science-future-part-3). Resolution matches the daily titles
// sitemap first (one plain GET, see api.ts), with direct slug probing only
// as a capped fallback — a missed /titles/<slug> probe is NOT a fast 404,
// the edge tarpits it (hangs until timeout) and bursts of stalled probes get
// the whole site temporarily blackholed. /search sits behind a Cloudflare
// managed challenge and is effectively dead to us.

// Every anime3rb GET goes through this gate. The site's edge does NOT 404
// unknown paths — it tarpits them (the connection hangs until our timeout),
// and a burst of requests gets EVERY subsequent request blackholed for a
// while (verified live: after ~15 rapid probes even the homepage stalled).
// So each request fails fast (single attempt, short timeout — a retry would
// just re-enter the tarpit) and successive requests stay spaced out.
let a3rbLastFetchAt = 0;
const A3RB_FETCH_SPACING_MS = 700;
async function a3rbFetch(
  url: string,
  opts?: { attempts?: number; timeoutMs?: number },
): Promise<string | null> {
  const wait = a3rbLastFetchAt + A3RB_FETCH_SPACING_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  a3rbLastFetchAt = Date.now();
  const html = await window.pantoufa.fetchHtml?.(url, A3RB_BASE + "/", {
    attempts: 1,
    timeoutMs: 8000,
    ...opts,
  });
  return html ?? null;
}

function a3rbSlugify(s: string): string {
  return (s || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics (é → e)
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function a3rbOrdinal(n: number): string {
  return n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`;
}

// Candidate slugs for a title, most-specific first. anime3rb's season naming
// is inconsistent ("kanojo-okarishimasu-5th-season" but "dorohedoro-season-2"),
// so when the title carries a season marker we emit every common shape. The
// bare base name is only probed for season 1 — matching season 1's page for a
// later season would resolve to the WRONG episodes (numbering restarts).
// Parenthesized alternative names get their own variant set: witanime often
// appends the romaji original in parens ("Blades of the Guardians Season 2
// (Biao Ren 2)") and anime3rb may index the anime ONLY under that name.
// `full` = the slug is an EXACT, complete slugification of the whole title (or a
// whole parenthesized alt name) — not a colon-split / season / truncation form.
// An exact full slug landing on a live page is a confident match on its own
// (anime3rb slugs are unique), so the caller can accept it WITHOUT the og:title
// language-match guard — which is what lets a cross-language title resolve
// (English "one piece" → anime3rb's Arabic-og:title /titles/one-piece page).
function a3rbSlugVariants(title: string): { slug: string; full: boolean }[] {
  const out: { slug: string; full: boolean }[] = [];
  const add = (s: string, full: boolean) => {
    const v = a3rbSlugify(s);
    if (v && !out.some((o) => o.slug === v)) out.push({ slug: v, full });
  };
  const forms: string[] = [title];
  const reParen = /[\(\[]([^\)\]]+)[\)\]]/g;
  let pm: RegExpExecArray | null;
  while ((pm = reParen.exec(title))) { const p = pm[1].trim(); if (p) forms.push(p); }
  for (const form of forms) {
    const cleaned = form
      .replace(/[\(\[][^\)\]]*[\)\]]/g, " ")
      // Episode markers leak into titles derived from episode pages/URLs
      // ("… الحلقة 11", "… Episode 11") — and a percent-encoded الحلقة arrives
      // as "%D8%A7%D9%84… 11" junk. Strip all of it or every slug guess 404s.
      .replace(/الحلقة\s*\d+.*$/, " ")
      .replace(/\bepisodes?\s*\d+.*$/i, " ")
      .replace(/(?:%[0-9a-f]{2})+[\s\d]*$/gi, " ") // trailing junk drags its episode number along
      .replace(/(?:%[0-9a-f]{2})+/gi, " ")
      .replace(/\s+/g, " ").trim();
    // Exact, complete slugifications of the full form — confident on existence.
    add(cleaned, true);
    // Laravel's Str::slug DROPS a colon that touches both words instead of
    // dashing it: "Re:Zero kara…" lives at rezero-kara-…, not re-zero-kara-….
    add(cleaned.replace(/(\S)[:：](\S)/g, "$1$2"), true);
    // Dotted acronyms slugify letter-by-letter ("A.I.C.O." → a-i-c-o) but
    // anime3rb collapses them ("aico-incarnation"). Strip the dots inside any
    // run of single letters so the collapsed slug ("aico") is also probed.
    const collapsedAcr = cleaned.replace(/\b[a-z](?:\.[a-z]){1,}\.?/gi, (m) => m.replace(/\./g, ""));
    if (collapsedAcr !== cleaned) add(collapsedAcr, true);
    // Reduced / truncated forms — keep the strict title-score guard.
    add(cleaned.split(/\s*[:：]\s*/)[0], false);
    const seasonM =
      cleaned.match(/\b(\d+)(?:st|nd|rd|th)\s+season\b/i) ||
      cleaned.match(/\bseason\s+(\d+)\b/i) ||
      cleaned.match(/\bpart\s+(\d+)\b/i);
    if (seasonM) {
      const n = parseInt(seasonM[1], 10);
      const base = cleaned
        .replace(/\b(?:the\s+)?(?:\d+(?:st|nd|rd|th)\s+season|season\s+\d+|part\s+\d+)\b/i, " ")
        .replace(/\s+/g, " ").trim();
      if (base && !isNaN(n)) {
        add(`${base} ${a3rbOrdinal(n)} season`, false);
        add(`${base} season ${n}`, false);
        add(`${base} part ${n}`, false);
        add(`${base} ${n}`, false);
        if (n === 1) add(base, false);
      }
    }
  }
  return out.slice(0, 12);
}

// The EXACT, complete slug guesses for a title (the `full` variants only). The
// watch path uses these to build an episode URL DIRECTLY and skip a separate
// title-page fetch — the episode page itself proves the slug. Reduced/season
// variants are intentionally excluded here (they could land on a different
// anime, which only the title-score guard catches).
export function anime3rbExactSlugs(title: string): string[] {
  return a3rbSlugVariants(title).filter((v) => v.full).map((v) => v.slug);
}

// Probe /titles/<slug> and verify the page's own title actually matches the
// wanted anime (same >=34 threshold as the other cross-source matchers) so a
// coincidental slug can't hijack the match. Returns the page URL or null.
// `relaxed` skips the title-score guard for an exact full-title slug (see
// a3rbSlugVariants): the page exists, the slug is unique, so it IS the anime —
// even when its og:title is in a different language than the query.
async function probeA3rbTitlePage(slug: string, title: string, relaxed = false): Promise<string | null> {
  const url = `${A3RB_BASE}/titles/${slug}`;
  const html = await a3rbFetch(url);
  if (!html) return null; // miss (tarpit timeout) / fetch failure
  if (relaxed) return url; // exact full slug on a live page — confident match
  const tm =
    html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i) ||
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  // The suffix separator has been seen as "|", "–" AND a plain "-" — match all.
  const got = tm ? tm[1].replace(/\s*[-|–—]\s*Anime3rb.*$/i, "").trim() : slug.replace(/-+/g, " ");
  return tm_score(title, got) >= 34 ? url : null;
}

// Probe /titles/<slug> for the top candidate slug shapes derived from the
// title. Only a FALLBACK now (the catalog resolves first — see api.ts): a
// missed probe doesn't 404, it hangs until the timeout, so each guess is
// expensive and a long guess chain re-triggers the tarpit. Cap hard.
export async function searchAnime3rbDirect(title: string): Promise<string | null> {
  if (!title) return null;
  for (const { slug, full } of a3rbSlugVariants(title).slice(0, 4)) {
    const url = await probeA3rbTitlePage(slug, title, full);
    if (url) return url;
  }
  return null;
}

// ── anime3rb catalog (sitemap) matching ──
// /search sits behind a Cloudflare managed challenge that NEVER completes
// inside the hidden scraper window (it idles on the interstitial until the
// timeout), so free-text search is effectively dead. But anime3rb publishes a
// daily titles sitemap (~6300 slugs, one plain GET, no Cloudflare) — fuzzy-
// matching the wanted title against the whole catalog finds anime whose slug
// can't be guessed from the witanime title: different romanization
// (Re:Zero → rezero-…), an anime indexed only under its alternative name, or
// a shortened witanime title ("Yuusha no Rokkotsu de" lives at
// megami-isekai-tensei-…-ore-yuusha-no-rokkotsu-de).
// anime3rb publishes a daily titles sitemap (~6300 slugs, one plain GET, no
// Cloudflare) — fuzzy-matching the wanted title against the whole catalog finds
// anime whose slug can't be guessed from the witanime title: different romanization
// (Re:Zero → rezero-…), an anime indexed only under its alternative name, or
// a shortened witanime title ("Yuusha no Rokkotsu de" lives at
// megami-isekai-tensei-…-ore-yuusha-no-rokkotsu-de"). Each <url> block ALSO
// carries an <image:image><image:loc> entry with the title's poster, so the
// catalog gives every anime3rb card its artwork for free — no per-card
// title-page fetch (which would tarpit the edge).
let a3rbCatalog: { slugs: string[]; posters: Map<string, string>; ts: number } | null = null;
const A3RB_CATALOG_TTL = 6 * 60 * 60 * 1000;

async function fetchA3rbCatalog(): Promise<string[]> {
  if (a3rbCatalog && Date.now() - a3rbCatalog.ts < A3RB_CATALOG_TTL) return a3rbCatalog.slugs;
  // The sitemap is ~2.6MB, so give the download room — but still single-shot
  // (a stalled attempt means the tarpit is active; retrying re-enters it).
  const xml = await a3rbFetch(`${A3RB_BASE}/storage/sitemaps/titles_sitemap.xml`, {
    attempts: 1,
    timeoutMs: 20000,
  });
  if (!xml) return a3rbCatalog?.slugs ?? [];
  const slugs: string[] = [];
  const posters = new Map<string, string>();
  // Walk each <url> block: the title's <loc> slug + its first <image:loc>
  // poster. The titles <loc> is matched on its /titles/ path so it never
  // collides with an <image:loc> (which also contains "loc").
  const blockRe = /<url>([\s\S]*?)<\/url>/g;
  const locRe = /<loc>\s*https?:\/\/anime3rb\.com\/titles\/([^<\s]+?)\/?\s*<\/loc>/i;
  const imgRe = /<image:loc>\s*([^<\s]+?)\s*<\/image:loc>/i;
  let bm: RegExpExecArray | null;
  while ((bm = blockRe.exec(xml))) {
    const block = bm[1];
    const lm = block.match(locRe);
    if (!lm) continue;
    let slug: string;
    try { slug = decodeURIComponent(lm[1]); } catch { slug = lm[1]; }
    slugs.push(slug);
    const im = block.match(imgRe);
    if (im && im[1]) posters.set(slug, im[1]);
  }
  if (slugs.length > 0) a3rbCatalog = { slugs, posters, ts: Date.now() };
  return slugs;
}

// Season number for a catalog slug / title. Falls back to a small trailing
// number ("haikyuu-2" style naming) — capped low so number-bearing titles
// (mob-psycho-100) aren't misread as season markers.
function a3rbSeasonOf(label: string): number {
  const k = tm_seasonNum(label);
  if (k !== 1) return k;
  const t = label.match(/(?:^|[\s-])(\d{1,2})$/);
  if (t) {
    const v = parseInt(t[1], 10);
    if (v >= 2 && v <= 20) return v;
  }
  return 1;
}

// Conservative matcher: a wrong match plays the WRONG anime's episodes, so it
// requires near-total coverage of the wanted title's tokens, an exact season
// match, and (for short titles) near-total coverage of the slug's tokens too.
function a3rbCatalogMatch(title: string, slugs: string[]): string | null {
  // Want-forms: the full title, every parenthesized alternative name, and a
  // tight-colon-joined copy of each (Str::slug turns "Re:Zero" into "rezero").
  const rawForms: string[] = [title];
  const reParen = /[\(\[]([^\)\]]+)[\)\]]/g;
  let pm: RegExpExecArray | null;
  while ((pm = reParen.exec(title))) { const p = pm[1].trim(); if (p) rawForms.push(p); }
  type Want = { set: Record<string, true>; n: number; season: number };
  const wants: Want[] = [];
  for (const f of rawForms) {
    for (const v of [f, f.replace(/(\S)[:：](\S)/g, "$1$2")]) {
      const toks = tm_toks(tm_normLatin(v));
      if (!toks.length) continue;
      const set: Record<string, true> = {};
      toks.forEach((t) => { set[t] = true; });
      wants.push({ set, n: toks.length, season: a3rbSeasonOf(v.toLowerCase()) });
    }
  }
  if (!wants.length) return null;
  let best: { slug: string | null; score: number } = { slug: null, score: 0 };
  for (const slug of slugs) {
    const label = slug.replace(/[-_]+/g, " ");
    const gotToks = tm_toks(tm_normLatin(label));
    if (!gotToks.length) continue;
    const gotSeason = a3rbSeasonOf(label);
    for (const w of wants) {
      // Wrong season page = wrong episode numbering. Hard reject.
      if (gotSeason !== w.season) continue;
      let gc = 0;
      const gotSet: Record<string, true> = {};
      for (const t of gotToks) { gotSet[t] = true; if (w.set[t]) gc++; }
      let wc = 0;
      for (const t in w.set) { if (gotSet[t]) wc++; }
      const wantCov = wc / w.n;
      const gotCov = gc / gotToks.length;
      // Containment: the slug's ENTIRE name appears inside the wanted title
      // (with enough tokens to be non-coincidental). Catches witanime titles
      // that concatenate the English and romaji names — especially the
      // mount-time slug-derived title, where "X (Y)" arrives flattened as
      // "x y" and no single name covers 80% of the combined token set.
      const contained = gotCov === 1 && gc >= 4;
      const ok = contained || (
        w.n >= 3 ? wantCov >= 0.8 :
        w.n === 2 ? wantCov === 1 && gotCov >= 0.6 :
        wantCov === 1 && gotCov === 1);
      if (!ok) continue;
      const score = wantCov * 60 + gotCov * 40;
      if (score > best.score) best = { slug, score };
    }
  }
  return best.slug;
}

export async function searchAnime3rbCatalog(title: string): Promise<string | null> {
  if (!title) return null;
  const slugs = await fetchA3rbCatalog();
  if (!slugs.length) return null;
  const slug = a3rbCatalogMatch(title, slugs);
  if (!slug) return null;
  // Confirm against the real page's own title before trusting the match.
  return probeA3rbTitlePage(slug, title);
}

// Typo-tolerant catalog ranking for the SEARCH screen (not the watch path).
// a3rbCatalogMatch above is deliberately strict — a wrong match there plays the
// WRONG anime's episodes. But on the search screen the user PICKS from the
// list, so we can afford to be lenient: fuzzy-rank every catalog slug against
// the query and return the strongest candidates so a misspelled / oddly-spaced
// query still surfaces the anime. Pure local compute over the cached sitemap.
export async function searchAnime3rbCatalogFuzzy(
  title: string,
  limit = 5,
): Promise<{ slug: string; score: number; poster: string }[]> {
  if (!title) return [];
  const slugs = await fetchA3rbCatalog();
  if (!slugs.length) return [];
  const wantSeason = a3rbSeasonOf(title.toLowerCase());
  const scored: { slug: string; score: number; poster: string }[] = [];
  for (const slug of slugs) {
    const label = slug.replace(/[-_]+/g, " ");
    const score = fuzzyScore(title, label);
    if (score < 0.62) continue;
    const adj = a3rbSeasonOf(label) === wantSeason ? 0.04 : -0.08;
    scored.push({ slug, score: score + adj, poster: a3rbCatalog?.posters.get(slug) || "" });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// Cloudflare-capable fallback: render the /search page in the headless window
// and score the result links there. Slow (challenge + render), so callers only
// reach for this after every slug guess missed.
export async function searchAnime3rbHeadless(title: string): Promise<string | null> {
  if (!title) return null;
  const url = `${A3RB_BASE}/search?q=${encodeURIComponent(title)}`;
  try {
    const r = await enqueue<{ url: string | null; score: number }>({
      url, injectAfter: EXTRACT_TITLE_MATCH_A3RB(title), timeoutMs: 45000,
    });
    return r?.url ?? null;
  } catch {
    return null;
  }
}

// Parse the anime3rb episode page's player out of the static HTML. The page
// is Livewire-rendered server-side: its wire:snapshot JSON carries video_url =
// https://video.vid3rb.com/player/<uuid>?token=…&expires=…, anime3rb's
// first-party player. That URL is both iframe-embeddable (the page serves
// X-Frame-Options: ALLOWALL) and the input the main-process vid3rb extractor
// pulls direct tokenized .mp4 qualities from — so the custom player path
// works end-to-end with two plain GETs.
export async function scrapeAnime3rbEpisodeServers(episodeUrl: string): Promise<RawServer[]> {
  // Episode pages are ~1.7MB; a missing episode (not yet uploaded) doesn't
  // 404 — it tarpits — so bound the wait and let the retry loop re-try later.
  const html = await a3rbFetch(episodeUrl, { attempts: 1, timeoutMs: 12000 });
  if (!html) return [];
  // The snapshot lives inside an HTML attribute, so quotes arrive as &quot;
  // and the URL as JSON-escaped https:\/\/… with &amp; between query params.
  const raw =
    html.match(/video_url&quot;:&quot;(https:[\s\S]*?)&quot;/)?.[1] ||
    html.match(/"video_url"\s*:\s*"(https:[\s\S]*?)"/)?.[1] ||
    null;
  if (!raw) return [];
  const playerUrl = raw.replace(/\\\//g, "/").replace(/&amp;/g, "&");
  try {
    const h = new URL(playerUrl).hostname.toLowerCase();
    if (!h || h.indexOf(".") < 0) return [];
  } catch { return []; }
  // Expose each free quality as its own native server ("Anime3rb 1080p", …),
  // HIGHEST first so 1080p is the default that plays. The quality is encoded in
  // a `#vid3rb=<res>` fragment; the main-process extractVid3rb re-reads the
  // player page and resolves THAT quality at play time, so tokens stay fresh.
  // If the player page can't be enumerated, fall back to a single server.
  const resolutions = await listVid3rbResolutions(playerUrl);
  if (resolutions.length === 0) {
    return [{ id: "a3rb", name: "Anime3rb", iframeUrl: playerUrl, provider: "vid3rb" }];
  }
  return resolutions.map((res) => ({
    id: `a3rb_${res}`,
    name: `Anime3rb ${res}p`,
    iframeUrl: `${playerUrl}#vid3rb=${res}`,
    provider: "vid3rb",
  }));
}

// Parse the non-premium playable resolutions from a vid3rb player page. The
// page declares `video_sources` twice — an empty [] then the real array — so
// match the non-empty form. Premium-gated tiers ship an empty src and drop out.
function parseVid3rbResolutions(html: string): number[] {
  const m =
    html.match(/video_sources\s*=\s*(\[\{[\s\S]*?\}\])\s*;/) ||
    html.match(/video_sources\s*=\s*(\[\{[\s\S]*?\}\])/);
  if (!m) return [];
  let sources: { src?: string; res?: string; premium?: boolean }[] = [];
  try { sources = JSON.parse(m[1]); } catch { return []; }
  return sources
    .filter((s) => s.src && /^https?:\/\//.test(s.src) && !s.premium)
    .map((s) => parseInt(s.res || "0", 10) || 0)
    .filter((r) => r > 0)
    .sort((a, b) => b - a);
}

// List the available free resolutions for an anime3rb episode (e.g. [1080, 720,
// 480]) from its player page. Returns [] on any fetch/parse miss so the caller
// degrades to a single server.
export async function listVid3rbResolutions(playerUrl: string): Promise<number[]> {
  const html = await a3rbFetch(playerUrl, { attempts: 1, timeoutMs: 10000 });
  if (!html) return [];
  return parseVid3rbResolutions(html);
}

/* ── anime3rb: anime (title) page → detail + full episode list ──
 * anime3rb `/titles/<slug>` pages are server-rendered, so a single GET carries
 * the poster (og:image), synopsis, and every episode as a predictable
 * `/episode/<slug>/<n>` link. Used both to add anime3rb's episodes into the
 * detail page's cross-source union (so episodes missing from witanime/anime4up
 * still show) and to open anime3rb-only anime as a first-class detail page. */

export type A3rbEpisode = { title: string; number: number; type: string; screenshot: string; href: string };
export type A3rbDetail = { title: string; poster: string; synopsis: string; genres: string[]; episodes: A3rbEpisode[] };

function a3rbMetaContent(html: string, prop: string): string | null {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, "i");
  const m = html.match(re) || html.match(
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, "i"),
  );
  return m ? htmlDecodeCard(m[1]) : null;
}

// Pull every episode number anime3rb links for THIS title's slug, then build the
// full contiguous 1..max list (anime3rb numbers from 1 with no gaps and its URLs
// are constructible, so every card is a valid, playable URL).
function parseA3rbEpisodesFromTitle(html: string, slug: string): A3rbEpisode[] {
  const nums = new Set<number>();
  html = html.replace(/\\\//g, "/");
  const wantSlug = slug.toLowerCase();
  const re = /\/episode\/([^/"'\s\\]+)\/(\d+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    let s = m[1];
    try { s = decodeURIComponent(s); } catch {}
    if (s.toLowerCase() !== wantSlug) continue;
    const n = parseInt(m[2], 10);
    if (!isNaN(n) && n > 0 && n < 5000) nums.add(n);
  }
  if (nums.size === 0) return [];
  const max = Math.max(...nums);
  const out: A3rbEpisode[] = [];
  for (let n = 1; n <= max; n++) {
    out.push({ title: "الحلقة " + n, number: n, type: "", screenshot: "", href: `${A3RB_BASE}/episode/${slug}/${n}` });
  }
  return out;
}

// Pull the real story from an anime3rb title page body. Scoped to the
// default-visible story block (`x-show="! summary"`) so the seasons/related grid
// — which reuses the same paragraph class — never leaks in.
function parseA3rbSynopsis(html: string): string {
  const start = html.indexOf('x-show="! summary"');
  if (start < 0) return "";
  let end = html.indexOf('x-show="summary"', start);
  if (end < 0) end = html.indexOf("summary = ! summary", start);
  const scope = html.slice(start, end > start ? end : start + 8000);
  const re = /<p[^>]*class=["'][^"']*leading-loose[^"']*text-justify[^"']*["'][^>]*>([\s\S]*?)<\/p>/gi;
  let m: RegExpExecArray | null;
  const seen = new Set<string>();
  const parts: string[] = [];
  const JUNK = /التقييم|\d+\s*حلقات|(?:صيف|شتاء|ربيع|خريف)\s*\d{4}/;
  while ((m = re.exec(scope))) {
    const txt = htmlDecodeCard(m[1].replace(/<[^>]+>/g, ""));
    if (!txt || seen.has(txt) || JUNK.test(txt)) continue;
    seen.add(txt);
    parts.push(txt);
  }
  return parts.join("\n\n");
}

// Scrape a full anime3rb anime page (detail + episodes). Returns null on a
// fetch/parse failure so callers degrade gracefully to the other sources.
export async function scrapeAnime3rbTitlePage(titleUrl: string): Promise<A3rbDetail | null> {
  const html = await a3rbFetch(titleUrl, { attempts: 1, timeoutMs: 15000 });
  if (!html) return null;
  const slug = decodeURIComponent(titleUrl.replace(/\/+$/, "").split("/").pop() || "");
  if (!slug) return null;

  const ogTitle = a3rbMetaContent(html, "og:title");
  let title = ogTitle || "";
  if (!title) {
    const tm = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (tm) title = htmlDecodeCard(tm[1]);
  }
  title = title.replace(/\s*[|–-]\s*Anime3rb.*$/i, "").trim() || slug.replace(/-+/g, " ");

  const poster = a3rbMetaContent(html, "og:image") || "";
  // Story comes ONLY from the page-body story block — never og:description (it's
  // SEO boilerplate on anime3rb).
  const synopsis = parseA3rbSynopsis(html);

  const genres: string[] = [];
  const seenG = new Set<string>();
  const gre = /\/genres?\/[^"']+["'][^>]*>([\s\S]*?)<\/a>/gi;
  let gm: RegExpExecArray | null;
  while ((gm = gre.exec(html)) && genres.length < 12) {
    const g = htmlDecodeCard(gm[1].replace(/<[^>]+>/g, ""));
    if (g && !seenG.has(g)) { seenG.add(g); genres.push(g); }
  }

  const episodes = parseA3rbEpisodesFromTitle(html, slug);
  return { title, poster, synopsis, genres, episodes };
}

export async function extractVideoUrl(embedUrl: string) {
  return enqueue<{ url: string } | null>({
    url: embedUrl,
    // Install the fetch/XHR hooks BEFORE any page script runs — so the
    // URL the player asks for is captured even if the embed page later
    // redirects through an ad gate that would otherwise swap the
    // document and lose the hook.
    injectBefore: VIDEO_HOOK_INSTALL,
    injectAfter: EXTRACT_VIDEO_URL,
    timeoutMs: 35000,
    isVideoJob: true,
  });
}

/* ── Direct (no-headless) listings & card parsing ──────────────────────────
 *
 * Powers the source-direct home rails (lib/sourceRails) + the faster search.
 * witanime / anime4up listing + search pages ship their cards in the static
 * HTML, so a single privileged GET + regex parse returns them in well under a
 * second — the headless render takes many seconds and trips anime4up's ad
 * gates. Ported from the mobile app (lib/scraper/direct.ts). */

export type WitCard = {
  title: string; href: string; image: string | null;
  type: string | null; status: string | null; synopsis: string | null;
};

function htmlDecodeCard(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// Strip WordPress' resize suffix (…-323x470.jpg → ….jpg) + CDN resize params.
function upgradeCardImg(u: string | null): string | null {
  if (!u) return null;
  return String(u)
    .replace(/-\d+x\d+(\.\w+)$/, "$1")
    .replace(/\?resize=\d+,\d+/, "")
    .replace(/\?w=\d+/, "");
}

// Parse every .anime-card-container in a witanime listing/search page.
function parseWitCards(html: string): WitCard[] {
  const out: WitCard[] = [];
  const seen = new Set<string>();
  const blocks = html.split("anime-card-container");
  for (let i = 1; i < blocks.length; i++) {
    const b = blocks[i];
    const tm = b.match(/anime-card-title[^>]*>\s*<h3[^>]*>\s*<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!tm) continue;
    const href = (tm[1] || "").trim();
    if (href.indexOf("/anime/") < 0 || seen.has(href)) continue;
    const title = htmlDecodeCard((tm[2] || "").replace(/<[^>]+>/g, ""));
    if (!title) continue;
    seen.add(href);
    const im = b.match(/<img[^>]*\b(?:data-src|data-original|data-image|src)=["']([^"']+)["']/i);
    const ty = b.match(/anime-card-type[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i);
    const st = b.match(/anime-card-status[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i);
    out.push({
      title, href,
      image: im ? upgradeCardImg(im[1]) : null,
      type: ty ? htmlDecodeCard(ty[1].replace(/<[^>]+>/g, "")) : null,
      status: st ? htmlDecodeCard(st[1].replace(/<[^>]+>/g, "")) : null,
      synopsis: null,
    });
  }
  return out;
}

// Fetch + parse a witanime listing page (genre / all-anime / movies).
export async function fetchWitListingDirect(url: string): Promise<WitCard[] | null> {
  const html = await window.pantoufa.fetchHtml?.(url, WIT_BASE + "/");
  if (!html) return null;
  return parseWitCards(html);
}

// witanime's full movie listing — every movie in ONE static GET.
export async function fetchWitMoviesListing(): Promise<WitCard[] | null> {
  return fetchWitListingDirect(`${WIT_BASE}/anime-type/movie/`);
}

// Parse anime4up's .anime-card-container cards (season / movie listing pages).
function parseAnime4upCards(
  html: string,
): { title: string; href: string; image: string | null; type: string | null }[] {
  const out: { title: string; href: string; image: string | null; type: string | null }[] = [];
  const seen = new Set<string>();
  const blocks = html.split("anime-card-container");
  for (let i = 1; i < blocks.length; i++) {
    const b = blocks[i];
    const tm = b.match(/anime-card-title[^>]*>\s*<h3[^>]*>\s*<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!tm) continue;
    let href = (tm[1] || "").trim();
    if (href.indexOf("/anime/") < 0) continue;
    if (href.indexOf("http") !== 0) href = UP4_BASE + (href.charAt(0) === "/" ? "" : "/") + href;
    if (seen.has(href)) continue;
    const title = htmlDecodeCard((tm[2] || "").replace(/<[^>]+>/g, ""));
    if (!title) continue;
    seen.add(href);
    const im = b.match(/<img[^>]*\b(?:data-src|data-original|data-image|src)=["']([^"']+)["']/i);
    const ty = b.match(/anime-card-type[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i);
    out.push({ title, href, image: im ? upgradeCardImg(im[1]) : null, type: ty ? htmlDecodeCard(ty[1].replace(/<[^>]+>/g, "")) : null });
  }
  return out;
}

// The anime4up current-season catalogue, scraped directly. The site's main menu
// links the live season page (e.g. "ربيع 2026" → /anime-season/<slug>/), and the
// site's notion of "current" tracks the airing calendar, so read the link off
// the home page rather than constructing the slug.
export async function fetchAnime4upSeasonListing(): Promise<
  { title: string; href: string; image: string | null; type: string | null }[] | null
> {
  const home = await window.pantoufa.fetchHtml?.(UP4_BASE + "/", UP4_BASE + "/");
  if (!home) return null;
  const m = home.match(/href=["'](https?:\/\/[^"']*\/anime-season\/[^"']+)["']/i);
  if (!m) return null;
  const html = await window.pantoufa.fetchHtml?.(m[1], UP4_BASE + "/");
  if (!html) return null;
  const cards = parseAnime4upCards(html);
  return cards.length ? cards : null;
}

/* ── witanime: direct static-HTML HOME ──
 *
 * The home page is the SAME static-HTML shape as the listing pages — featured
 * slider, anime cards, and recent-episode cards all ship in the initial
 * response (a residential IP passes Cloudflare). Rendering it in a headless
 * window pays the ~10-15s cold-start + CF-clear tax on every launch (the single
 * slowest screen). A plain GET + regex parse reads the whole page in well under
 * a second, so this is the fast path; the headless scrape stays as the fallback.
 * Ported from the mobile app (lib/scraper/direct.ts). */

type HomeFeatured = { title: string; href: string; image: string | null; description: string | null; genres: string[] };
type HomeAnime = { title: string; href: string; image: string | null; type: string | null; status: string | null; description: string | null; isNew: boolean; rating: string | null };
type HomeEpisode = { title: string; href: string; image: string | null; animeTitle: string; animeHref: string; isNew: boolean };
export type WitHomeDirect = { featured: HomeFeatured[]; animes: HomeAnime[]; episodes: HomeEpisode[] };

function parseWitFeatured(html: string): HomeFeatured[] {
  const out: HomeFeatured[] = [];
  const seen = new Set<string>();
  const re = /<a\b([^>]*\bclass=["'][^"']*lucodeia-slider-slide-item[^"']*["'][^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const tag = m[1] || "";
    const hrefM = tag.match(/\bhref=["']([^"']+)["']/i);
    const href = hrefM ? hrefM[1].trim() : "";
    if (!href || seen.has(href)) continue;
    seen.add(href);
    const titleM = tag.match(/\btitle=["']([^"']*)["']/i);
    const bgM = tag.match(/url\(\s*['"]?([^'")]+)['"]?\s*\)/i);
    out.push({
      title: titleM ? htmlDecodeCard(titleM[1]) : "",
      href,
      image: bgM ? upgradeCardImg(bgM[1].trim()) : null,
      description: null,
      genres: [],
    });
  }
  return out.slice(0, 5);
}

function parseWitHomeAnimes(html: string): HomeAnime[] {
  return parseWitCards(html).map((c) => ({
    title: c.title, href: c.href, image: c.image, type: c.type, status: c.status,
    description: null,
    isNew: (c.status || "").indexOf("مستمر") >= 0,
    rating: null,
  }));
}

function parseWitHomeEpisodes(html: string): HomeEpisode[] {
  const out: HomeEpisode[] = [];
  const seen = new Set<string>();
  const blocks = html.split("episodes-card-container");
  for (let i = 1; i < blocks.length; i++) {
    const b = blocks[i];
    const epM = b.match(/episodes-card-title[^>]*>\s*<h3[^>]*>\s*<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!epM) continue;
    const href = (epM[1] || "").trim();
    if (!href || seen.has(href)) continue;
    seen.add(href);
    const title = htmlDecodeCard((epM[2] || "").replace(/<[^>]+>/g, ""));
    const imM = b.match(/<img[^>]*\b(?:data-src|data-original|data-image|src)=["']([^"']+)["']/i);
    const anM = b.match(/ep-card-anime-title[^>]*>\s*<h3[^>]*>\s*<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    out.push({
      title, href,
      image: imM ? upgradeCardImg(imM[1]) : null,
      animeTitle: anM ? htmlDecodeCard((anM[2] || "").replace(/<[^>]+>/g, "")) : "",
      animeHref: anM ? (anM[1] || "").trim() : "",
      isNew: true,
    });
  }
  return out;
}

// Fetch + parse the witanime home page directly (no headless window). Returns
// null on a fetch failure OR when the page yielded no cards (CF challenge / cold
// body), so the caller falls back to the headless home scrape.
export async function fetchWitHomeDirect(): Promise<WitHomeDirect | null> {
  const html = await window.pantoufa.fetchHtml?.(WIT_BASE + "/", WIT_BASE + "/");
  if (!html) return null;
  const animes = parseWitHomeAnimes(html);
  const episodes = parseWitHomeEpisodes(html);
  if (animes.length === 0 && episodes.length === 0) return null;
  return { featured: parseWitFeatured(html), animes, episodes };
}

// Search anime4up via a direct GET and return the FULL card list (not just the
// best match). Used as the fast path by the search screen.
export async function searchAnime4upDirectList(query: string): Promise<WitCard[] | null> {
  if (!query) return null;
  const url = `${UP4_BASE}/?search_param=animes&s=${encodeURIComponent(query)}`;
  const html = await window.pantoufa.fetchHtml?.(url, UP4_BASE + "/");
  if (!html) return null;
  const cards = parseAnime4upCards(html);
  return cards.map((c) => ({ ...c, status: null, synopsis: null }));
}

// Search witanime via a direct static GET (its search page ships cards in the
// initial HTML, same shape as its listings — no headless render needed). This
// is the PRIMARY search lane: witanime is the authoritative source, so the
// screen shows its results first and only falls back to the other two sources
// for queries witanime has nothing for. Returns null on fetch failure so the
// caller can fall back to the headless scrape (recovers a Cloudflare block).
export async function searchWitanimeDirectList(query: string): Promise<WitCard[] | null> {
  if (!query) return null;
  const url = `${WIT_BASE}/?s=${encodeURIComponent(query)}&search_param=animes`;
  const html = await window.pantoufa.fetchHtml?.(url, WIT_BASE + "/");
  if (!html) return null;
  return parseWitCards(html);
}
