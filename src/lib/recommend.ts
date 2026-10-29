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
  opts: { excluded?: (item: RecItem) => boolean; cap?: number; weights?: readonly number[] } = {},
): RankedRec[] {
  const cap = opts.cap ?? 15;
  const merged = new Map<number, RankedRec>();
  // With weights (taste seeds), each batch is normalised to its own best rating
  // and scaled by the seed's weight so one seed with hugely-upvoted recs can't
  // drown the others (mobile parity). Without, raw upvotes are summed.
  batches.forEach((batch, i) => {
    const weighted = !!opts.weights;
    const weight = opts.weights?.[i] ?? 1;
    const top = Math.max(1, ...batch.map((it) => (it ? it.rating : 0)));
    for (const item of batch) {
      if (!item || item.anilistId == null) continue;
      const part = weighted ? (Math.max(0, item.rating) / top) * weight : item.rating;
      const cur = merged.get(item.anilistId);
      if (cur) {
        cur.score += part;
        continue;
      }
      merged.set(item.anilistId, { ...item, score: part });
    }
  });
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

/** One anime from the full watch history, as pickTasteSeeds reads it. */
export interface TasteSource extends RecSeedSource {
  /** Distinct episodes watched (engagement). */
  watched: number;
  updatedAt: number;
}

export interface WeightedSeed extends RecSeed {
  weight: number;
}

const TASTE_HALF_LIFE_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

/**
 * Seeds that represent the whole taste, not just the latest anime: every
 * distinct anime in the history is weighted by how much of it was watched
 * (log-scaled, so a 1000-episode One Piece does not own the rail) and how
 * recently (60-day half-life, floored so an old favourite still counts).
 * Mirrors mobile lib/recommend.ts.
 */
export function pickTasteSeeds(
  groups: readonly TasteSource[],
  keyOf: (entry: RecSeedSource) => string,
  cap = 6,
  now = Date.now(),
): WeightedSeed[] {
  const best = new Map<string, WeightedSeed>();
  for (const g of groups) {
    if (!g || !g.animeTitle || !g.animeTitle.trim()) continue;
    const key = keyOf(g) || g.animeTitle.trim().toLowerCase();
    const engagement = 1 + Math.log2(1 + Math.max(0, g.watched || 0));
    const age = Math.max(0, now - (g.updatedAt || 0));
    const recency = Math.max(0.25, Math.pow(0.5, age / TASTE_HALF_LIFE_MS));
    const weight = engagement * recency;
    const cur = best.get(key);
    if (!cur || weight > cur.weight) best.set(key, { animeTitle: g.animeTitle, animeHref: g.animeHref, weight });
  }
  return [...best.values()].sort((a, b) => b.weight - a.weight).slice(0, cap);
}
