// Pantoufa Wrapped — pure yearly stats (no RN imports, unit-tested).
//
// Built from the on-device watch history (+ completion count and manga
// reading supplied by the caller). Everything is computed locally; only the
// final summary is ever published (as a share card) when the user asks.

export interface WrappedEntry {
  animeKey: string;
  animeTitle: string;
  animeHref: string;
  image: string;
  episodeHref: string;
  positionMs: number;
  durationMs: number;
  updatedAt: number;
  completed?: boolean;
}

export interface WrappedTop {
  title: string;
  image: string;
  href: string;
  episodes: number;
  minutes: number;
}

export type PersonalityId = "night_owl" | "marathoner" | "completer" | "explorer" | "loyal" | "weekend" | "fan";

export interface WrappedStats {
  year: number;
  minutes: number;
  episodes: number;
  animeCount: number;
  top: WrappedTop[];
  /** Share (0..100) of sessions that happened between midnight and 5am. */
  nightPct: number;
  longestStreak: number;
  bestDay: { date: string; episodes: number } | null;
  /** Episodes per month, Jan..Dec. */
  months: number[];
  topMonth: number | null;
  /** Hour of day (0-23) with the most sessions. */
  peakHour: number | null;
  personality: PersonalityId;
  completedAnime: number;
  mangaTitles: number;
  mangaChapters: number;
}

/** An episode counts once watched past half (or explicitly completed). */
export function countsAsWatched(e: WrappedEntry): boolean {
  if (e.completed) return true;
  return e.durationMs > 0 && e.positionMs / e.durationMs >= 0.5;
}

/** Minutes watched for an entry (full duration when completed). */
export function watchedMinutes(e: WrappedEntry): number {
  const ms = e.completed
    ? (e.durationMs > 0 ? e.durationMs : 23 * 60_000)
    : Math.min(e.positionMs, e.durationMs > 0 ? e.durationMs : e.positionMs);
  return Math.max(0, ms) / 60_000;
}

function dayKey(ts: number, tzOffsetMin: number): string {
  const d = new Date(ts - tzOffsetMin * 60_000);
  return d.toISOString().slice(0, 10);
}

function localHour(ts: number, tzOffsetMin: number): number {
  return new Date(ts - tzOffsetMin * 60_000).getUTCHours();
}

function localMonth(ts: number, tzOffsetMin: number): number {
  return new Date(ts - tzOffsetMin * 60_000).getUTCMonth();
}

function localYear(ts: number, tzOffsetMin: number): number {
  return new Date(ts - tzOffsetMin * 60_000).getUTCFullYear();
}

export function longestStreak(days: string[]): number {
  const sorted = [...new Set(days)].sort();
  let best = 0;
  let run = 0;
  let prev: number | null = null;
  for (const d of sorted) {
    const t = Date.parse(d + "T00:00:00Z");
    run = prev != null && t - prev === 86_400_000 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = t;
  }
  return best;
}

export function pickPersonality(s: Omit<WrappedStats, "personality">, weekendShare: number): PersonalityId {
  if (s.episodes === 0) return "fan";
  if (s.nightPct >= 40 && s.episodes >= 8) return "night_owl";
  if ((s.bestDay?.episodes ?? 0) >= 8) return "marathoner";
  if (s.completedAnime >= 5) return "completer";
  if (s.animeCount >= 15) return "explorer";
  const topShare = s.top[0] ? s.top[0].episodes / s.episodes : 0;
  if (topShare >= 0.45 && s.episodes >= 12) return "loyal";
  if (weekendShare >= 0.6 && s.episodes >= 8) return "weekend";
  return "fan";
}

export function computeWrapped(
  entries: WrappedEntry[],
  opts: {
    year: number;
    tzOffsetMin?: number;
    completedAnime?: number;
    mangaTitles?: number;
    mangaChapters?: number;
  },
): WrappedStats {
  const tz = opts.tzOffsetMin ?? 0;
  const inYear = entries.filter((e) => e.updatedAt > 0 && localYear(e.updatedAt, tz) === opts.year);
  const watched = inYear.filter(countsAsWatched);

  let minutes = 0;
  for (const e of inYear) minutes += watchedMinutes(e);

  const byAnime = new Map<string, WrappedTop>();
  for (const e of inYear) {
    const key = e.animeKey || e.animeTitle;
    if (!key) continue;
    const cur = byAnime.get(key) ?? { title: e.animeTitle, image: e.image, href: e.animeHref, episodes: 0, minutes: 0 };
    if (countsAsWatched(e)) cur.episodes += 1;
    cur.minutes += watchedMinutes(e);
    if (!cur.image && e.image) cur.image = e.image;
    if (!cur.title && e.animeTitle) cur.title = e.animeTitle;
    byAnime.set(key, cur);
  }
  const animeList = [...byAnime.values()].filter((a) => a.episodes > 0 || a.minutes >= 5);
  const top = [...animeList]
    .sort((a, b) => b.episodes - a.episodes || b.minutes - a.minutes)
    .slice(0, 5)
    .map((a) => ({ ...a, minutes: Math.round(a.minutes) }));

  const months = new Array<number>(12).fill(0);
  const hours = new Array<number>(24).fill(0);
  const perDay = new Map<string, number>();
  let night = 0;
  let weekend = 0;
  for (const e of watched) {
    months[localMonth(e.updatedAt, tz)] += 1;
    const h = localHour(e.updatedAt, tz);
    hours[h] += 1;
    if (h < 5) night += 1;
    const day = dayKey(e.updatedAt, tz);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
    const dow = new Date(Date.parse(day + "T12:00:00Z")).getUTCDay();
    // Friday + Saturday (the weekend in most Arab countries) and Sunday.
    if (dow === 5 || dow === 6 || dow === 0) weekend += 1;
  }
  let bestDay: WrappedStats["bestDay"] = null;
  for (const [date, n] of perDay) {
    if (!bestDay || n > bestDay.episodes || (n === bestDay.episodes && date < bestDay.date)) bestDay = { date, episodes: n };
  }
  const maxMonth = Math.max(...months);
  const maxHour = Math.max(...hours);

  const base: Omit<WrappedStats, "personality"> = {
    year: opts.year,
    minutes: Math.round(minutes),
    episodes: watched.length,
    animeCount: animeList.length,
    top,
    nightPct: watched.length ? Math.round((night / watched.length) * 100) : 0,
    longestStreak: longestStreak([...perDay.keys()]),
    bestDay,
    months,
    topMonth: maxMonth > 0 ? months.indexOf(maxMonth) : null,
    peakHour: maxHour > 0 ? hours.indexOf(maxHour) : null,
    completedAnime: opts.completedAnime ?? 0,
    mangaTitles: opts.mangaTitles ?? 0,
    mangaChapters: opts.mangaChapters ?? 0,
  };
  return { ...base, personality: pickPersonality(base, watched.length ? weekend / watched.length : 0) };
}

/** Genre tally weighted by episodes watched per anime. */
export function topGenres(genresByTitle: Map<string, string[]>, top: WrappedTop[], k = 3): string[] {
  const score = new Map<string, number>();
  for (const a of top) {
    for (const g of genresByTitle.get(a.title) ?? []) score.set(g, (score.get(g) ?? 0) + Math.max(1, a.episodes));
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([g]) => g);
}
