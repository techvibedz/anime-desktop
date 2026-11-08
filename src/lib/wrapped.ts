// Pantoufa Wrapped — data gathering, genre enrichment and publishing.
// Pure stats live in lib/wrappedCore.ts.

import { animeTitleKey, getHistory, normAnimeKey, type WatchEntry } from "./history";
import { countCompletedAnime } from "./completion";
import { getContinueReading, getReadChapters } from "./manga/store";
import { anilistPost } from "./malInfo";
import { isSupabaseConfigured, supabase } from "./supabase";
import { computeWrapped, topGenres, type PersonalityId, type WrappedStats } from "./wrappedCore";

export * from "./wrappedCore";

export const WRAPPED_WEB_BASE = "https://pantoufa-join.pages.dev/w/";

/**
 * The year's full history from the cloud. Local history keeps only the last
 * 200 episodes (and a reinstall starts empty); the account keeps everything.
 */
async function fetchCloudYear(year: number): Promise<WatchEntry[]> {
  if (!isSupabaseConfigured) return [];
  try {
    const { data: s } = await supabase.auth.getSession();
    const uid = s?.session?.user?.id;
    if (!uid) return [];
    const from = new Date(Date.UTC(year, 0, 1) - 14 * 3600_000).toISOString();
    const to = new Date(Date.UTC(year + 1, 0, 1) + 14 * 3600_000).toISOString();
    const out: WatchEntry[] = [];
    for (let page = 0; page < 6; page++) {
      const { data, error } = await supabase
        .from("watch_history")
        .select("episode_href,episode_title,anime_title,anime_href,image,position_ms,duration_ms,updated_at,completed")
        .eq("user_id", uid)
        .gte("updated_at", from)
        .lt("updated_at", to)
        .order("updated_at", { ascending: false })
        .range(page * 1000, page * 1000 + 999);
      if (error || !data) break;
      for (const row of data as Record<string, any>[]) {
        out.push({
          episodeHref: row.episode_href,
          episodeTitle: row.episode_title || "",
          animeTitle: row.anime_title || "",
          animeHref: row.anime_href || "",
          image: row.image || "",
          positionMs: row.position_ms || 0,
          durationMs: row.duration_ms || 0,
          updatedAt: new Date(row.updated_at).getTime(),
          completed: !!row.completed,
        });
      }
      if (data.length < 1000) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** Local ∪ cloud, one row per episode href (newest copy wins). */
function mergeEntries(local: WatchEntry[], cloud: WatchEntry[]): WatchEntry[] {
  const byHref = new Map<string, WatchEntry>();
  for (const e of [...cloud, ...local]) {
    if (!e?.episodeHref) continue;
    const cur = byHref.get(e.episodeHref);
    if (!cur || e.updatedAt >= cur.updatedAt) byHref.set(e.episodeHref, e);
  }
  return [...byHref.values()];
}

export async function loadWrapped(year = new Date().getFullYear()): Promise<WrappedStats> {
  const [local, cloud, completed, manga] = await Promise.all([
    getHistory().catch(() => [] as WatchEntry[]),
    fetchCloudYear(year),
    countCompletedAnime().catch(() => 0),
    getContinueReading(1000).catch(() => []),
  ]);
  let mangaChapters = 0;
  let mangaTitles = 0;
  for (const m of manga) {
    if (new Date(m.updatedAt).getFullYear() !== year) continue;
    mangaTitles += 1;
    mangaChapters += (await getReadChapters(m.source, m.id).catch(() => [])).length;
  }
  const history = mergeEntries(local, cloud);
  return computeWrapped(
    history.map((e) => ({
      animeKey: animeTitleKey(e.animeTitle) || normAnimeKey(e.animeHref),
      animeTitle: e.animeTitle,
      animeHref: e.animeHref,
      image: e.image,
      episodeHref: e.episodeHref,
      positionMs: e.positionMs,
      durationMs: e.durationMs,
      updatedAt: e.updatedAt,
      completed: e.completed,
    })),
    {
      year,
      tzOffsetMin: new Date().getTimezoneOffset(),
      completedAnime: completed,
      mangaTitles,
      mangaChapters,
    },
  );
}

/** Genres of the top anime (one batched AniList request), most-watched first. */
export async function fetchTopGenres(stats: WrappedStats): Promise<string[]> {
  const titles = stats.top.map((a) => a.title).filter(Boolean).slice(0, 5);
  if (!titles.length) return [];
  const defs = titles.map((_, i) => `$q${i}:String`).join(",");
  const parts = titles
    .map((_, i) => `m${i}:Page(perPage:1){media(search:$q${i},type:ANIME,sort:SEARCH_MATCH){genres}}`)
    .join(" ");
  const variables = Object.fromEntries(titles.map((t, i) => [`q${i}`, t]));
  try {
    const j = await anilistPost(`query(${defs}){${parts}}`, variables);
    if (!j) return [];
    const map = new Map<string, string[]>();
    titles.forEach((t, i) => {
      const g = j?.data?.[`m${i}`]?.media?.[0]?.genres;
      if (Array.isArray(g)) map.set(t, g.filter((x: unknown): x is string => typeof x === "string"));
    });
    return topGenres(map, stats.top, 3);
  } catch {
    return [];
  }
}

/** Arabic labels for AniList genres shown on the card. */
export const GENRE_AR: Record<string, string> = {
  Action: "أكشن", Adventure: "مغامرة", Comedy: "كوميدي", Drama: "دراما", Ecchi: "إيتشي", Fantasy: "خيال",
  Horror: "رعب", "Mahou Shoujo": "فتيات سحريات", Mecha: "ميكا", Music: "موسيقى", Mystery: "غموض",
  Psychological: "نفسي", Romance: "رومانسي", "Sci-Fi": "خيال علمي", "Slice of Life": "حياة يومية",
  Sports: "رياضي", Supernatural: "خارق", Thriller: "إثارة",
};

export interface WrappedPublicPayload {
  v: 1;
  name: string;
  year: number;
  minutes: number;
  episodes: number;
  animeCount: number;
  completedAnime: number;
  longestStreak: number;
  bestDay: { date: string; episodes: number } | null;
  nightPct: number;
  personality: PersonalityId;
  genres: string[];
  months: number[];
  mangaChapters: number;
  top: { title: string; image: string; episodes: number }[];
}

export function toPublicPayload(stats: WrappedStats, name: string, genres: string[]): WrappedPublicPayload {
  return {
    v: 1,
    name: name.slice(0, 40),
    year: stats.year,
    minutes: stats.minutes,
    episodes: stats.episodes,
    animeCount: stats.animeCount,
    completedAnime: stats.completedAnime,
    longestStreak: stats.longestStreak,
    bestDay: stats.bestDay,
    nightPct: stats.nightPct,
    personality: stats.personality,
    genres: genres.slice(0, 3),
    months: stats.months,
    mangaChapters: stats.mangaChapters,
    top: stats.top.slice(0, 5).map((a) => ({
      title: a.title.slice(0, 120),
      image: /^https:\/\//.test(a.image) ? a.image.slice(0, 500) : "",
      episodes: a.episodes,
    })),
  };
}

/** Publish (or update) this year's public card; returns the share URL. */
export async function publishWrapped(payload: WrappedPublicPayload): Promise<string | null> {
  if (!isSupabaseConfigured) return null;
  try {
    const { data, error } = await supabase.rpc("publish_wrapped", { p_year: payload.year, p_payload: payload });
    if (error || typeof data !== "string") return null;
    return WRAPPED_WEB_BASE + data;
  } catch {
    return null;
  }
}
