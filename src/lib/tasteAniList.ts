// AniList GraphQL for the taste engine — pure query builders + parsers
// (no RN imports, so they're testable and reusable by the desktop app).

import type { TasteMedia } from "./tasteCore";

export const TASTE_MEDIA_FIELDS =
  "id isAdult title{romaji english native} synonyms coverImage{large} format episodes status averageScore popularity seasonYear genres tags{name rank isMediaSpoiler isAdult} studios(isMain:true){nodes{name}} relations{edges{relationType(version:2) node{id type}}}";

/** Resolve up to N titles in ONE request (aliases m0..mN, 3 candidates each). */
export function buildResolveQuery(titles: string[]): { query: string; variables: Record<string, string> } {
  const variables: Record<string, string> = {};
  const defs: string[] = [];
  const parts: string[] = [];
  titles.forEach((t, i) => {
    variables[`q${i}`] = t;
    defs.push(`$q${i}:String`);
    parts.push(`m${i}:Page(perPage:3){media(search:$q${i},type:ANIME,sort:SEARCH_MATCH){${TASTE_MEDIA_FIELDS}}}`);
  });
  return { query: `query(${defs.join(",")}){${parts.join(" ")}}`, variables };
}

/** Full media for a list of ids (≤50). */
export const MEDIA_BY_IDS_QUERY = `query($ids:[Int]){Page(perPage:50){media(id_in:$ids,type:ANIME){${TASTE_MEDIA_FIELDS}}}}`;

/** Community recommendations of several seeds at once. */
export const SEED_RECS_QUERY =
  "query($ids:[Int]){Page(perPage:12){media(id_in:$ids,type:ANIME){id recommendations(sort:RATING_DESC,perPage:15){nodes{rating mediaRecommendation{id type isAdult}}}}}}";

/** Discovery: acclaimed shows in a genre / with a theme the user loves. */
export const DISCOVER_QUERY = `query($genres:[String],$tags:[String],$page:Int){Page(page:$page,perPage:40){media(type:ANIME,isAdult:false,genre_in:$genres,tag_in:$tags,sort:[SCORE_DESC],popularity_greater:15000,format_in:[TV,MOVIE,ONA,TV_SHORT],status_in:[FINISHED,RELEASING]){${TASTE_MEDIA_FIELDS}}}}`;

export interface RawTitleMedia {
  id: number;
  title?: { romaji?: string | null; english?: string | null; native?: string | null } | null;
  synonyms?: string[] | null;
  type?: string | null;
}

export function parseTasteMedia(raw: any): TasteMedia | null {
  if (!raw || typeof raw.id !== "number") return null;
  const title = raw.title?.romaji || raw.title?.english;
  if (!title) return null;
  return {
    id: raw.id,
    title,
    titleEnglish: raw.title?.english ?? null,
    image: raw.coverImage?.large ?? null,
    format: raw.format ?? null,
    episodes: typeof raw.episodes === "number" ? raw.episodes : null,
    status: raw.status ?? null,
    averageScore: typeof raw.averageScore === "number" ? raw.averageScore : null,
    popularity: typeof raw.popularity === "number" ? raw.popularity : null,
    seasonYear: typeof raw.seasonYear === "number" ? raw.seasonYear : null,
    genres: Array.isArray(raw.genres) ? raw.genres.filter((g: unknown): g is string => typeof g === "string") : [],
    tags: Array.isArray(raw.tags)
      ? raw.tags
          .filter((t: any) => t && typeof t.name === "string" && !t.isMediaSpoiler && !t.isAdult)
          .map((t: any) => ({ name: t.name as string, rank: typeof t.rank === "number" ? t.rank : 0 }))
      : [],
    studios: Array.isArray(raw.studios?.nodes)
      ? raw.studios.nodes.map((s: any) => s?.name).filter((s: unknown): s is string => typeof s === "string")
      : [],
    isAdult: !!raw.isAdult,
    prequelIds: Array.isArray(raw.relations?.edges)
      ? raw.relations.edges
          .filter((e: any) => (e?.relationType === "PREQUEL" || e?.relationType === "PARENT") && e?.node?.type === "ANIME" && typeof e.node.id === "number")
          .map((e: any) => e.node.id as number)
      : [],
  };
}

/** Seed id → [{candidateId, rating}] from a SEED_RECS_QUERY response. */
export function parseSeedRecs(json: any): Map<number, { id: number; rating: number }[]> {
  const out = new Map<number, { id: number; rating: number }[]>();
  for (const m of json?.data?.Page?.media ?? []) {
    if (!m || typeof m.id !== "number") continue;
    const recs: { id: number; rating: number }[] = [];
    for (const n of m.recommendations?.nodes ?? []) {
      const r = n?.mediaRecommendation;
      if (!r || r.type !== "ANIME" || r.isAdult || typeof r.id !== "number") continue;
      recs.push({ id: r.id, rating: typeof n.rating === "number" ? n.rating : 0 });
    }
    out.set(m.id, recs);
  }
  return out;
}

const ROMAN_UNI: Record<string, string> = {
  "Ⅰ": "I", "Ⅱ": "II", "Ⅲ": "III", "Ⅳ": "IV", "Ⅴ": "V", "Ⅵ": "VI", "Ⅶ": "VII", "Ⅷ": "VIII", "Ⅸ": "IX", "Ⅹ": "X",
  "ⅰ": "I", "ⅱ": "II", "ⅲ": "III", "ⅳ": "IV", "ⅴ": "V",
};

/**
 * Clean a source title for AniList search: Unicode roman numerals → ASCII
 * ("Mushoku Tensei Ⅲ"), source decoration around movies ("X Movie 3: Y" →
 * "X: Y", "X Movie: Y" → "X Y"), Arabic episode labels and stray brackets.
 */
export function cleanSearchTitle(raw: string): string {
  return (raw || "")
    .replace(/[Ⅰ-ↈ]/g, (c) => ROMAN_UNI[c] ?? c)
    .replace(/\s*الحلقة\s*\d+.*$/, "")
    .replace(/\s+Movie\s*\d*\s*:/i, ":")
    .replace(/\s+(?:the\s+)?movie\s*\d*/i, "")
    .replace(/[\[\]【】]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
