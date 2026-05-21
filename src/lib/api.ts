// Mirrors the mobile lib/api.ts surface but routes through the Electron
// scraper instead of a remote backend.

import { storage } from "./storage";
import {
  scrapeWitanimeHome,
  scrapeEpisodesPage,
  scrapeSearch,
  scrapeRecent,
  scrapeGenre,
  scrapeAllAnime,
  scrapeVideoServers,
  findCrossSourceUrl,
  extractVideoUrl as scrapeExtractVideoUrl,
} from "./scraper";

const HOME_CACHE_KEY = "@home_cache_v1";
const HOME_CACHE_TTL = 30 * 60 * 1000;
const DETAIL_CACHE_PREFIX = "@detail_v1:";
const DETAIL_CACHE_TTL = 30 * 60 * 1000;
const UP4_CACHE_PREFIX = "@up4_eps_v1:";
const UP4_CACHE_TTL = 24 * 60 * 60 * 1000;

async function readCache<T>(key: string, ttlMs: number): Promise<T | null> {
  try {
    const raw = await storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.ts > ttlMs) return null;
    return parsed.data as T;
  } catch {
    return null;
  }
}
async function writeCache(key: string, data: unknown) {
  try {
    await storage.setItem(key, JSON.stringify({ ts: Date.now(), data }));
  } catch {}
}

export interface FeaturedItem {
  title: string; href: string; image: string | null;
  description: string | null; genres: string[];
}
export interface AnimeItem {
  title: string; href: string; image: string;
  type: string | null; status: string | null; description: string | null;
  rating: string | null; isNew: boolean;
  sources?: string[]; sourceHrefs?: Record<string, string>;
}
export interface MergedAnimeItem extends AnimeItem {
  sources: string[]; sourceHrefs: Record<string, string>;
}
export interface EpisodeItem {
  title: string; href: string; image: string;
  animeTitle: string; animeHref: string; isNew: boolean;
}
export interface HomeSection {
  id: string; title: string; type: "anime" | "episode";
  items: (AnimeItem | EpisodeItem)[];
}
export interface Episode {
  title: string; number: number; type: string; screenshot: string;
  href: string | null;
}
export interface AnimeDetail {
  title: string; poster: string; banner: string;
  synopsis: string; genres: string[]; rating: string | null;
  metadata: Record<string, string>;
  externalLinks: { label: string; href: string }[];
  relatedAnime: { title: string; href: string; image: string; type: string | null }[];
  totalEpisodes: number; episodes: Episode[];
}
export interface VideoServer {
  id: string; name: string; iframeUrl: string; provider: string;
}
export interface SearchResult {
  title: string; href: string; image: string;
  type?: string; status?: string; synopsis?: string;
}

function imgOrEmpty(s: string | null | undefined): string { return s ?? ""; }

export function getProxyUrl(videoUrl: string): string { return videoUrl; }

type HomePayload = { success: boolean; data: { featured: FeaturedItem[]; sections: HomeSection[] } };

let bgRefreshInFlight = false;

function buildHomePayload(
  wit: { featured: FeaturedItem[]; animes: any[]; episodes: any[] },
): HomePayload {
  const merged: MergedAnimeItem[] = wit.animes.map((w: any) => ({
    ...w,
    image: imgOrEmpty(w.image),
    sources: ["witanime"],
    sourceHrefs: { witanime: w.href },
  }));

  const featured: FeaturedItem[] = wit.featured;
  const recentEpisodes: EpisodeItem[] = wit.episodes.map((e: any) => ({
    title: e.title, href: e.href, image: imgOrEmpty(e.image),
    animeTitle: e.animeTitle, animeHref: e.animeHref, isNew: e.isNew,
  }));

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
    if (!bgRefreshInFlight) {
      bgRefreshInFlight = true;
      void fetchHomeFresh().finally(() => { bgRefreshInFlight = false; });
    }
    return cached;
  }
  return fetchHomeFresh();
}

const xsourceCache: Map<string, { url: string | null; ts: number }> = new Map();
const XSOURCE_TTL = 24 * 60 * 60 * 1000;

/**
 * Try progressively shorter queries until one returns a match. Anime titles
 * vary between sources ("My Hero Academia 7" on one, "بطلي الأكاديمي الموسم
 * السابع" on the other) — searching with just the franchise root word
 * usually surfaces both.
 */
function searchVariants(title: string): string[] {
  const cleaned = title.replace(/[\(\[][^\)\]]*[\)\]]/g, "").replace(/\s+/g, " ").trim();
  const words = cleaned.split(/\s+/);
  const variants = new Set<string>();
  if (cleaned) variants.add(cleaned);
  if (words.length > 3) variants.add(words.slice(0, 3).join(" "));
  if (words.length > 2) variants.add(words.slice(0, 2).join(" "));
  if (words.length > 1) variants.add(words[0]);
  return Array.from(variants);
}

