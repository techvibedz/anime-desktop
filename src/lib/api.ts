import { storage } from "./storage";
import {
  scrapeWitanimeHome,
  scrapeEpisodesPage,
  scrapeSearch,
  scrapeRecent,
  scrapeGenre,
  scrapeAllAnime,
  scrapeVideoServers,
  scrapeAnime4upServersDirect,
  scrapeAnime4upEpisodePageDirect,
  searchAnime4upDirect,
  scrapeAnime4upEpisodesDirect,
  findUp4EpisodeAcrossPages,
  findCrossSourceUrl,
  searchAnime3rbDirect,
  searchAnime3rbCatalog,
  scrapeAnime3rbEpisodeServers,
  type RawServer,
} from "./scraper";

const HOME_CACHE_KEY = "@home_cache_v1";
const HOME_CACHE_TTL = 30 * 60 * 1000;
const DETAIL_CACHE_PREFIX = "@detail_v4:";
const DETAIL_CACHE_TTL = 30 * 60 * 1000;
const UP4_CACHE_PREFIX = "@up4_eps_v2:";
const UP4_CACHE_TTL = 24 * 60 * 60 * 1000;

async function readCache<T>(key: string, ttlMs: number): Promise<T | null> {
  try {
    const raw = await storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.ts > ttlMs) return null;
    return parsed.data as T;
  } catch { return null; }
}
async function writeCache(key: string, data: unknown) {
  try { await storage.setItem(key, JSON.stringify({ ts: Date.now(), data })); } catch {}
}

export interface FeaturedItem { title: string; href: string; image: string | null; description: string | null; genres: string[]; }
export interface AnimeItem { title: string; href: string; image: string; type: string | null; status: string | null; description: string | null; rating: string | null; isNew: boolean; sources?: string[]; sourceHrefs?: Record<string, string>; }
export interface MergedAnimeItem extends AnimeItem { sources: string[]; sourceHrefs: Record<string, string>; }
export interface EpisodeItem { title: string; href: string; image: string; animeTitle: string; animeHref: string; isNew: boolean; }
export interface HomeSection { id: string; title: string; type: "anime" | "episode"; items: (AnimeItem | EpisodeItem)[]; }
export interface Episode { title: string; number: number; type: string; screenshot: string; href: string | null; }
export interface AnimeDetail { title: string; poster: string; banner: string; synopsis: string; genres: string[]; rating: string | null; metadata: Record<string, string>; externalLinks: { label: string; href: string }[]; totalEpisodes: number; episodes: Episode[]; }
export interface VideoServer { id: string; name: string; iframeUrl: string; provider: string; }
export interface SearchResult { title: string; href: string; image: string; type?: string; status?: string; synopsis?: string; }

function imgOrEmpty(s: string | null | undefined): string { return s ?? ""; }
export function getProxyUrl(videoUrl: string): string { return videoUrl; }

type HomePayload = { success: boolean; data: { featured: FeaturedItem[]; sections: HomeSection[] } };
let bgRefreshInFlight = false;

function buildHomePayload(wit: { featured: FeaturedItem[]; animes: any[]; episodes: any[] }): HomePayload {
  const merged: MergedAnimeItem[] = wit.animes.map((w: any) => ({ ...w, image: imgOrEmpty(w.image), sources: ["witanime"], sourceHrefs: { witanime: w.href } }));
  const featured: FeaturedItem[] = wit.featured;
  const recentEpisodes: EpisodeItem[] = wit.episodes.map((e: any) => ({ title: e.title, href: e.href, image: imgOrEmpty(e.image), animeTitle: e.animeTitle, animeHref: e.animeHref, isNew: e.isNew }));
  const sections: HomeSection[] = [];
  if (merged.length > 0) sections.push({ id: "trending", title: "Trending Now", type: "anime", items: merged });
  if (recentEpisodes.length > 0) sections.push({ id: "recently_updated", title: "Recently Updated", type: "episode", items: recentEpisodes });
  const tvItems = merged.filter((a) => a.type && (a.type.includes("TV") || a.type.includes("مسلسل")));
  const movieItems = merged.filter((a) => a.type && (a.type.includes("فيلم") || a.type.includes("Movie")));
  if (tvItems.length >= 3) sections.push({ id: "tv_series", title: "TV Series", type: "anime", items: tvItems });
  if (movieItems.length >= 2) sections.push({ id: "movies", title: "Movies", type: "anime", items: movieItems });
  return { success: true, data: { featured: featured.slice(0, 5), sections } };
}

