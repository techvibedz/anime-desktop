// Manga → anime (the reverse bridge): "this manga has an anime adaptation".
//
// AniList maps the manga to its anime adaptations; community/AI bridge rows
// (manga_bridge, keyed by the anime season) add "covers up to chapter N" for
// seasons someone already looked at. Cards open through the AniList →
// source resolution, like every other AniList poster in the app.

import { storage as AsyncStorage } from "./storage";
import { anilistPost } from "./malInfo";
import { supabase } from "./supabase";

export interface AnimeAdaptation {
  anilistId: number;
  title: string;
  titleEnglish: string | null;
  image: string | null;
  format: string | null;
  year: number | null;
  episodes: number | null;
  /** Last manga chapter this season covers, when a bridge row knows it. */
  endChapter: number | null;
}

const QUERY = `query($s:String){Page(perPage:4){media(search:$s,type:MANGA,sort:SEARCH_MATCH){
  id title{romaji english native} synonyms
  relations{edges{relationType(version:2) node{id type format status episodes seasonYear title{romaji english} coverImage{large}}}}
}}}`;

const CACHE_PREFIX = "@manga_adapt_v1:";
const CACHE_TTL = 5 * 24 * 60 * 60 * 1000;
const ANIME_FORMATS = new Set(["TV", "TV_SHORT", "MOVIE", "ONA", "OVA"]);

function norm(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "");
}

export async function findAnimeAdaptations(mangaTitle: string): Promise<AnimeAdaptation[]> {
  const q = (mangaTitle || "").trim();
  // AniList search needs a Latin title; Arabic-only titles can't be matched reliably.
  if (q.length < 2 || !/[a-z]/i.test(q)) return [];
  const key = CACHE_PREFIX + norm(q);
  try {
    const raw = await AsyncStorage.getItem(key);
    if (raw) {
      const c = JSON.parse(raw) as { at: number; items: AnimeAdaptation[] };
      if (Date.now() - c.at < CACHE_TTL) return c.items;
    }
  } catch {}

  try {
    const j = await anilistPost(QUERY, { s: q });
    if (!j) return [];
    const list: any[] = j?.data?.Page?.media ?? [];
    const want = norm(q);
    // Exact-ish title match only — a wrong manga would advertise a wrong anime.
    const manga = list.find((m) =>
      [m?.title?.romaji, m?.title?.english, ...(Array.isArray(m?.synonyms) ? m.synonyms : [])]
        .some((t: unknown) => typeof t === "string" && norm(t) === want),
    );
    if (!manga) {
      AsyncStorage.setItem(key, JSON.stringify({ at: Date.now(), items: [] })).catch(() => {});
      return [];
    }
    const seen = new Set<number>();
    const items: AnimeAdaptation[] = [];
    for (const e of manga.relations?.edges ?? []) {
      const n = e?.node;
      if (!n || n.type !== "ANIME" || e.relationType !== "ADAPTATION" || !ANIME_FORMATS.has(n.format) || seen.has(n.id)) continue;
      seen.add(n.id);
      items.push({
        anilistId: n.id,
        title: n.title?.romaji || n.title?.english || "",
        titleEnglish: n.title?.english ?? null,
        image: n.coverImage?.large ?? null,
        format: n.format ?? null,
        year: n.seasonYear ?? null,
        episodes: n.episodes ?? null,
        endChapter: null,
      });
    }
    items.sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999));

    // Fill "up to chapter N" from bridge rows other users already produced.
    if (items.length) {
      try {
        const { data } = await supabase
          .from("manga_bridge")
          .select("payload")
          .eq("payload->>anilistMangaId", String(manga.id))
          .limit(20);
        for (const row of (data ?? []) as { payload?: { anilistAnimeId?: number; endChapter?: number | null } }[]) {
          const it = items.find((i) => i.anilistId === row.payload?.anilistAnimeId);
          if (it && row.payload?.endChapter) it.endChapter = row.payload.endChapter;
        }
      } catch {}
    }
    AsyncStorage.setItem(key, JSON.stringify({ at: Date.now(), items })).catch(() => {});
    return items;
  } catch {
    return [];
  }
}
