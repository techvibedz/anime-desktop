// Pure episode-reaction logic (hype map) — no RN imports, unit-tested.
//
// Reactions are stored per (anime, episode, 5-second bucket, emoji, user).
// The player turns the aggregate into a heat strip over the seek bar, a
// "hottest moment" jump, and floating emojis as playback passes busy buckets.

export const REACTIONS = [
  { id: "fire", glyph: "🔥" },
  { id: "laugh", glyph: "😂" },
  { id: "cry", glyph: "😭" },
  { id: "shock", glyph: "😱" },
  { id: "love", glyph: "😍" },
  { id: "clap", glyph: "👏" },
] as const;

export type ReactionId = (typeof REACTIONS)[number]["id"];

export const BUCKET_SEC = 5;
/** Max bucket index the database accepts (≈3.4h). */
export const MAX_BUCKET = 2500;

export function glyphOf(id: string): string {
  return REACTIONS.find((r) => r.id === id)?.glyph ?? "✨";
}

export function isReactionId(id: string): id is ReactionId {
  return REACTIONS.some((r) => r.id === id);
}

export function bucketOf(sec: number): number {
  if (!Number.isFinite(sec) || sec < 0) return 0;
  return Math.min(MAX_BUCKET, Math.floor(sec / BUCKET_SEC));
}

export interface ReactionRow {
  bucket: number;
  emoji: string;
  n: number;
  mine?: boolean;
}

export interface BucketEntry {
  total: number;
  counts: Partial<Record<ReactionId, number>>;
  mine: ReactionId[];
}

export type ReactionMap = Map<number, BucketEntry>;

export function buildReactionMap(rows: ReactionRow[]): ReactionMap {
  const map: ReactionMap = new Map();
  for (const r of rows) {
    if (!isReactionId(r.emoji) || !(r.n > 0) || !(r.bucket >= 0)) continue;
    const e = map.get(r.bucket) ?? { total: 0, counts: {}, mine: [] };
    e.counts[r.emoji] = (e.counts[r.emoji] ?? 0) + r.n;
    e.total += r.n;
    if (r.mine && !e.mine.includes(r.emoji)) e.mine.push(r.emoji);
    map.set(r.bucket, e);
  }
  return map;
}

/** Optimistic local add (immutable). A repeat of my own emoji in a bucket is a no-op (DB is unique). */
export function addLocalReaction(map: ReactionMap, bucket: number, emoji: ReactionId): ReactionMap {
  const cur = map.get(bucket);
  if (cur?.mine.includes(emoji)) return map;
  const next: ReactionMap = new Map(map);
  const e: BucketEntry = cur
    ? { total: cur.total, counts: { ...cur.counts }, mine: [...cur.mine] }
    : { total: 0, counts: {}, mine: [] };
  e.counts[emoji] = (e.counts[emoji] ?? 0) + 1;
  e.total += 1;
  e.mine.push(emoji);
  next.set(bucket, e);
  return next;
}

export function totalReactions(map: ReactionMap): number {
  let n = 0;
  for (const e of map.values()) n += e.total;
  return n;
}

/**
 * Heat strip: `segments` values in 0..1 across the episode duration.
 * Square-root scaling keeps one huge spike from flattening everything else.
 */
export function heatSegments(map: ReactionMap, durationSec: number, segments = 60): number[] {
  const out = new Array<number>(segments).fill(0);
  if (!(durationSec > 0) || map.size === 0) return out;
  for (const [bucket, e] of map) {
    const t = bucket * BUCKET_SEC + BUCKET_SEC / 2;
    if (t > durationSec) continue;
    const i = Math.min(segments - 1, Math.floor((t / durationSec) * segments));
    out[i] += e.total;
  }
  const max = Math.max(...out);
  if (max <= 0) return out;
  return out.map((v) => (v > 0 ? Math.sqrt(v / max) : 0));
}

/** Busiest bucket (ties → earliest), or null. */
export function hottestBucket(map: ReactionMap, minTotal = 1): { bucket: number; total: number; top: ReactionId | null } | null {
  let best: { bucket: number; total: number; top: ReactionId | null } | null = null;
  for (const [bucket, e] of map) {
    if (e.total < minTotal) continue;
    if (!best || e.total > best.total || (e.total === best.total && bucket < best.bucket)) {
      best = { bucket, total: e.total, top: topEmojis(e, 1)[0] ?? null };
    }
  }
  return best;
}

/** Most-used emojis in a bucket, most first. */
export function topEmojis(e: BucketEntry, k = 3): ReactionId[] {
  return (Object.entries(e.counts) as [ReactionId, number][])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([id]) => id);
}

/**
 * What to float when playback enters a bucket: other people's reactions only
 * (my own were already floated when I tapped), at most `cap` glyphs.
 */
export function floatsForBucket(e: BucketEntry | undefined, cap = 3): ReactionId[] {
  if (!e) return [];
  const others: [ReactionId, number][] = [];
  for (const [id, n] of Object.entries(e.counts) as [ReactionId, number][]) {
    const fromOthers = n - (e.mine.includes(id) ? 1 : 0);
    if (fromOthers > 0) others.push([id, fromOthers]);
  }
  others.sort((a, b) => b[1] - a[1]);
  const out: ReactionId[] = [];
  for (const [id, n] of others) {
    for (let i = 0; i < Math.min(n, 2) && out.length < cap; i++) out.push(id);
    if (out.length >= cap) break;
  }
  return out;
}

/** "14:32" / "1:02:05". */
export function formatClock(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