async function fetchHomeFresh(): Promise<HomePayload> {
  const wit = await scrapeWitanimeHome();
  const result = buildHomePayload(wit);
  void writeCache(HOME_CACHE_KEY, result);
  return result;
}

export async function fetchHome(): Promise<HomePayload> {
  const cached = await readCache<HomePayload>(HOME_CACHE_KEY, HOME_CACHE_TTL);
  if (cached) {
    if (!bgRefreshInFlight) { bgRefreshInFlight = true; void fetchHomeFresh().finally(() => { bgRefreshInFlight = false; }); }
    return cached;
  }
  return fetchHomeFresh();
}

// Drop the home cache so the next fetchHome() re-scrapes from scratch instead
// of replaying an empty/stale list. Used by the header refresh button when the
// page came up without its animes (failed first scrape on startup).
export async function clearHomeCache(): Promise<void> {
  try { await storage.removeItem(HOME_CACHE_KEY); } catch {}
}

const xsourceCache: Map<string, { url: string | null; ts: number }> = new Map();
const XSOURCE_TTL = 24 * 60 * 60 * 1000;

function searchVariants(title: string): string[] {
  // Drop bracketed/parenthetical notes and collapse whitespace.
  const cleaned = title.replace(/[\(\[][^\)\]]*[\)\]]/g, "").replace(/\s+/g, " ").trim();
  const variants = new Set<string>();
  const add = (s: string) => { const t = (s || "").replace(/\s+/g, " ").trim(); if (t) variants.add(t); };

  // Full cleaned title first — when it matches it's the most precise.
  add(cleaned);
  // anime4up's search returns ZERO results when the query carries a long
  // subtitle after a colon ("… 4th Season: 2-nensei-hen 1 Gakki") or trailing
  // punctuation ("Tadaima Ojamasaremasu!"). Emit cleaner — but still specific —
  // variants BEFORE the crude word-count truncations so the FIRST hit is a
  // precise, correctly-scored match instead of a lucky first-word result that
  // can resolve to the wrong anime. Candidates are always scored against the
  // FULL title by the caller, so a too-broad variant can't mis-match.
  add(cleaned.split(/\s*[:：]\s*/)[0]);              // strip ": subtitle"
  add(cleaned.split(/\s+[-–—]\s+/)[0]);             // strip " - subtitle"
  add(cleaned.replace(/[^\p{L}\p{N} ]+/gu, " "));   // strip stray punctuation (!, ., …)

  // Parenthesized alternative names: witanime often appends the romaji
  // original in parens ("The Beginning After the End Season 2 (Saikyou no
  // Ousama Nidome no Jinsei wa Nani wo Suru Season 2)") and anime4up indexes
  // the anime ONLY under the romaji name — every English-title query returns
  // zero results. Candidates are still scored against the FULL title, whose
  // tokens include the parenthesized words, so this can't mis-match.
  const reParen = /[\(\[]([^\)\]]+)[\)\]]/g;
  let pm: RegExpExecArray | null;
  while ((pm = reParen.exec(title))) {
    const inner = pm[1].trim();
    if (!inner) continue;
    add(inner);
    add(inner.split(/\s*[:：]\s*/)[0]);
    // The long-query-returns-zero quirk applies to the alt name too
    // (the full "Saikyou no Ousama Nidome no Jinsei wa Nani wo Suru Season 2"
    // finds nothing; "Saikyou no Ousama" finds it), so truncate it as well.
    const iw = inner.split(/\s+/);
    if (iw.length > 3) add(iw.slice(0, 3).join(" "));
    if (iw.length > 2) add(iw.slice(0, 2).join(" "));
  }

  // Last-resort progressive head truncations.
  const words = cleaned.split(/\s+/);
  if (words.length > 3) add(words.slice(0, 3).join(" "));
  if (words.length > 2) add(words.slice(0, 2).join(" "));
  if (words.length > 1) add(words[0]);
  return Array.from(variants);
}