async function getCrossSourceUrl(title: string, primary: "witanime" | "anime4up"): Promise<string | null> {
  const key = `${primary}:${title.toLowerCase().trim()}`;
  const hit = xsourceCache.get(key);
  if (hit && Date.now() - hit.ts < XSOURCE_TTL) return hit.url;
  let url: string | null = null;
  for (const v of searchVariants(title)) {
    url = await findCrossSourceUrl(v, primary).catch(() => null);
    if (url) break;
  }
  if (!url) {
    console.warn(`[cross-source] no match for "${title}" on ${primary === "witanime" ? "anime4up" : "witanime"}`);
  }
  xsourceCache.set(key, { url, ts: Date.now() });
  return url;
}

function titleFromSlug(url: string): string {
  try {
    const slug = decodeURIComponent(new URL(url).pathname.replace(/\/$/, "").split("/").pop() || "");
    return slug.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

type EpisodesPayload = {
  success: boolean;
  data: AnimeDetail & {
    episodes4up?: Episode[];
    merged?: { anime4up: string } | null;
    /** Direct anime4up URL pulled from the wit page if it advertised one. */
    up4Hint?: string | null;
  };
};

async function fetchEpisodesFresh(animeUrl: string): Promise<EpisodesPayload> {
  const d = await scrapeEpisodesPage(animeUrl);
  const payload: EpisodesPayload = {
    success: true,
    data: {
      title: d.title, poster: d.poster, banner: d.poster,
      synopsis: d.synopsis, genres: d.genres, rating: null,
      metadata: {}, externalLinks: [], relatedAnime: [],
      totalEpisodes: d.episodes.length, episodes: d.episodes,
      episodes4up: [], merged: null,
      up4Hint: d.up4Url ?? null,
    },
  };
  void writeCache(DETAIL_CACHE_PREFIX + animeUrl, payload);
  return payload;
}

export async function fetchEpisodes(animeUrl: string): Promise<EpisodesPayload> {
  const cached = await readCache<EpisodesPayload>(DETAIL_CACHE_PREFIX + animeUrl, DETAIL_CACHE_TTL);
  if (cached) {
    void fetchEpisodesFresh(animeUrl).catch(() => {});
    return cached;
  }
  return fetchEpisodesFresh(animeUrl);
}

export async function fetchEpisodesUp4(
  animeUrl: string,
  title: string | null,
  /** Direct anime4up URL pulled from the wit detail page, if any. */
  up4Hint?: string | null,
): Promise<{ merged: { anime4up: string } | null; episodes4up: Episode[] }> {
  const isAnime4up = /anime4up/i.test(animeUrl);
  if (isAnime4up) {
    const d = await scrapeEpisodesPage(animeUrl).catch(() => null);
    return { merged: { anime4up: animeUrl }, episodes4up: d?.episodes ?? [] };
  }
  const cacheKey = UP4_CACHE_PREFIX + animeUrl;
  const cached = await readCache<{ merged: { anime4up: string } | null; episodes4up: Episode[] }>(cacheKey, UP4_CACHE_TTL);
  if (cached) return cached;

  // Fast path: wit detail page exposed an explicit anime4up href — skip
  // the title-based search and scrape directly.
  let crossUrl: string | null = up4Hint ?? null;
  if (!crossUrl) {
    const lookupTitle = title || titleFromSlug(animeUrl);
    if (lookupTitle) {
      crossUrl = await getCrossSourceUrl(lookupTitle, "witanime").catch(() => null);
    }
  }
  if (!crossUrl) {
    const empty = { merged: null, episodes4up: [] };
    void writeCache(cacheKey, empty);
    return empty;
  }
  let episodes4up: Episode[] = [];
  try {
    const up4 = await scrapeEpisodesPage(crossUrl);
    episodes4up = up4.episodes;
  } catch {}
  const result = { merged: { anime4up: crossUrl }, episodes4up };
  void writeCache(cacheKey, result);
  return result;
}

export async function fetchRecent(page = 1) {
  const r = await scrapeRecent(page);
  const episodes: EpisodeItem[] = r.episodes.map((e) => ({
    title: e.title, href: e.href, image: imgOrEmpty(e.image),
    animeTitle: e.animeTitle, animeHref: e.animeHref, isNew: e.isNew,
  }));
  return { success: true, data: { page, episodes, hasNext: episodes.length > 0 } };
}

// In-flight + short-TTL cache for fetchVideoServers. Without this, a second
// invocation (e.g. StrictMode double-effect, or user re-navigating to the
// same episode quickly) would launch a second wave of BrowserWindow scrapes.
type ServersPayload = Awaited<ReturnType<typeof doFetchVideoServers>>;
const serversCache = new Map<string, { ts: number; promise: Promise<ServersPayload> }>();
const SERVERS_TTL = 5 * 60 * 1000;

export function fetchVideoServers(episodeUrl: string, url4up?: string): Promise<ServersPayload> {
  const key = `${episodeUrl}|${url4up || ""}`;
  const hit = serversCache.get(key);
  if (hit && Date.now() - hit.ts < SERVERS_TTL) return hit.promise;
  const promise = doFetchVideoServers(episodeUrl, url4up).catch((e) => {
    serversCache.delete(key);
    throw e;
  });
  serversCache.set(key, { ts: Date.now(), promise });
  return promise;
}

async function doFetchVideoServers(episodeUrl: string, url4up?: string) {
  const primaryIsUp4 = /anime4up/i.test(episodeUrl);
  const tasks: Promise<{ source: string; servers: any[]; episodeTitle: string; animeTitle: string } | null>[] = [];
  tasks.push(
    scrapeVideoServers(episodeUrl).then((r) => ({
      source: primaryIsUp4 ? "anime4up" : "witanime",
      servers: r.servers, episodeTitle: r.episodeTitle, animeTitle: r.animeTitle,
    })).catch(() => null),
  );
  if (url4up && !primaryIsUp4) {
    tasks.push(
      scrapeVideoServers(url4up)
        .then((r) => ({ source: "anime4up", servers: r.servers, episodeTitle: r.episodeTitle, animeTitle: r.animeTitle }))
        .catch(() => null),
    );
  }
  const results = (await Promise.all(tasks)).filter((x): x is NonNullable<typeof x> => !!x);
  const primary = results[0];
  const secondary = results[1];
  const seen = new Set<string>();
  const merged: (VideoServer & { source?: string })[] = [];
  function add(arr: any[] | undefined, source: string) {
    if (!arr) return;
    for (const s of arr) {
      if (!s.iframeUrl || seen.has(s.iframeUrl)) continue;
      seen.add(s.iframeUrl);
      merged.push({ id: String(merged.length), name: s.name, iframeUrl: s.iframeUrl, provider: s.provider, source });
    }
  }
  if (primary?.source === "witanime") {
    add(primary.servers, "witanime");
    if (secondary) add(secondary.servers, "anime4up");
  } else if (primary?.source === "anime4up") {
    add(primary.servers, "anime4up");
  }
  return {
    success: true,
    data: {
      episodeTitle: primary?.episodeTitle || "",
      animeTitle: primary?.animeTitle || "",
      animeHref: "", serverCount: merged.length, servers: merged,
      navigation: { prev: null, next: null },
    },
  };
}

export async function searchAnime(query: string) {
  const r = await scrapeSearch(query);
  const results: SearchResult[] = r.results.map((it) => ({
    title: it.title, href: it.href, image: imgOrEmpty(it.image),
    type: it.type ?? undefined, status: it.status ?? undefined,
    synopsis: it.synopsis ?? undefined,
  }));
  return { success: true, data: { query, totalResults: results.length, results } };
}

export async function fetchGenre(name: string, page = 1) {
  const r = await scrapeGenre(name, page);
  const items: SearchResult[] = r.items.map((it) => ({
    title: it.title, href: it.href, image: imgOrEmpty(it.image),
    type: it.type ?? undefined, status: it.status ?? undefined,
  }));
  return { success: true, data: { genre: name, page, items, hasNext: items.length > 0 } };
}

export async function fetchAllAnime(page = 1) {
  const r = await scrapeAllAnime(page);
  const items: SearchResult[] = r.items.map((it) => ({
    title: it.title, href: it.href, image: imgOrEmpty(it.image),
    type: it.type ?? undefined, status: it.status ?? undefined,
  }));
  return { success: true, data: { page, items, hasNext: items.length > 0 } };
}

// Coalesce concurrent resolveVideo calls for the same embed (StrictMode
// double-effect + Watch re-renders) and remember the result briefly so
// re-clicking the same pill doesn't re-scrape. Failures are NOT cached —
// auto-retry should always run a fresh attempt.
type ResolvePayload = Awaited<ReturnType<typeof doResolveVideo>>;
const resolveCache = new Map<string, { ts: number; promise: Promise<ResolvePayload> }>();
const RESOLVE_TTL = 60 * 1000;

export function resolveVideo(iframeUrl: string, provider: string): Promise<ResolvePayload> {
  const hit = resolveCache.get(iframeUrl);
  if (hit && Date.now() - hit.ts < RESOLVE_TTL) return hit.promise;
  const promise = doResolveVideo(iframeUrl, provider).then((r) => {
    if (!r.success) resolveCache.delete(iframeUrl);
    return r;
  }).catch((e) => {
    resolveCache.delete(iframeUrl);
    throw e;
  });
  resolveCache.set(iframeUrl, { ts: Date.now(), promise });
  return promise;
}

/**
 * Drop a cached resolveVideo entry so the next call re-scrapes the embed
 * and gets a fresh signed URL. Called when the player detects 401/403/410
 * from the proxy (a sign that the URL's token expired).
 */
export function invalidateResolveCache(iframeUrl: string) {
  resolveCache.delete(iframeUrl);
}

async function doResolveVideo(iframeUrl: string, _provider: string) {
  try {
    const r = await scrapeExtractVideoUrl(iframeUrl);
    if (!r?.url) return { success: false, error: "No video URL found" };
    return {
      success: true,
      data: { videoUrl: r.url, type: /\.m3u8/i.test(r.url) ? "hls" : "mp4" },
    };
  } catch (e: any) {
    return { success: false, error: e?.message ?? "Could not extract video URL" };
  }
}
