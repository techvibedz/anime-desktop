import { storage } from "./storage";
import { fuzzyScore } from "./fuzzy";
import {
  scrapeWitanimeHome,
  fetchWitHomeDirect,
  scrapeEpisodesPage,
  scrapeSearch,
  scrapeRecent,
  scrapeGenre,
  scrapeAllAnime,
  scrapeVideoServers,
  scrapeAnime4upServersDirect,
  scrapeAnime4upEpisodePageDirect,
  scrapeWitanimeEpisodePageDirect,
  searchAnime4upDirect,
  searchAnime4upDirectList,
  searchWitanimeDirectList,
  scrapeAnime4upEpisodesDirect,
  findUp4EpisodeAcrossPages,
  findCrossSourceUrl,
  searchAnime3rbDirect,
  searchAnime3rbCatalog,
  searchAnime3rbCatalogFuzzy,
  scrapeAnime3rbEpisodeServers,
  scrapeAnime3rbTitlePage,
  anime3rbExactSlugs,
  tm_seasonNum,
  type RawServer,
} from "./scraper";
import { getAltTitles } from "./altTitles";
import { animeTitleKey } from "./history";

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

// Strip the SEO boilerplate the source sites bake into an anime page's "story"
// field so the detail screen never shows junk like "تحميل ومشاهدة جميع حلقات …".
// A real Arabic synopsis is kept intact; pure boilerplate collapses to "".
const SYNOPSIS_JUNK =
  /تحميل\s*و?\s*مشاهدة|مشاهدة\s*و?\s*تحميل|اون\s*لاين|أون\s*لاين|أونلاين|بجودة\s*عالية|جميع\s*حلقات|anime3rb|anime4up|witanime|أنمي\s*عرب|انمي\s*عرب|حصرياً\s*على/i;