async function getCrossSourceUrl(title: string, primary: "witanime" | "anime4up"): Promise<string | null> {
  const key = `${primary}:${title.toLowerCase().trim()}`;
  const hit = xsourceCache.get(key);
  if (hit && Date.now() - hit.ts < XSOURCE_TTL) return hit.url;
  let url: string | null = null;
  // Fast lane: when the target is anime4up, search its static HTML directly.
  // The headless render trips anime4up's ad redirects / JS gates and often
  // returns an empty result (so even "One Piece" gets no cross-source match).
  if (primary === "witanime") {
    for (const v of searchVariants(title)) {
      try {
        // Search with the (possibly truncated) variant but score candidates
        // against the full title so season disambiguation survives.
        const direct = await searchAnime4upDirect(v, title);
        if (direct) { url = direct; break; }
      } catch { /* fall through to headless */ }
    }
    if (url) {
      console.info(`[cross-source] direct anime4up match for "${title}": ${url}`);
      xsourceCache.set(key, { url, ts: Date.now() });
      return url;
    }
    console.info(`[cross-source] direct search found nothing for "${title}", trying headless`);
  }
  for (const v of searchVariants(title)) {
    // Retry up to 3 times on network failure — anime4up is intermittently
    // unreachable so a single timeout shouldn't kill the lookup.
    // Wait 8s between retries to give the network time to recover.
    url = await findCrossSourceUrl(v, primary).catch(async () => {
      await new Promise((r) => setTimeout(r, 8000));
      return findCrossSourceUrl(v, primary).catch(async () => {
        await new Promise((r) => setTimeout(r, 8000));
        return findCrossSourceUrl(v, primary).catch(async () => {
          await new Promise((r) => setTimeout(r, 8000));
          return findCrossSourceUrl(v, primary).catch(() => null);
        });
      });
    });
    if (url) break;
  }
  if (!url) console.warn(`[cross-source] no match for "${title}" on ${primary === "witanime" ? "anime4up" : "witanime"}`);
  // Only cache successful hits — null entries poison the cache and
  // prevent retries when anime4up comes back online.
  if (url) xsourceCache.set(key, { url, ts: Date.now() });
  return url;
}

function titleFromSlug(url: string): string {
  try { const slug = decodeURIComponent(new URL(url).pathname.replace(/\/$/, "").split("/").pop() || ""); return slug.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim(); } catch { return ""; }
}

type EpisodesPayload = { success: boolean; data: AnimeDetail & { episodes4up?: Episode[]; merged?: { anime4up: string } | null; up4Hint?: string | null; }; };

async function fetchEpisodesFresh(animeUrl: string): Promise<EpisodesPayload> {
  const d = await scrapeEpisodesPage(animeUrl);
  const payload: EpisodesPayload = {
    success: true,
    data: { title: d.title, poster: d.poster, banner: d.poster, synopsis: d.synopsis, genres: d.genres, rating: null, metadata: {}, externalLinks: [], totalEpisodes: d.episodes.length, episodes: d.episodes, episodes4up: [], merged: null, up4Hint: d.up4Url ?? null },
  };
  void writeCache(DETAIL_CACHE_PREFIX + animeUrl, payload);
  return payload;
}

export async function fetchEpisodes(animeUrl: string): Promise<EpisodesPayload> {
  const cached = await readCache<EpisodesPayload>(DETAIL_CACHE_PREFIX + animeUrl, DETAIL_CACHE_TTL);
  if (cached) { void fetchEpisodesFresh(animeUrl).catch(() => {}); return cached; }
  return fetchEpisodesFresh(animeUrl);
}

