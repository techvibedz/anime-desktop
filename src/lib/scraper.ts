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
  EXTRACT_VIDEO_SERVERS,
  EXTRACT_VIDEO_URL,
  VIDEO_HOOK_INSTALL,
} from "./scripts";

const WIT_BASE = "https://witanime.you";
const UP4_BASE = "https://w1.anime4up.rest";
const ALL_ANIME_PATH = encodeURIComponent("قائمة-الانمي");

function enqueue<T>(job: {
  url: string;
  injectBefore?: string;
  injectAfter: string;
  timeoutMs: number;
  isVideoJob?: boolean;
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
    url: episodeUrl, injectAfter: EXTRACT_VIDEO_SERVERS, timeoutMs: 25000,
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
  if (/streamwish|hlswish|wishembed|wishfast|hgcloud|jwembed|vibuxer|audinifer|masukestin|hanerix/.test(u)) return "streamwish";
  if (/voe\./.test(u)) return "voe";
  if (/share4max|megamax/.test(u)) return "share4max";
  if (/rubyvidhub|streamruby|rubystm|ruby/.test(u)) return "streamruby";
  if (/doodstream|dood\.|dsvplay|d-s\.io|vidply/.test(u)) return "doodstream";
  if (/uqload/.test(u)) return "uqload";
  if (/ok\.ru/.test(u)) return "okru";
  if (/videa\.|vidvaita|vidit/.test(u)) return "videa";
  if (/vk\.com/.test(u)) return "vk";
  return "generic";
}

// Normalize mp4upload watch-page URLs to their embed form so they autoplay.
function normalizeEmbedUrl(src: string): string {
  try {
    const u = new URL(src);
    if (/mp4upload/.test(u.hostname)) {
      if (/\/embed-/.test(u.pathname)) return src;
      const m = u.pathname.match(/^\/([a-z0-9]{8,})/i);
      if (m) return `https://www.mp4upload.com/embed-${m[1]}.html`;
    }
  } catch {}
  return src;
}

// Read anime4up's server list straight from the episode page HTML. anime4up
// serves every server as a <li data-watch="EMBED_URL"><a>NAME</a></li> in the
// initial response, so a single privileged GET (no CORS, no headless render)
// returns all servers fast and reliably — the headless window trips
// anime4up's ad redirects / JS gates and frequently comes back empty.
export async function scrapeAnime4upServersDirect(episodeUrl: string): Promise<RawServer[]> {
  const html = await window.pantoufa.fetchHtml?.(episodeUrl, UP4_BASE + "/");
  if (!html) return [];
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

// ── Direct (no-headless) cross-source search + episode list for anime4up ──
// Both anime4up's search results and anime episode lists are served in the
// initial static HTML, so a privileged GET parses them reliably — the headless
// render trips anime4up's ad redirects / JS gates and frequently returns
// nothing (so "One Piece" et al. get "no cross-source match" even though the
// anime clearly exists). These mirror EXTRACT_TITLE_MATCH / EXTRACT_EPISODES_4UP.

function tm_seasonNum(s: string): number {
  s = (s || "").toLowerCase();
  const m =
    s.match(/\b(?:season|s|part|cour)\s*(\d+)\b/) ||
    s.match(/الموسم\s*([٠-٩\d]+)/) ||
    s.match(/الجزء\s*([٠-٩\d]+)/);
  if (!m) return 1;
  const n = m[1].replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  const v = parseInt(n, 10);
  return isNaN(v) ? 1 : v;
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

// Search anime4up for `title` via a direct GET and return the best-scoring
// anime page URL (or null). Threshold matches EXTRACT_TITLE_MATCH (>=34).
export async function searchAnime4upDirect(title: string): Promise<string | null> {
  if (!title) return null;
  const url = `${UP4_BASE}/?search_param=animes&s=${encodeURIComponent(title)}`;
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
    const s = tm_score(title, cardTitle);
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
      const s = tm_score(title, label);
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
export async function scrapeAnime4upEpisodesDirect(
  animeUrl: string,
): Promise<{ title: string; number: number; type: string; screenshot: string; href: string }[]> {
  const html = await window.pantoufa.fetchHtml?.(animeUrl, UP4_BASE + "/");
  if (!html) return [];
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
