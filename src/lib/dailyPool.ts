// The "أنمي اليوم" pool: an all-time best-of list from AniList — finished,
// highly rated, widely watched Japanese TV series and films, first entries only
// (a sequel is a poor "watch this today" suggestion). ~150 titles, so with the
// no-repeat daily order in lib/dailyPick a title comes back only after ~5
// months. Fetched once and cached for 30 days: the list barely moves, and the
// card must never wait on AniList after the first run. Ported from mobile
// (lib/dailyPool.ts) so both apps name the same anime on the same day.

import { storage as AsyncStorage } from "./storage";

export interface DailyAnime {
  id: number;
  title: string;              // romaji preferred (searchable on the sources)
  titleEnglish: string | null;
  image: string | null;
  format: string | null;
  /** AniList average score, 0–100. */
  score: number | null;
  episodes: number | null;
  genres: string[];
}

const ANILIST_URL = "https://graphql.anilist.co";
const CACHE_KEY = "@daily_pool_v1";
const TTL = 30 * 24 * 60 * 60 * 1000;
const PAGES = 6; // 6 × 50 by score → ~145 first entries after the sequel filter

const QUERY = `query ($page: Int) {
  Page(page: $page, perPage: 50) {
    pageInfo { hasNextPage }
    media(type: ANIME, sort: SCORE_DESC, isAdult: false, status: FINISHED,
          format_in: [TV, MOVIE], averageScore_greater: 76, popularity_greater: 60000,
          countryOfOrigin: "JP") {
      id
      title { romaji english }
      coverImage { extraLarge large }
      format
      averageScore
      episodes
      genres
      isAdult
      relations { edges { relationType node { type } } }
    }
  }
}`;

/** Sequels/side entries have an anime PREQUEL; adult entries never qualify. */
export function isDailyStarter(m: any): boolean {
  if (!m || m.isAdult || typeof m.id !== "number") return false;
  if (Array.isArray(m.genres) && m.genres.includes("Hentai")) return false;
  if (!(m.title?.romaji || m.title?.english)) return false;
  return !(m.relations?.edges || []).some(
    (e: any) => e?.relationType === "PREQUEL" && e?.node?.type === "ANIME",
  );
}

function toDailyAnime(m: any): DailyAnime {
  return {
    id: m.id,
    title: (m.title?.romaji || m.title?.english || "").trim(),
    titleEnglish: m.title?.english || null,
    image: m.coverImage?.extraLarge || m.coverImage?.large || null,
    format: m.format || null,
    score: typeof m.averageScore === "number" ? m.averageScore : null,
    episodes: typeof m.episodes === "number" ? m.episodes : null,
    genres: Array.isArray(m.genres) ? m.genres : [],
  };
}

async function fetchPoolFresh(): Promise<DailyAnime[]> {
  const out: DailyAnime[] = [];
  const seen = new Set<number>();
  for (let page = 1; page <= PAGES; page++) {
    // Main-process fetch: no CORS from the app origin and it rides the DoH
    // resolver (AniList can be DNS-blocked on some networks).
    const raw = await window.pantoufa.fetchJson({
      url: ANILIST_URL,
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query: QUERY, variables: { page } }),
    }).catch(() => null);
    if (!raw) break;
    let p: any = null;
    try { p = JSON.parse(raw)?.data?.Page; } catch {}
    for (const m of p?.media || []) {
      if (!isDailyStarter(m) || seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(toDailyAnime(m));
    }
    if (!p?.pageInfo?.hasNextPage) break;
  }
  // Stable order (by id) so the day → title mapping only depends on the pool.
  return out.sort((a, b) => a.id - b.id);
}

let mem: DailyAnime[] | null = null;
let inflight: Promise<DailyAnime[]> | null = null;

/** The pool, cache-first. A stale cache is still returned when the refresh
 *  fails, so the card keeps working offline. Never throws. */
export function getDailyPool(): Promise<DailyAnime[]> {
  if (mem) return Promise.resolve(mem);
  if (inflight) return inflight;
  inflight = (async () => {
    let stale: DailyAnime[] | null = null;
    try {
      const raw = await AsyncStorage.getItem(CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { ts: number; data: DailyAnime[] };
        if (Array.isArray(parsed?.data) && parsed.data.length > 0) {
          if (Date.now() - parsed.ts < TTL) return (mem = parsed.data);
          stale = parsed.data;
        }
      }
    } catch {}
    const fresh = await fetchPoolFresh().catch(() => [] as DailyAnime[]);
    // A partial fetch (rate limit mid-way) would reshuffle every day's pick —
    // only replace the cache with a reasonably complete list.
    if (fresh.length >= 60) {
      AsyncStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data: fresh })).catch(() => {});
      return (mem = fresh);
    }
    return (mem = stale ?? fresh);
  })().finally(() => { inflight = null; });
  return inflight;
}