export async function fetchEpisodesUp4(animeUrl: string, title: string | null, up4Hint?: string | null): Promise<{ merged: { anime4up: string } | null; episodes4up: Episode[] }> {
  const isAnime4up = /anime4up/i.test(animeUrl);
  if (isAnime4up) { const d = await scrapeEpisodesPage(animeUrl).catch(() => null); return { merged: { anime4up: animeUrl }, episodes4up: d?.episodes ?? [] }; }
  const cacheKey = UP4_CACHE_PREFIX + animeUrl;
  const cached = await readCache<{ merged: { anime4up: string } | null; episodes4up: Episode[] }>(cacheKey, UP4_CACHE_TTL);
  if (cached) return cached;
  let crossUrl: string | null = up4Hint ?? null;
  if (!crossUrl) { const lookupTitle = title || titleFromSlug(animeUrl); if (lookupTitle) crossUrl = await getCrossSourceUrl(lookupTitle, "witanime").catch(() => null); }
  if (!crossUrl) return { merged: null, episodes4up: [] };
  let episodes4up: Episode[] = [];
  // Fast lane: parse the episode list from anime4up's static HTML. Falls back
  // to the headless scrape (with one retry) only when the direct parse is empty.
  try {
    episodes4up = await scrapeAnime4upEpisodesDirect(crossUrl);
  } catch { /* fall through */ }
  if (episodes4up.length === 0) {
    // Retry episode scraping once on failure — anime4up is intermittently slow
    try {
      episodes4up = (await scrapeEpisodesPage(crossUrl)).episodes;
    } catch {
      await new Promise((r) => setTimeout(r, 5000));
      try { episodes4up = (await scrapeEpisodesPage(crossUrl)).episodes; } catch {}
    }
  }
  const result = { merged: { anime4up: crossUrl }, episodes4up };
  // Only cache a populated episode list. anime4up is flaky and frequently
  // returns an empty list on the first try; caching that empty result for 24h
  // would block every later attempt (and the manual refresh) from ever landing
  // the anime4up siblings — exactly why some anime "never" show anime4up servers.
  if (episodes4up.length > 0) void writeCache(cacheKey, result);
  return result;
}

export async function fetchRecent(page = 1) {
  const r = await scrapeRecent(page);
  return { success: true, data: { page, episodes: r.episodes.map((e) => ({ title: e.title, href: e.href, image: imgOrEmpty(e.image), animeTitle: e.animeTitle, animeHref: e.animeHref, isNew: e.isNew })), hasNext: r.episodes.length > 0 } };
}

export async function searchAnime(query: string) {
  const r = await scrapeSearch(query);
  return { success: true, data: { query, totalResults: r.results.length, results: r.results.map((it) => ({ title: it.title, href: it.href, image: imgOrEmpty(it.image), type: it.type ?? undefined, status: it.status ?? undefined, synopsis: it.synopsis ?? undefined })) } };
}

export async function fetchGenre(name: string, page = 1) {
  const r = await scrapeGenre(name, page);
  return { success: true, data: { genre: name, page, items: r.items.map((it) => ({ title: it.title, href: it.href, image: imgOrEmpty(it.image), type: it.type ?? undefined, status: it.status ?? undefined })), hasNext: r.items.length > 0 } };
}

export async function fetchAllAnime(page = 1) {
  const r = await scrapeAllAnime(page);
  return { success: true, data: { page, items: r.items.map((it) => ({ title: it.title, href: it.href, image: imgOrEmpty(it.image), type: it.type ?? undefined, status: it.status ?? undefined })), hasNext: r.items.length > 0 } };
}

// ── Video server fetching ──

type ServersPayload = Awaited<ReturnType<typeof doFetchVideoServers>>;
const serversCache = new Map<string, { ts: number; promise: Promise<ServersPayload> }>();
const SERVERS_TTL = 5 * 60 * 1000;

export function fetchVideoServers(episodeUrl: string, url4up?: string): Promise<ServersPayload> {
  const key = `${episodeUrl}|${url4up || ""}`;
  const hit = serversCache.get(key);
  if (hit && Date.now() - hit.ts < SERVERS_TTL) return hit.promise;
  const promise = doFetchVideoServers(episodeUrl, url4up).catch((e) => { serversCache.delete(key); throw e; });
  serversCache.set(key, { ts: Date.now(), promise });
  return promise;
}

