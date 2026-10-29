// Deterministic "anime of the day" selection. Same local day key → same pick,
// for every install, with no network or hidden state. FNV-1a (32-bit) scatters
// nearby dates instead of walking the list one step per day.

export function localDayKey(d = new Date()): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** FNV-1a index of `dayKey` into a list of `length`. 0 when length <= 0. */
export function pickIndexOfTheDay(length: number, dayKey: string): number {
  if (length <= 0) return 0;
  let h = 0x811c9dc5;
  for (let i = 0; i < dayKey.length; i++) {
    h ^= dayKey.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % length;
}

export function pickOfTheDay<T>(items: readonly T[], dayKey: string): T | null {
  if (items.length === 0) return null;
  return items[pickIndexOfTheDay(items.length, dayKey)];
}

/**
 * Keep only entries that can actually be watched today. Shared by the home
 * card and the daily notification so both name the same anime for a day key —
 * an unreleased title must never win the pick.
 */
export function filterWatchable<T extends { status?: string | null }>(items: readonly T[]): T[] {
  return items.filter((item) => item?.status !== "NOT_YET_RELEASED");
}

/**
 * The shared daily pool: watchable entries, most popular first (tie-break by
 * id so the order is stable), capped to the segment the sources are likely to
 * carry. Card and notification both build the pool through this function and
 * hash the same day key, so they start from the same pick; the card may walk
 * past a dead candidate while the notification stays best-effort.
 */
export function orderDailyPool<
  T extends { status?: string | null; popularity?: number | null; id?: number },
>(items: readonly T[], cap = 80): T[] {
  return filterWatchable(items)
    .slice()
    .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0) || (a.id ?? 0) - (b.id ?? 0))
    .slice(0, cap);
}

/* ── All-time pool selection ──
   The home card draws from an all-time "best of" pool (lib/dailyPool). Days are
   mapped through a per-cycle shuffle of the pool, so every title is shown once
   before any title repeats, the order still looks random, and every install
   names the same anime on the same day (no network, no hidden state). */

/** Whole days since the epoch for the LOCAL calendar date of `d`. */
export function localDayNumber(d = new Date()): number {
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
}

// mulberry32 — tiny deterministic PRNG for the per-cycle shuffle.
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const permCache = new Map<string, number[]>();
function cyclePermutation(length: number, cycle: number): number[] {
  const key = `${length}:${cycle}`;
  const hit = permCache.get(key);
  if (hit) return hit;
  const rand = seeded(cycle * 2654435761 + length);
  const perm = Array.from({ length }, (_, i) => i);
  for (let i = length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  if (permCache.size > 8) permCache.clear();
  permCache.set(key, perm);
  return perm;
}

/** Pool index for `dayNumber`: no repeats within a cycle of `length` days. */
export function dailyIndex(length: number, dayNumber: number): number {
  if (length <= 0) return 0;
  const day = Math.max(0, Math.floor(dayNumber));
  return cyclePermutation(length, Math.floor(day / length))[day % length];
}

/**
 * Today's pick first, then the next days' picks — the order the card walks
 * when a pick can't be opened on the sources. Distinct indices, at most `max`.
 */
export function dailyCandidates(length: number, dayNumber: number, max = 6): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (let k = 0; out.length < Math.min(max, length) && k < length * 2; k++) {
    const idx = dailyIndex(length, dayNumber + k);
    if (seen.has(idx)) continue;
    seen.add(idx);
    out.push(idx);
  }
  return out;
}
