// Pure helpers for the AI ("describe what you want") search. No RN imports.

/** Normalized cache key for a query. */
export function aiQueryKey(q: string): string {
  return (q || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[ً-ٕـ]/g, "")
    .replace(/[إأآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[\s؟?!.،,:;"'«»()\[\]{}\-_/\\]+/g, " ")
    .trim()
    .slice(0, 300);
}

const MEDIA_FIELDS = "id title{romaji english} coverImage{large} format seasonYear averageScore episodes";

/** One GraphQL request that looks up every suggested title at once (aliases m0..mN). */
export function buildAniListBatch(titles: string[]): { query: string; variables: Record<string, string> } {
  const vars: Record<string, string> = {};
  const defs: string[] = [];
  const parts: string[] = [];
  titles.forEach((title, i) => {
    vars[`q${i}`] = title;
    defs.push(`$q${i}:String`);
    parts.push(`m${i}:Page(perPage:1){media(search:$q${i},type:ANIME,sort:SEARCH_MATCH,isAdult:false){${MEDIA_FIELDS}}}`);
  });
  return { query: `query(${defs.join(",")}){${parts.join(" ")}}`, variables: vars };
}

export interface AiSearchEntry {
  anilistId: number;
  title: string;
  titleEnglish: string | null;
  image: string | null;
  format: string | null;
  year: number | null;
  score: number | null;
  episodes: number | null;
  reason: string;
}

/** Map the batch response back onto the AI's ordered suggestions (deduped by id). */
export function parseAniListBatch(
  data: unknown,
  suggestions: { title: string; reason: string }[],
): AiSearchEntry[] {
  const out: AiSearchEntry[] = [];
  const seen = new Set<number>();
  const root = (data as { data?: Record<string, unknown> })?.data ?? {};
  suggestions.forEach((s, i) => {
    const page = root[`m${i}`] as { media?: unknown[] } | undefined;
    const m = (page?.media?.[0] ?? null) as Record<string, any> | null;
    if (!m || typeof m.id !== "number" || seen.has(m.id)) return;
    seen.add(m.id);
    const romaji = typeof m.title?.romaji === "string" ? m.title.romaji : "";
    const english = typeof m.title?.english === "string" ? m.title.english : null;
    out.push({
      anilistId: m.id,
      title: romaji || english || s.title,
      titleEnglish: english,
      image: typeof m.coverImage?.large === "string" ? m.coverImage.large : null,
      format: typeof m.format === "string" ? m.format : null,
      year: typeof m.seasonYear === "number" ? m.seasonYear : null,
      score: typeof m.averageScore === "number" ? m.averageScore : null,
      episodes: typeof m.episodes === "number" ? m.episodes : null,
      reason: s.reason,
    });
  });
  return out;
}