// Drop every cached server list for an episode (regardless of which
// anime4up url was paired with it) so leaving and re-opening the episode
// triggers a fresh scrape instead of replaying stale servers/tokens.
export function invalidateServersCache(episodeUrl: string) {
  const prefix = `${episodeUrl}|`;
  for (const key of serversCache.keys()) {
    if (key.startsWith(prefix)) serversCache.delete(key);
  }
}

async function doFetchVideoServers(episodeUrl: string, url4up?: string) {
  const primaryIsUp4 = /anime4up/i.test(episodeUrl);
  // Fast lane for anime4up-primary episodes: the entire server list lives in
  // the static HTML, so a single privileged GET returns it in well under a
  // second — the headless render takes many seconds and often trips
  // anime4up's ad gates. Fall back to the headless scrape only when the
  // direct parse yields nothing.
  let primary: { source: "anime4up" | "witanime"; servers: any[]; episodeTitle: string; animeTitle: string; up4EpisodeUrl: string | null } | null = null;
  if (primaryIsUp4) {
    try {
      const direct = await scrapeAnime4upEpisodePageDirect(episodeUrl);
      if (direct) {
        console.info(`[servers] direct anime4up parse: ${direct.servers.length} servers`);
        primary = { source: "anime4up", servers: direct.servers, episodeTitle: direct.episodeTitle, animeTitle: direct.animeTitle, up4EpisodeUrl: null };
      }
    } catch { /* fall through to headless */ }
  }
  if (!primary) {
    primary = await scrapeVideoServers(episodeUrl).then((r) => ({ source: primaryIsUp4 ? "anime4up" as const : "witanime" as const, servers: r.servers, episodeTitle: r.episodeTitle, animeTitle: r.animeTitle, up4EpisodeUrl: r.up4EpisodeUrl ?? null })).catch(() => null);
  }
  const seen = new Set<string>();
  const merged: (VideoServer & { source?: string })[] = [];
  function add(arr: any[] | undefined, source: string) {
    if (!arr) return;
    for (const s of arr) { if (!s.iframeUrl || seen.has(s.iframeUrl)) continue; seen.add(s.iframeUrl); merged.push({ id: String(merged.length), name: s.name, iframeUrl: s.iframeUrl, provider: s.provider, source }); }
  }
  if (primary) add(primary.servers, primary.source);
  // A direct anime4up episode link harvested off the witanime page lets the
  // watch screen enrich anime4up servers immediately, skipping the slow
  // cross-source search. Prefer an explicit ?up4= but fall back to it.
  const harvestedUp4 = (!primaryIsUp4 && primary?.up4EpisodeUrl && /\/episode\/|الحلقة/i.test(primary.up4EpisodeUrl)) ? primary.up4EpisodeUrl : null;
  return { success: true, data: { episodeTitle: primary?.episodeTitle || "", animeTitle: primary?.animeTitle || "", animeHref: "", serverCount: merged.length, servers: merged, up4EpisodeUrl: harvestedUp4, navigation: { prev: null, next: null } } };
}

