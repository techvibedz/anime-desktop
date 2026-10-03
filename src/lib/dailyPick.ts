// Deterministic "anime of the day" selection. Same local day key → same pick,
// for every install, with no network or hidden state. FNV-1a (32-bit) scatters
// nearby dates instead of walking the list one step per day.
// Ported verbatim from the mobile app's lib/dailyPick.ts.

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
