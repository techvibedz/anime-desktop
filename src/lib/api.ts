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

const xsourceCache: Map<string, { url: string | null; ts: number }> = new Map();
const XSOURCE_TTL = 24 * 60 * 60 * 1000;

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
    // Retry once on network failure — anime4up is intermittently
    // unreachable so a single timeout shouldn't kill the lookup.
    url = await findCrossSourceUrl(v, primary).catch(async () =>
      new Promise<string | null>((resolve) => setTimeout(resolve, 2000))
        .then(() => findCrossSourceUrl(v, primary).catch(() => null)),
    );
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
  try { episodes4up = (await scrapeEpisodesPage(crossUrl)).episodes; } catch {}
  const result = { merged: { anime4up: crossUrl }, episodes4up };
  void writeCache(cacheKey, result);
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

async function doFetchVideoServers(episodeUrl: string, url4up?: string) {
  const primaryIsUp4 = /anime4up/i.test(episodeUrl);
  const primary = await scrapeVideoServers(episodeUrl).then((r) => ({ source: primaryIsUp4 ? "anime4up" as const : "witanime" as const, servers: r.servers, episodeTitle: r.episodeTitle, animeTitle: r.animeTitle })).catch(() => null);
  const seen = new Set<string>();
  const merged: (VideoServer & { source?: string })[] = [];
  function add(arr: any[] | undefined, source: string) {
    if (!arr) return;
    for (const s of arr) { if (!s.iframeUrl || seen.has(s.iframeUrl)) continue; seen.add(s.iframeUrl); merged.push({ id: String(merged.length), name: s.name, iframeUrl: s.iframeUrl, provider: s.provider, source }); }
  }
  if (primary) add(primary.servers, primary.source);
  return { success: true, data: { episodeTitle: primary?.episodeTitle || "", animeTitle: primary?.animeTitle || "", animeHref: "", serverCount: merged.length, servers: merged, navigation: { prev: null, next: null } } };
}

export async function enrichServersFromUp4(servers: (VideoServer & { source?: string })[], url4up: string): Promise<(VideoServer & { source?: string })[]> {
  try {
    const r = await scrapeVideoServers(url4up);
    const seen = new Set<string>(servers.map((s) => s.iframeUrl));
    const extra: (VideoServer & { source?: string })[] = [];
    for (const s of r.servers) { if (!s.iframeUrl || seen.has(s.iframeUrl)) continue; seen.add(s.iframeUrl); extra.push({ ...s, id: `up4_${servers.length + extra.length}`, source: "anime4up" }); }
    return [...servers, ...extra];
  } catch { return servers; }
}

// ── Video resolve — iframe-hybrid path ──

type ResolvePayload = { success: true; data: { videoUrl: string; type: "hls" | "mp4" | "iframe" } } | { success: false; error: string };
const resolveCache = new Map<string, { ts: number; promise: Promise<ResolvePayload> }>();
const RESOLVE_TTL = 15 * 1000;

export function resolveVideo(iframeUrl: string, provider: string): Promise<ResolvePayload> {
  const hit = resolveCache.get(iframeUrl);
  if (hit && Date.now() - hit.ts < RESOLVE_TTL) return hit.promise;
  const promise = doResolveVideo(iframeUrl, provider).then((r) => { if (!r.success) resolveCache.delete(iframeUrl); return r; }).catch((e) => { resolveCache.delete(iframeUrl); throw e; });
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
  // Every other provider: render the embed in a visible iframe. The user
  // clicks play inside it, the capture listener catches the stream URL,
  // and we swap to the custom <video> player. Extraction via hidden
  // BrowserWindow is NOT attempted — mp4upload times out on this network.
  return { success: true as const, data: { videoUrl: iframeUrl, type: "iframe" as const } };
}