// Resolve the anime4up episode URL for a given anime title + episode number
// using only direct (no-headless) HTTP fetches. This is the robust fallback
// for the watch screen when there's no explicit ?up4= and nothing was
// harvested off the witanime page (e.g. One Piece, where witanime carries no
// anime4up link). Returns the matching episode URL, or null.
const up4EpUrlCache = new Map<string, { url: string | null; ts: number }>();
const UP4_EP_URL_PREFIX = "@up4_ep_url_v1:";
export async function resolveUp4EpisodeUrl(animeTitle: string, epNumber: number): Promise<string | null> {
  if (!animeTitle || epNumber == null) return null;
  const key = `${animeTitle.toLowerCase().trim()}#${epNumber}`;
  const hit = up4EpUrlCache.get(key);
  if (hit && Date.now() - hit.ts < UP4_CACHE_TTL) return hit.url;
  // Successful resolutions are persisted, so revisiting an episode after an
  // app restart serves the anime4up URL instantly instead of re-running the
  // search + episode-list fetches (the main "servers take a while" cost).
  const stored = await readCache<string>(UP4_EP_URL_PREFIX + key, UP4_CACHE_TTL);
  if (stored) { up4EpUrlCache.set(key, { url: stored, ts: Date.now() }); return stored; }
  console.info(`[up4-resolve] searching anime4up for "${animeTitle}" ep ${epNumber}`);
  let animeUrl: string | null = null;
  for (const v of searchVariants(animeTitle)) {
    try {
      // Search with the (possibly truncated) variant but score candidates
      // against the full title so a shorter variant like "Boku no Hero"
      // doesn't match the wrong season's page (which lacks this episode).
      animeUrl = await searchAnime4upDirect(v, animeTitle);
      if (animeUrl) break;
    } catch (e) { console.warn(`[up4-resolve] search variant "${v}" threw:`, e); }
  }
  if (!animeUrl) {
    console.warn(`[up4-resolve] no anime4up anime page found for "${animeTitle}"`);
    return null;
  }
  console.info(`[up4-resolve] matched anime page: ${animeUrl}`);
  // Pagination-aware lookup: anime4up anime pages only list the newest ~40
  // episodes on page 1 (One Piece spans 25 pages), so a page-1 parse can NEVER
  // find an older episode — which made anime4up servers permanently absent for
  // catch-up watching. findUp4EpisodeAcrossPages walks the pagination toward
  // the requested number instead.
  let url: string | null = null;
  try {
    url = await findUp4EpisodeAcrossPages(animeUrl, epNumber);
  } catch (e) { console.warn(`[up4-resolve] episode lookup threw:`, e); }
  if (url) console.info(`[up4-resolve] found ep ${epNumber}: ${url}`);
  else console.warn(`[up4-resolve] ep ${epNumber} not found on anime4up pages`);
  // Only cache a successful resolution. anime4up's search / episode list is
  // intermittently empty (ad gates, rate-limited request bursts on page load);
  // caching a null for 24h would permanently block retries — including the
  // natural re-runs as better titles arrive and the manual refresh — so some
  // anime would "never" get anime4up servers. Mirror getCrossSourceUrl, which
  // also only caches hits.
  if (url) {
    up4EpUrlCache.set(key, { url, ts: Date.now() });
    void writeCache(UP4_EP_URL_PREFIX + key, url);
  }
  return url;
}

// ── anime3rb (third server source) ──
// anime3rb's episode URLs are constructible (/episode/<slug>/<number>), so
// resolving an episode is just "find the title page once, then append the
// number". The title resolution result is cached in memory AND persisted so
// every later episode of the same anime resolves instantly. Mirrors the
// anime4up lesson: only successful resolutions are cached — caching a miss
// for 24h would permanently block retries while the site is briefly flaky.
const a3rbTitleCache = new Map<string, { url: string; ts: number }>();
const A3RB_TITLE_PREFIX = "@a3rb_title_v1:";

async function resolveAnime3rbTitleUrl(animeTitle: string): Promise<string | null> {
  if (!animeTitle) return null;
  const key = animeTitle.toLowerCase().trim();
  const hit = a3rbTitleCache.get(key);
  if (hit && Date.now() - hit.ts < UP4_CACHE_TTL) return hit.url;
  const stored = await readCache<string>(A3RB_TITLE_PREFIX + key, UP4_CACHE_TTL);
  if (stored) { a3rbTitleCache.set(key, { url: stored, ts: Date.now() }); return stored; }
  // Slug guessing first: anime3rb's slugs derive cleanly from romaji titles,
  // so this lands in one or two cheap GETs for the vast majority of anime.
  let url = await searchAnime3rbDirect(animeTitle).catch(() => null);
  if (!url) {
    // Catalog matching second: anime3rb's daily titles sitemap (one plain
    // GET, cached in-memory) covers anime whose slug can't be guessed —
    // different romanization, alt-name-only indexing, shortened titles.
    console.info(`[a3rb-resolve] slug guesses missed for "${animeTitle}", matching sitemap catalog`);
    url = await searchAnime3rbCatalog(animeTitle).catch(() => null);
  }
  // NOTE: no headless /search fallback. anime3rb's /search sits behind a
  // Cloudflare managed challenge that never completes inside the hidden
  // scraper window (verified: it idles on the interstitial until timeout), so
  // the old fallback could never succeed — it just pinned the in-flight latch
  // for 45s, which BLOCKED the quick re-run with the better scraped title.
  // Failing fast here lets the watch screen's retry loop converge instead.
  if (url) {
    console.info(`[a3rb-resolve] matched title page: ${url}`);
    a3rbTitleCache.set(key, { url, ts: Date.now() });
    void writeCache(A3RB_TITLE_PREFIX + key, url);
  } else {
    console.warn(`[a3rb-resolve] no anime3rb match for "${animeTitle}"`);
  }
  return url;
}

