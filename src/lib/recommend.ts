// Pure logic for the home "مقترح لك" (For You) rail — no UI so it stays
// testable with plain tsx, ported from the mobile app (lib/recommend.ts).
//
// Three pure jobs:
//   1) pickSeeds()      — collapse watch history to the N distinct, most
//      recently watched anime that seed the recommendation lookups.
//   2) parseRecommendations() — shape raw AniList recommendation nodes into
//      RecItems (anime only, deduped, best rating wins).
//   3) rankRecommendations()  — merge the per-seed batches, sum community
//      upvotes across seeds, drop anything the caller says is already watched,
//      and return the ranked top N.
//
// The network side (resolving a scraped title to AniList, fetching + caching
// recommendations) lives in lib/malInfo.ts, re-exported here plus a fetchForYou
// wrapper that runs the whole seed → fetch → rank pipeline.

import { FORMAT_AR } from "./relations";
import { fetchAnimeRecommendations } from "./malInfo";

export { fetchAnimeRecommendations };

/** One recommended anime, post-parse — ready for the rail UI. */
export interface RecItem {
  anilistId: number;
  title: string;              // romaji preferred
  titleEnglish: string | null;
  image: string | null;
  format: string | null;      // Arabic label (FORMAT_AR)
  seasonYear: number | null;
  rating: number;             // AniList community upvotes
}

export interface RankedRec extends RecItem {
  /** Summed rating across every seed that recommended this item. */
  score: number;
}

/** The minimal shape pickSeeds reads from a watch-history entry. */
export interface RecSeedSource {
  animeTitle: string;
  animeHref: string;
}

export interface RecSeed {
  animeTitle: string;
  animeHref: string;
}

/**
 * Collapse watch history to distinct anime seeds, newest first.
 * `history` is expected newest-first (getHistory() sorts by updatedAt desc);
 * `keyOf` supplies the per-anime identity — callers pass the same
 * normAnimeKey/animeTitleKey identity used elsewhere so one anime watched on
 * two sources seeds once. Entries with no usable title are skipped.
 */
export function pickSeeds(
  history: readonly RecSeedSource[],
  keyOf: (entry: RecSeedSource) => string,
  cap = 3,
): RecSeed[] {
  const seen = new Set<string>();
  const out: RecSeed[] = [];
  for (const entry of history) {
    if (out.length >= cap) break;
    if (!entry || !entry.animeTitle || !entry.animeTitle.trim()) continue;
    const key = keyOf(entry) || entry.animeTitle.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ animeTitle: entry.animeTitle, animeHref: entry.animeHref });
  }
  return out;
}

/* ── AniList response parsing (the subset we read) ── */

interface RawRecNode {
  rating?: number | null;
  mediaRecommendation?: {
    id?: number | null;
    type?: string | null;
    format?: string | null;
    seasonYear?: number | null;
    title?: { romaji?: string | null; english?: string | null } | null;
    coverImage?: { large?: string | null } | null;
  } | null;
}

/** Map AniList `recommendations.nodes` into RecItems: anime only, title
 *  required, deduped by id (highest rating wins), highest rating first. */
export function parseRecommendations(nodes: unknown): RecItem[] {
  if (!Array.isArray(nodes)) return [];
  const byId = new Map<number, RecItem>();
  for (const raw of nodes as RawRecNode[]) {
    const m = raw?.mediaRecommendation;
    if (!m || m.type !== "ANIME" || m.id == null) continue;
    const title = m.title?.romaji || m.title?.english;
    if (!title) continue;
    const rating = typeof raw.rating === "number" ? raw.rating : 0;
    const existing = byId.get(m.id);
    if (existing) {
      if (rating > existing.rating) existing.rating = rating;
      continue;
    }
    byId.set(m.id, {
      anilistId: m.id,
      title,
      titleEnglish: m.title?.english || null,
      image: m.coverImage?.large || null,
      format: m.format ? FORMAT_AR[m.format] || m.format : null,
      seasonYear: typeof m.seasonYear === "number" ? m.seasonYear : null,
      rating,
    });
  }
  return [...byId.values()].sort((a, b) => b.rating - a.rating);
}

/**
 * Merge per-seed recommendation batches and rank them. Items recommended by
 * several seeds accumulate their ratings (a title multiple of your anime point
 * to is a stronger signal). `excluded` filters out anything already watched or
 * listed; equal scores break by newer year so the rail feels current.
 */
export function rankRecommendations(
  batches: readonly (readonly RecItem[])[],
  opts: { excluded?: (item: RecItem) => boolean; cap?: number } = {},
): RankedRec[] {
  const cap = opts.cap ?? 15;
  const merged = new Map<number, RankedRec>();
  for (const batch of batches) {
    for (const item of batch) {
      if (!item || item.anilistId == null) continue;
      const cur = merged.get(item.anilistId);
      if (cur) {
        cur.score += item.rating;
        continue;
      }
      merged.set(item.anilistId, { ...item, score: item.rating });
    }
  }
  return [...merged.values()]
    .filter((item) => !opts.excluded?.(item))
    .sort((a, b) => b.score - a.score || (b.seasonYear ?? 0) - (a.seasonYear ?? 0))
    .slice(0, cap);
}

/**
 * Full rail pipeline: collapse history to seeds, fetch each seed's AniList
 * recommendations concurrently, merge + rank with exclusions. Returns [] when
 * there are no usable seeds or every lookup misses.
 */
export async function fetchForYou(
  history: readonly RecSeedSource[],
  keyOf: (entry: RecSeedSource) => string,
  opts: { excluded?: (item: RecItem) => boolean; cap?: number; seeds?: number } = {},
): Promise<RankedRec[]> {
  const seeds = pickSeeds(history, keyOf, opts.seeds ?? 3);
  if (seeds.length === 0) return [];
  const batches = await Promise.all(
    seeds.map((s) => fetchAnimeRecommendations(s.animeTitle, s.animeHref).catch(() => [] as RecItem[])),
  );
  return rankRecommendations(batches, { excluded: opts.excluded, cap: opts.cap });
}