function cleanSynopsis(raw: string | null | undefined): string {
  let s = (raw || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  s = s.replace(/^\s*(?:قصة\s*(?:الأنمي|الانمي)?|القصة|story|synopsis)\s*[:：\-–]?\s*/i, "").trim();
  if (SYNOPSIS_JUNK.test(s)) {
    const kept = s
      .split(/[.!؟\n]+/)
      .map((p) => p.trim())
      .filter((p) => p && !SYNOPSIS_JUNK.test(p));
    s = kept.join(". ").trim();
  }
  return s.length < 25 ? "" : s;
}

// Strip the SEO/source decoration the sites bake into an anime's TITLE — a
// leading "أنمي" word, a trailing "مترجم"/"مدبلج", a site-name suffix — so the
// detail page shows just the anime's name (and the downstream Jikan/AniList
// lookups resolve to the right entry). Clean titles pass through unchanged.
function cleanAnimeTitle(raw: string | null | undefined): string {
  let s = (raw || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  s = s.replace(/\s*[|–—\-]\s*(?:anime3rb|anime4up|witanime)\b.*$/i, "").trim();
  s = s.replace(/^(?:مشاهدة|تحميل|جميع\s*(?:حلقات|الحلقات)|أنمي|انمي|انيمي)\s+/g, "").trim();
  s = s.replace(/^(?:أنمي|انمي|انيمي)\s+/g, "").trim();
  for (let i = 0; i < 3; i++) {
    s = s.replace(/\s*(?:مترجمة?|مدبلجة?|اون\s*لاين|أون\s*لاين|أونلاين|بجودة\s*عالية|كامل[ةه]?)\s*$/g, "").trim();
  }
  return s.replace(/\s+/g, " ").trim();
}

type HomePayload = { success: boolean; data: { featured: FeaturedItem[]; sections: HomeSection[] } };
let bgRefreshInFlight = false;

function normalizeHomeSource(wit: { featured?: any[]; animes?: any[]; episodes?: any[] } | null | undefined) {
  return {
    featured: Array.isArray(wit?.featured) ? wit.featured : [],
    animes: Array.isArray(wit?.animes) ? wit.animes : [],
    episodes: Array.isArray(wit?.episodes) ? wit.episodes : [],
  };
}

function buildHomePayload(witRaw: { featured?: FeaturedItem[]; animes?: any[]; episodes?: any[] } | null | undefined): HomePayload {
  const wit = normalizeHomeSource(witRaw);
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
  // Fast path: read the home page's static HTML directly (sub-second, no headless
  // window cold-start / Cloudflare-clear). Fall back to the headless scrape only
  // when the direct fetch comes back empty (CF challenge / cold body).
  let wit = normalizeHomeSource(await fetchWitHomeDirect().catch(() => null));
  if (!wit || (wit.animes.length === 0 && wit.episodes.length === 0)) {
    wit = normalizeHomeSource(await scrapeWitanimeHome().catch(() => null));
  }
  if (wit.animes.length === 0 && wit.episodes.length === 0) {
    throw new Error("Home content unavailable");
  }
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
  // anime3rb anime pages aren't witanime/anime4up shaped, so they're scraped via
  // the static title-page parser. This lets anime that live ONLY on anime3rb
  // (surfaced by search) open as a first-class detail page with a playable list.
  if (/anime3rb\.com/i.test(animeUrl)) {
    const a = await scrapeAnime3rbTitlePage(animeUrl);
    // An anime3rb-only search hit whose title page won't parse (Cloudflare, or a
    // catalog entry with no episodes uploaded yet) would otherwise render a blank
    // detail — the "shows in search but the page is empty" symptom. Resolve the
    // same title to its witanime page instead: that page merges all three
    // sources' episodes (matches the mobile app, which never dead-ends on an
    // anime3rb-only card). Only pay this lookup when anime3rb yields nothing.
    if (!a || a.episodes.length === 0) {
      const lookupTitle = cleanAnimeTitle(a?.title) || titleFromSlug(animeUrl);
      const witUrl = lookupTitle
        ? await findCrossSourceUrl(lookupTitle, "anime4up").catch(() => null)
        : null;
      if (witUrl) {
        const p = await fetchEpisodesFresh(witUrl);
        // Cache under the anime3rb key too so revisits skip the headless lookup.
        void writeCache(DETAIL_CACHE_PREFIX + animeUrl, p);
        return p;
      }
    }
    const payload: EpisodesPayload = {
      success: !!a,
      data: {
        title: cleanAnimeTitle(a?.title), poster: a?.poster || "", banner: a?.poster || "",
        synopsis: cleanSynopsis(a?.synopsis), genres: a?.genres || [], rating: null,
        metadata: {}, externalLinks: [], totalEpisodes: a?.episodes.length || 0,
        episodes: a?.episodes || [], episodes4up: [], merged: null, up4Hint: null,
      },
    };
    if (a) void writeCache(DETAIL_CACHE_PREFIX + animeUrl, payload);
    return payload;
  }
  const d = await scrapeEpisodesPage(animeUrl);
  const payload: EpisodesPayload = {
    success: true,
    data: { title: cleanAnimeTitle(d.title), poster: d.poster, banner: d.poster, synopsis: cleanSynopsis(d.synopsis), genres: d.genres, rating: null, metadata: {}, externalLinks: [], totalEpisodes: d.episodes.length, episodes: d.episodes, episodes4up: [], merged: null, up4Hint: d.up4Url ?? null },
  };
  void writeCache(DETAIL_CACHE_PREFIX + animeUrl, payload);
  return payload;
}

export async function fetchEpisodes(animeUrl: string): Promise<EpisodesPayload> {
  // Re-clean the title on every return so entries cached by an older build (with
  // the "أنمي … مترجم" decoration) display cleanly too.
  const clean = (p: EpisodesPayload): EpisodesPayload => {
    if (p?.data) p.data.title = cleanAnimeTitle(p.data.title);
    return p;
  };
  const cached = await readCache<EpisodesPayload>(DETAIL_CACHE_PREFIX + animeUrl, DETAIL_CACHE_TTL);
  if (cached) { void fetchEpisodesFresh(animeUrl).catch(() => {}); return clean(cached); }
  return clean(await fetchEpisodesFresh(animeUrl));
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

// Dedup-by-title-key + stable fuzzy rerank for the multi-source search union.
// Each source pushes its raw cards in; snapshot() returns the reranked list.
//
// CROSS-SOURCE DEDUP: the three sources (witanime / anime4up / anime3rb) index
// the SAME anime under different hrefs (witanime.you/anime/X vs
// w1.anime4up.rest/anime/X vs anime3rb.com/titles/X), so deduping by href left
// the same anime on screen up to 3× — and the late-arriving witanime copy
// re-rendered with a fresh (slow) image load. animeTitleKey (the codebase's
// cross-source identity helper, already used by history) collapses them to one
// card. On collision the first-seen card wins (the fast phase paints first),
// but its image/title are upgraded when a later source offers a better one
// (anime3rb cards carry a lowercase slug-derived title + sitemap poster; a
// later witanime/anime4up card supplies the real mixed-case / Arabic title).
type SearchSeed = {
  title: string; href: string; image: string | null;
  type?: string | null; status?: string | null; synopsis?: string | null;
};
function makeSearchSink(query: string) {
  const merged: SearchResult[] = [];
  const seenHrefs = new Set<string>();
  const seenKeys = new Map<string, number>(); // titleKey → index in merged
  const push = (it: SearchSeed) => {
    if (!it.href || seenHrefs.has(it.href)) return;
    seenHrefs.add(it.href);
    const key = animeTitleKey(it.title) || it.href;
    const idx = seenKeys.get(key);
    if (idx !== undefined) {
      const cur = merged[idx];
      // Upgrade image only when the existing card has none — never swap a
      // loaded image for another (that re-triggers a slow fresh fetch).
      if (!cur.image && it.image) cur.image = imgOrEmpty(it.image);
      // Upgrade title when the existing one is a bare lowercase slug form
      // (anime3rb) and the new one is a richer real title (mixed-case/Arabic).
      if (isSlugTitle(cur.title) && !isSlugTitle(it.title) && it.title) {
        cur.title = it.title;
      }
      // Prefer a witanime/anime4up href over anime3rb: an anime3rb-primary
      // detail page returns ONLY anime3rb episodes, while a witanime/anime4up
      // primary page merges all three sources' episodes. So when a richer
      // source's card collides, point the surviving card at its href.
      if (hrefRank(it.href) < hrefRank(cur.href)) {
        cur.href = it.href;
        if (it.type && !cur.type) cur.type = it.type ?? undefined;
        if (it.status && !cur.status) cur.status = it.status ?? undefined;
      } else {
        if (it.type && !cur.type) cur.type = it.type ?? undefined;
        if (it.status && !cur.status) cur.status = it.status ?? undefined;
      }
      return;
    }
    seenKeys.set(key, merged.length);
    merged.push({
      title: it.title,
      href: it.href,
      image: imgOrEmpty(it.image),
      type: it.type ?? undefined,
      status: it.status ?? undefined,
      synopsis: it.synopsis ?? undefined,
    });
  };
  const snapshot = (): SearchResult[] => {
    const scored = merged.map((it, i) => ({ it, i, s: fuzzyScore(query, it.title) }));
    scored.sort((a, b) => (b.s - a.s) || (a.i - b.i));
    return scored.map((x) => x.it);
  };
  return { push, snapshot };
}

// A "slug title" is a lowercase ASCII-only string derived from a URL slug
// (anime3rb search cards build their title from the slug). Prefer a real
// title — one carrying uppercase or non-Latin characters — when a later
// source provides one, so the card reads "One Piece" not "one piece".
function isSlugTitle(s: string | null | undefined): boolean {
  if (!s) return false;
  return s === s.toLowerCase() && /^[a-z0-9 ]+$/.test(s);
}

// Detail-page richness ranking for a card's href. A witanime or anime4up
// primary href merges ALL three sources' episodes on the detail page; an
// anime3rb primary href returns only anime3rb episodes. Lower = richer.
function hrefRank(href: string): number {
  if (/anime3rb\.com/i.test(href)) return 3;
  if (/anime4up/i.test(href)) return 2;
  return 1; // witanime (or anything else) — richest merge
}

// witanime-primary progressive search. witanime is the authoritative source, so
// its results are shown FIRST and alone; anime4up + anime3rb are a FALLBACK that
// only surfaces titles witanime has nothing for. Two-stage witanime lookup keeps
// the common case fast: a direct static-HTML GET paints in well under a second,
// and the slow headless scrape (which overlaps in the background) fills anything
// the direct parse missed and recovers a Cloudflare block on the direct fetch.
export async function searchAnimeStream(
  query: string,
  onPartial?: (results: SearchResult[], phase: "fast" | "full") => void,
): Promise<SearchResult[]> {
  const sink = makeSearchSink(query);

  // Headless witanime overlaps the direct GET so we never serialize the two.
  const witHeadlessP = scrapeSearch(query).catch(() => ({ results: [] as SearchResult[] }));

  // PRIMARY, fast: witanime direct static search — paint the moment it lands.
  const witDirect = await searchWitanimeDirectList(query).catch(() => null);
  for (const it of witDirect || []) sink.push(it);
  if (sink.snapshot().length > 0) onPartial?.(sink.snapshot(), "fast");

  // Merge the headless witanime pass (fills gaps / recovers a blocked direct GET).
  const witH = await witHeadlessP;
  for (const it of witH.results || []) sink.push(it);

  // Cross-language bridge: witanime often indexes an anime ONLY under its romaji
  // name (King's Game → Ousama Game). Still on witanime, just under an alt title,
  // so try that BEFORE reaching for the other sources.
  if (sink.snapshot().length === 0) {
    const alts = await getAltTitles(query).catch(() => [] as string[]);
    for (const alt of alts.slice(0, 2)) {
      if (alt.toLowerCase().trim() === query.toLowerCase().trim()) continue;
      const [wd, wh] = await Promise.all([
        searchWitanimeDirectList(alt).catch(() => null),
        scrapeSearch(alt).catch(() => ({ results: [] as SearchResult[] })),
      ]);
      for (const it of wd || []) sink.push(it);
      for (const it of wh.results || []) sink.push(it);
      if (sink.snapshot().length > 0) break;
    }
  }

  // FALLBACK sources — anime4up + anime3rb — only when witanime (direct, headless,
  // and alt-title) found NOTHING for the query. This keeps witanime the primary
  // source and stops the looser anime3rb fuzzy match from polluting normal results.
  if (sink.snapshot().length === 0) {
    const up4 = await searchAnime4upDirectList(query).catch(() => null);
    for (const it of up4 || []) sink.push(it);
    const fuzzy = await searchAnime3rbCatalogFuzzy(query, 6)
      .catch(() => [] as { slug: string; score: number; poster: string }[]);
    for (const { slug, poster } of fuzzy) {
      sink.push({
        title: slug.replace(/[-_]+/g, " ").trim(),
        href: `https://anime3rb.com/titles/${slug}`,
        image: poster || "",
        type: undefined, status: undefined, synopsis: undefined,
      });
    }
  }

  const results = sink.snapshot();
  onPartial?.(results, "full");
  return results;
}

// Backwards-compatible single-payload wrapper. New callers should prefer
// searchAnimeStream for progressive results.
export async function searchAnime(query: string) {
  const results = await searchAnimeStream(query);
  return { success: true, data: { query, totalResults: results.length, results } };
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
  let primary: { source: "anime4up" | "witanime"; servers: any[]; episodeTitle: string; animeTitle: string; up4EpisodeUrl: string | null; direct?: boolean } | null = null;
  if (primaryIsUp4) {
    try {
      const direct = await scrapeAnime4upEpisodePageDirect(episodeUrl);
      if (direct) {
        console.info(`[servers] direct anime4up parse: ${direct.servers.length} servers`);
        primary = { source: "anime4up", servers: direct.servers, episodeTitle: direct.episodeTitle, animeTitle: direct.animeTitle, up4EpisodeUrl: null, direct: true };
      }
    } catch { /* fall through to headless */ }
  } else if (/witanime/i.test(episodeUrl)) {
    // Fast lane for witanime-primary episodes: witanime hides its server embeds
    // in an obfuscated _zX/_zK registry that only its gh100.js decodes on click.
    // The headless render depends on those clicks firing past witanime's
    // Cloudflare gate and frequently comes back empty — so decode the registry
    // straight from the static HTML. Falls back to headless when the direct
    // decode yields nothing (older pages that still ship plain iframes).
    try {
      const direct = await scrapeWitanimeEpisodePageDirect(episodeUrl);
      if (direct) {
        console.info(`[servers] direct witanime parse: ${direct.servers.length} servers`);
        primary = { source: "witanime", servers: direct.servers, episodeTitle: direct.episodeTitle, animeTitle: direct.animeTitle, up4EpisodeUrl: null, direct: true };
      }
    } catch { /* fall through to headless */ }
  }
  if (!primary) {
    primary = await scrapeVideoServers(episodeUrl).then((r) => ({ source: primaryIsUp4 ? "anime4up" as const : "witanime" as const, servers: r.servers, episodeTitle: r.episodeTitle, animeTitle: r.animeTitle, up4EpisodeUrl: r.up4EpisodeUrl ?? null })).catch(() => null);
  }
  const seen = new Set<string>();
  const merged: (VideoServer & { source?: string })[] = [];
  function add(arr: any[] | undefined, source: string, keepGeneric = false) {
    if (!arr) return;
    for (const s of arr) {
      if (!s.iframeUrl || seen.has(s.iframeUrl)) continue;
      // Drop unclassifiable "generic" servers from the HEADLESS witanime scrape —
      // they're the site's own placeholder player (junk). Keep anime4up's
      // generic-classified ones (their embed hosts often aren't in the provider
      // list but are real), and keep the DIRECT-decoded ones (keepGeneric): those
      // are validated real embeds, so a brand-new witanime host still plays via
      // the iframe fallback instead of silently vanishing.
      if (s.provider === "generic" && source !== "anime4up" && !keepGeneric) continue;
      seen.add(s.iframeUrl);
      merged.push({ id: String(merged.length), name: s.name, iframeUrl: s.iframeUrl, provider: s.provider, source });
    }
  }
  if (primary) add(primary.servers, primary.source, !!primary.direct);
  // A direct anime4up episode link harvested off the witanime page lets the
  // watch screen enrich anime4up servers immediately, skipping the slow
  // cross-source search. Prefer an explicit ?up4= but fall back to it.
  const harvestedUp4 = (!primaryIsUp4 && primary?.up4EpisodeUrl && /\/episode\/|الحلقة/i.test(primary.up4EpisodeUrl)) ? primary.up4EpisodeUrl : null;
  return { success: true, data: { episodeTitle: primary?.episodeTitle || "", animeTitle: primary?.animeTitle || "", animeHref: "", serverCount: merged.length, servers: merged, up4EpisodeUrl: harvestedUp4, navigation: { prev: null, next: null } } };
}

// ── definitive-negative memory ──
// A source can report a title/episode as *definitively* absent: the site was
// reachable, its content parsed, and the thing genuinely isn't there. That
// verdict won't change on a retry, so the watch screen's enrichment loops
// consult this to STOP retrying (the "resolving … (attempt 9)" storm). Beyond
// the console/request spam, the anime3rb retries re-probe slugs that tarpit the
// edge — a title with no anime3rb entry could blackhole the site for OTHER
// titles. Session-scoped only (not persisted): a newly-uploaded episode should
// re-check on the next app run, and a manual refresh clears it (see below).
const definitiveMiss = new Set<string>();
const missKey = (source: string, title: string, ep?: number) =>
  `${source}:${title.toLowerCase().trim()}${ep != null ? "#" + ep : ""}`;
export function isDefinitiveMiss(source: "anime4up" | "anime3rb", title: string, ep?: number): boolean {
  if (!title) return false;
  return definitiveMiss.has(missKey(source, title, ep));
}
// Drop a title's definitive-miss verdicts (both sources, any episode) so a
// manual "refresh servers" genuinely re-queries instead of short-circuiting.
export function clearDefinitiveMiss(title: string): void {
  if (!title) return;
  const suffix = `:${title.toLowerCase().trim()}`;
  for (const k of definitiveMiss) {
    const rest = k.slice(k.indexOf(":"));
    if (rest === suffix || rest.startsWith(suffix + "#")) definitiveMiss.delete(k);
  }
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
  let definitive = false;
  try {
    const r = await findUp4EpisodeAcrossPages(animeUrl, epNumber);
    url = r.url;
    definitive = r.definitive;
  } catch (e) { console.warn(`[up4-resolve] episode lookup threw:`, e); }
  if (url) console.info(`[up4-resolve] found ep ${epNumber}: ${url}`);
  else if (definitive) {
    definitiveMiss.add(missKey("anime4up", animeTitle, epNumber));
    console.warn(`[up4-resolve] ep ${epNumber} is definitively absent from anime4up — not retrying`);
  } else console.warn(`[up4-resolve] ep ${epNumber} not found on anime4up pages (transient)`);
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
// v2: bumped to discard slug mappings written by the pre-Roman-season build,
// which resolved later seasons ("Mushoku Tensei III") to season 1's page and
// re-wrote that wrong slug on every hit so it never aged out. A fresh key forces
// re-resolution with the season-aware logic (which correctly returns nothing
// when a later season isn't on anime3rb).
const A3RB_TITLE_PREFIX = "@a3rb_title_v2:";
// Titles whose Jikan alt-name bridge has already been attempted this session.
// The bridge hits Jikan + probes anime3rb with each alt name; a fundamental
// name mismatch won't change between the watch screen's retries, so run it at
// most once per title (the cheap catalog/slug probes still retry every call).
const a3rbBridgeTried = new Set<string>();

// Cache-only lookup of an anime's resolved anime3rb title URL — no network.
async function peekAnime3rbTitleUrl(animeTitle: string): Promise<string | null> {
  const key = animeTitle.toLowerCase().trim();
  const hit = a3rbTitleCache.get(key);
  if (hit && Date.now() - hit.ts < UP4_CACHE_TTL) return hit.url;
  const stored = await readCache<string>(A3RB_TITLE_PREFIX + key, UP4_CACHE_TTL);
  if (stored) { a3rbTitleCache.set(key, { url: stored, ts: Date.now() }); return stored; }
  return null;
}

// Persist a confirmed title URL so later episodes of the same anime are instant.
function rememberAnime3rbTitleUrl(animeTitle: string, url: string) {
  const key = animeTitle.toLowerCase().trim();
  a3rbTitleCache.set(key, { url, ts: Date.now() });
  void writeCache(A3RB_TITLE_PREFIX + key, url);
}

async function resolveAnime3rbTitleUrl(animeTitle: string): Promise<string | null> {
  if (!animeTitle) return null;
  const key = animeTitle.toLowerCase().trim();
  const cached = await peekAnime3rbTitleUrl(animeTitle);
  if (cached) return cached;
  // Catalog (sitemap) matching FIRST: one plain GET (cached 6h in memory)
  // plus one verification probe of a slug that's KNOWN to exist — both fast
  // 200s. On desktop the slug guess goes second (anime3rb's edge TARPITS
  // unknown /titles/<slug> paths rather than 404ing them, so a missed guess
  // burst can blackhole the site — the catalog avoids that).
  let url = await searchAnime3rbCatalog(animeTitle).catch(() => null);
  if (!url) {
    console.info(`[a3rb-resolve] catalog miss for "${animeTitle}", probing top slug guesses`);
    url = await searchAnime3rbDirect(animeTitle).catch(() => null);
  }
  if (!url && !a3rbBridgeTried.has(key)) {
    // Cross-language bridge — the main reason anime3rb "sometimes doesn't show".
    // witanime/anime4up may hand us an Arabic title, or a romanization anime3rb
    // doesn't index under (King's Game ↔ Ousama Game, Re:Zero ↔ rezero). Ask
    // Jikan for the anime's other names and retry the catalog + slug match with
    // each Latin one (anime3rb's slugs are Latin). getAltTitles caches its
    // result so retries are free.
    a3rbBridgeTried.add(key);
    // getAltTitles cleans the season off the query, so its names are the BASE
    // franchise names. Bridging them as-is for a later season would match the
    // WRONG season's page (numbering restarts), so detect the wanted season and
    // RE-ATTACH it for season >= 2 — the matchers' own season check keeps the
    // result locked to that season.
    // Pass the ORIGINAL-case title so Roman-numeral seasons ("Mushoku Tensei
    // III") are detected — the lowercased `key` would hide the uppercase-roman
    // discriminator that keeps a stray "v"/"x" from being read as a season.
    const seasonNum = tm_seasonNum(animeTitle);
    const alts = await getAltTitles(animeTitle).catch(() => [] as string[]);
    for (const alt of alts) {
      if (!/[a-z]/i.test(alt)) continue;            // need Latin script for the slug
      const altQ = seasonNum >= 2 ? `${alt} season ${seasonNum}` : alt;
      if (altQ.toLowerCase().trim() === key) continue; // already tried as the primary
      url =
        (await searchAnime3rbCatalog(altQ).catch(() => null)) ||
        (await searchAnime3rbDirect(altQ).catch(() => null));
      if (url) break;
    }
  }
  if (url) {
    console.info(`[a3rb-resolve] matched title page: ${url}`);
    rememberAnime3rbTitleUrl(animeTitle, url);
  } else {
    // Catalog + slug + Jikan alt-name bridge all exhausted with no match → the
    // title genuinely isn't on anime3rb this session. Mark it definitive so the
    // watch loop stops retrying AND later fetchAnime3rbServers calls skip the
    // slug probes that tarpit the edge. Only after the bridge ran, so a purely
    // transient catalog fetch failure (bridge not yet attempted) still retries.
    if (a3rbBridgeTried.has(key)) definitiveMiss.add(missKey("anime3rb", animeTitle));
    console.warn(`[a3rb-resolve] no anime3rb match for "${animeTitle}"`);
  }
  return url;
}

// Servers for an episode by anime title + episode number. Returns [] on any
// miss (unknown anime, episode not yet uploaded, transient fetch failure) —
// the watch screen's retry loop decides whether to try again.
// Built anime3rb server lists, keyed by `${titleKey}#${epNum}`. The playerUrl in
// each server carries a token (~expires), so the TTL is short. Re-opening an
// episode — or a PREFETCHED next episode while binge-watching — plays instantly.
const a3rbServersMem = new Map<string, { servers: RawServer[]; ts: number }>();
const A3RB_SERVERS_TTL = 12 * 60 * 1000;
function a3rbServersKey(animeTitle: string, epNumber: number) {
  return `${animeTitle.toLowerCase().trim()}#${epNumber}`;
}

// Warm the caches for an episode the user is LIKELY to watch next (called from
// the watch screen for epNum±1 while the current one plays). Fire-and-forget.
export function prefetchAnime3rbServers(animeTitle: string, epNumber: number): void {
  if (!animeTitle || epNumber == null || epNumber < 1) return;
  if (a3rbServersMem.has(a3rbServersKey(animeTitle, epNumber))) return;
  void fetchAnime3rbServers(animeTitle, epNumber).catch(() => {});
}

export async function fetchAnime3rbServers(animeTitle: string, epNumber: number): Promise<RawServer[]> {
  if (!animeTitle || epNumber == null) return [];
  const epUrlFor = (slug: string) => `https://anime3rb.com/episode/${slug}/${epNumber}`;
  const memKey = a3rbServersKey(animeTitle, epNumber);

  // 0) Already built (re-open or prefetch hit) — instant, no network.
  const mem = a3rbServersMem.get(memKey);
  if (mem && Date.now() - mem.ts < A3RB_SERVERS_TTL) return mem.servers;
  // Title already proven absent from anime3rb this session — skip the slug
  // probes (they tarpit the edge) entirely.
  if (isDefinitiveMiss("anime3rb", animeTitle)) return [];
  const remember = (servers: RawServer[]) => {
    if (servers.length) a3rbServersMem.set(memKey, { servers, ts: Date.now() });
    return servers;
  };

  // 1) Known slug (cache hit) — one episode-page fetch, straight to servers.
  const cachedTitle = await peekAnime3rbTitleUrl(animeTitle);
  if (cachedTitle) {
    const slug = cachedTitle.replace(/\/+$/, "").split("/").pop();
    if (slug) {
      const servers = await scrapeAnime3rbEpisodeServers(epUrlFor(slug)).catch(() => [] as RawServer[]);
      if (servers.length) return remember(servers);
      // Cached slug yielded nothing — fall through to the guess/resolve paths.
    }
  }

  // 2) Fast direct-slug path: try the EXACT slug guesses' episode URLs directly.
  // The episode page itself proves the slug, so this skips a separate title-page
  // fetch. ponytail: capped to the top 2 exact slugs — a miss on anime3rb
  // tarpits (~12s) rather than 404ing, so an uncapped guess chain could stall;
  // raise the cap if exact slugs routinely miss the correct anime.
  for (const slug of anime3rbExactSlugs(animeTitle).slice(0, 2)) {
    const servers = await scrapeAnime3rbEpisodeServers(epUrlFor(slug)).catch(() => [] as RawServer[]);
    if (servers.length) {
      rememberAnime3rbTitleUrl(animeTitle, `https://anime3rb.com/titles/${slug}`);
      return remember(servers);
    }
  }

  // 3) Full resolver (catalog sitemap + Jikan cross-language bridge) for anime
  // whose slug can't be guessed. Verifies the title page, then builds the URL.
  const titleUrl = await resolveAnime3rbTitleUrl(animeTitle);
  if (!titleUrl) return [];
  const slug = titleUrl.replace(/\/+$/, "").split("/").pop();
  if (!slug) return [];
  const servers = await scrapeAnime3rbEpisodeServers(epUrlFor(slug)).catch(() => [] as RawServer[]);
  if (servers.length > 0) console.info(`[a3rb-resolve] ep ${epNumber}: ${servers.length} server(s) from ${epUrlFor(slug)}`);
  return remember(servers);
}

// Servers for a KNOWN anime3rb episode URL (no title/number resolution needed).
// Used when an anime3rb episode is the primary source on the watch screen.
export async function fetchAnime3rbServersByUrl(episodeUrl: string): Promise<RawServer[]> {
  if (!episodeUrl) return [];
  return scrapeAnime3rbEpisodeServers(episodeUrl).catch(() => [] as RawServer[]);
}

// Public resolver for an anime's anime3rb /titles/<slug> page (or null).
export async function findAnime3rbAnimeUrl(animeTitle: string): Promise<string | null> {
  return resolveAnime3rbTitleUrl(animeTitle).catch(() => null);
}

// anime3rb's full episode list for an anime, for the detail page's cross-source
// union — so episodes missing from witanime/anime4up still appear (and stay
// playable, since each href is a real anime3rb episode URL). Cached 6h.
const A3RB_EPS_PREFIX = "@a3rb_eps_v2:"; // v2: discard episode lists keyed by pre-fix (wrong-season) title URLs
const A3RB_EPS_TTL = 6 * 60 * 60 * 1000;
export async function fetchAnime3rbEpisodes(animeTitle: string): Promise<Episode[]> {
  if (!animeTitle || !animeTitle.trim()) return [];
  const titleUrl = await resolveAnime3rbTitleUrl(animeTitle);
  if (!titleUrl) return [];
  const cacheKey = A3RB_EPS_PREFIX + titleUrl;
  const cached = await readCache<Episode[]>(cacheKey, A3RB_EPS_TTL);
  if (cached) return cached;
  const detail = await scrapeAnime3rbTitlePage(titleUrl).catch(() => null);
  const eps: Episode[] = (detail?.episodes || []).map((e) => ({
    title: e.title, number: e.number, type: e.type, screenshot: e.screenshot, href: e.href,
  }));
  if (eps.length > 0) void writeCache(cacheKey, eps);
  return eps;
}

/* ── downloads ──────────────────────────────────
 * Resolve a DIRECT, progressive .mp4 URL for an episode so it can be saved to
 * disk for offline viewing. HLS (.m3u8) sources are skipped (a playlist, not a
 * single file), so only providers proven to hand out a progressive .mp4 are
 * considered: vid3rb (anime3rb's first-party host, direct 1080p) first, then
 * mp4upload. The main process performs the actual file download and forces the
 * per-provider Referer the CDN's signed URL needs. */
const DL_RANK: Record<string, number> = { vid3rb: 0, mp4upload: 1 };

function dlQualityScore(name: string): number {
  const n = (name || "").toLowerCase();
  if (n.includes("fhd") || n.includes("1080")) return 3;
  if (n.includes("hd") || n.includes("720")) return 2;
  if (n.includes("sd") || n.includes("480") || n.includes("360")) return 0;
  return 1;
}

export async function resolveDownloadUrl(opts: {
  episodeHref: string;
  url4up?: string;
  epNum?: number | null;
  animeTitle?: string | null;
}): Promise<{ url: string; provider: string } | null> {
  const { episodeHref, url4up, epNum, animeTitle } = opts;
  const cands: { name: string; iframeUrl: string; provider: string }[] = [];

  // anime3rb (vid3rb → direct 1080p .mp4) — the best download source.
  try {
    if (animeTitle && epNum != null) {
      const a3 = await fetchAnime3rbServers(animeTitle, epNum);
      for (const s of a3) cands.push({ name: s.name, iframeUrl: s.iframeUrl, provider: s.provider });
    }
  } catch {}

  // Primary (witanime/anime4up) — for the mp4upload server.
  try {
    const res = await fetchVideoServers(episodeHref, url4up);
    if (res?.success) for (const s of res.data.servers) cands.push({ name: s.name, iframeUrl: s.iframeUrl, provider: s.provider });
  } catch {}

  const downloadable = cands
    .filter((c) => c.provider in DL_RANK && c.iframeUrl)
    .sort((a, b) => (DL_RANK[a.provider] - DL_RANK[b.provider]) || (dlQualityScore(b.name) - dlQualityScore(a.name)));

  for (const c of downloadable) {
    const r = await resolveVideo(c.iframeUrl, c.provider).catch(() => null);
    if (r && r.success) {
      const { videoUrl, type } = r.data;
      if (videoUrl && type !== "hls" && !/\.m3u8(\?|$)/i.test(videoUrl)) {
        return { url: videoUrl, provider: c.provider };
      }
    }
  }
  return null;
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