// Servers for an episode by anime title + episode number. Returns [] on any
// miss (unknown anime, episode not yet uploaded, transient fetch failure) —
// the watch screen's retry loop decides whether to try again.
export async function fetchAnime3rbServers(animeTitle: string, epNumber: number): Promise<RawServer[]> {
  if (!animeTitle || epNumber == null) return [];
  const titleUrl = await resolveAnime3rbTitleUrl(animeTitle);
  if (!titleUrl) return [];
  const slug = titleUrl.replace(/\/+$/, "").split("/").pop();
  if (!slug) return [];
  const episodeUrl = `https://anime3rb.com/episode/${slug}/${epNumber}`;
  const servers = await scrapeAnime3rbEpisodeServers(episodeUrl).catch(() => [] as RawServer[]);
  if (servers.length > 0) console.info(`[a3rb-resolve] ep ${epNumber}: ${servers.length} server(s) from ${episodeUrl}`);
  return servers;
}

export async function enrichServersFromUp4(servers: (VideoServer & { source?: string })[], url4up: string): Promise<(VideoServer & { source?: string })[]> {
  try {
    console.info(`[enrich] fetching anime4up servers from: ${url4up}`);
    // Fast lane: read the server list straight from anime4up's static HTML.
    // The headless render trips anime4up's ad redirects / JS gates and often
    // returns nothing, so try a direct GET first and only fall back to the
    // headless scrape if it yields no servers.
    let up4Servers: RawServer[] = [];
    try {
      up4Servers = await scrapeAnime4upServersDirect(url4up);
      console.info(`[enrich] direct fetch found ${up4Servers.length} anime4up servers`);
    } catch (e) {
      console.warn(`[enrich] direct fetch failed:`, e);
    }
    if (up4Servers.length === 0) {
      console.info(`[enrich] falling back to headless scrape`);
      const r = await scrapeVideoServers(url4up);
      console.info(`[enrich] headless found ${r.servers.length} anime4up servers`);
      up4Servers = r.servers;
    }
    const seen = new Set<string>(servers.map((s) => s.iframeUrl));
    const extra: (VideoServer & { source?: string })[] = [];
    for (const s of up4Servers) { if (!s.iframeUrl || seen.has(s.iframeUrl)) continue; seen.add(s.iframeUrl); extra.push({ ...s, id: `up4_${servers.length + extra.length}`, source: "anime4up" }); }
    console.info(`[enrich] added ${extra.length} new anime4up servers`);
    return [...servers, ...extra];
  } catch (e) {
    console.warn(`[enrich] failed to scrape anime4up:`, e);
    return servers;
  }
}

// ── Video resolve — iframe-hybrid path ──

// Providers we attempt to extract a direct stream from (→ custom <video>
// player), falling back to their iframe only when extraction yields nothing.
// dailymotion/videa/mp4upload are handled by their own branches above; this
// set covers the ones routed through directExtract generically.
const CUSTOM_PLAYER_PROVIDERS = new Set([
  "voe", "share4max", "streamruby", "uqload", "okru",
  "streamwish", "doodstream", "vk",
  // anime3rb's first-party host: one static GET on the player page yields
  // direct tokenized .mp4 qualities, so extraction is near-instant and the
  // custom player is the normal path (iframe only as a last resort).
  "vid3rb",
]);

// Providers we expect to yield a direct stream (.m3u8/.mp4). When extraction
// for one of these comes back as an iframe fallback the extraction FAILED
// (transient Cloudflare check / slow embed) — caching that fallback would
// poison the user's Play click (or a retry) with a stale iframe for the full
// TTL, which is exactly why a server "sometimes" refused to run in the custom
// player. mp4upload and videa are included (their own branches return a
// direct stream or iframe).
const EXPECT_DIRECT_PROVIDERS = new Set([...CUSTOM_PLAYER_PROVIDERS, "mp4upload", "videa"]);

type ResolvePayload = { success: true; data: { videoUrl: string; type: "hls" | "mp4" | "iframe" } } | { success: false; error: string };
const resolveCache = new Map<string, { ts: number; promise: Promise<ResolvePayload> }>();
// 90s (was 15s): long enough that the prefetch fired when the server list
// loads still serves the user's Play click, and that a click during a slow
// in-flight extraction reuses that promise instead of starting a second
// one. Provider stream tokens live far longer than this, and the 410
// re-extract path covers the rare expiry anyway.
const RESOLVE_TTL = 90 * 1000;

export function resolveVideo(iframeUrl: string, provider: string): Promise<ResolvePayload> {
  const hit = resolveCache.get(iframeUrl);
  if (hit && Date.now() - hit.ts < RESOLVE_TTL) return hit.promise;
  const promise = doResolveVideo(iframeUrl, provider).then((r) => {
    // Don't cache hard failures, nor iframe fallbacks for providers we expect
    // to extract a direct stream from: those fallbacks mean extraction missed
    // this round, and caching them makes the next resolve (prefetch → click,
    // or a manual retry) replay the stale iframe instead of re-extracting.
    const isFallback = r.success && r.data?.type === "iframe";
    if (!r.success || (isFallback && EXPECT_DIRECT_PROVIDERS.has(provider))) {
      resolveCache.delete(iframeUrl);
    }
    return r;
  }).catch((e) => { resolveCache.delete(iframeUrl); throw e; });
  resolveCache.set(iframeUrl, { ts: Date.now(), promise });
  return promise;
}

export function invalidateResolveCache(iframeUrl: string) { resolveCache.delete(iframeUrl); }

async function doResolveVideo(iframeUrl: string, provider: string) {
  if (provider === "dailymotion" || provider === "videa") {
    try {
      const direct = await window.pantoufa.directExtract?.(provider, iframeUrl);
      if (direct?.url) return { success: true as const, data: { videoUrl: direct.url, type: direct.type } };
    } catch {}
    return { success: true as const, data: { videoUrl: iframeUrl, type: "iframe" as const } };
  }
  // mp4upload renders a BLACK player inside the embed iframe: loaded from
  // file://, document.referrer is empty and mp4upload anti-hotlinks it. Pull
  // the real .mp4 URL server-side and play it in the native player via the
  // proxy (which forces the canonical Referer the CDN wants). Fall back to
  // the iframe only if extraction comes up empty.
  if (provider === "mp4upload") {
    try {
      const direct = await window.pantoufa.directExtract?.(provider, iframeUrl);
      if (direct?.url) return { success: true as const, data: { videoUrl: direct.url, type: direct.type } };
    } catch {}
    return { success: true as const, data: { videoUrl: iframeUrl, type: "iframe" as const } };
  }
  // Providers whose stream we can pull server-side (real .m3u8/.mp4 for the
  // capture set; data-options JSON for ok.ru). Extracting lets them play in
  // the custom <video> player instead of the provider's iframe. If extraction
  // comes up empty (Cloudflare, layout drift, geo-block), fall back to the
  // iframe so the user still gets a picture.
  if (CUSTOM_PLAYER_PROVIDERS.has(provider)) {
    try {
      const direct = await window.pantoufa.directExtract?.(provider, iframeUrl);
      if (direct?.url) return { success: true as const, data: { videoUrl: direct.url, type: direct.type } };
    } catch {}
    return { success: true as const, data: { videoUrl: iframeUrl, type: "iframe" as const } };
  }
  // Remaining providers (generic/unknown): render the embed in a visible
  // iframe — we have no extractor for them, so the provider's own player
  // is the surface.
  return { success: true as const, data: { videoUrl: iframeUrl, type: "iframe" as const } };
}
