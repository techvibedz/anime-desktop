// Weekly anime airing calendar + source availability.
// Ported from the mobile app (lib/schedule.ts); AsyncStorage → storage shim,
// scraper imports from ./scraper.
//
// The schedule comes from AniList's GraphQL airingSchedules feed (the source
// sites expose no air-time data). Availability resolution (resolveSourceUrl /
// filterAvailableItems) verifies AniList titles against anime4up + anime3rb so
// discovery screens only ever show titles the app can actually open.

import { storage } from "./storage";
import { searchAnime4upDirect, searchAnime3rbCatalog } from "./scraper";

export interface ScheduleItem {
  id: number;
  title: string;
  image: string | null;
  episode: number;
  airingAt: number;
  format: string | null;
  score: number | null;
}

export interface ScheduleDay {
  dayStart: number;
  weekday: number;
  items: ScheduleItem[];
}

const ANILIST_URL = "https://graphql.anilist.co";
const CACHE_PREFIX = "@anime_schedule_v1:";
const TTL = 3 * 60 * 60 * 1000; // 3h
const MAX_PAGES = 8;

const QUERY = `query ($start: Int, $end: Int, $page: Int) {
  Page(page: $page, perPage: 50) {
    pageInfo { hasNextPage }
    airingSchedules(airingAt_greater: $start, airingAt_lesser: $end, sort: TIME) {
      airingAt
      episode
      media {
        id
        title { romaji english native }
        coverImage { large medium }
        format
        averageScore
        isAdult
        countryOfOrigin
      }
    }
  }
}`;

type Cached = { ts: number; data: ScheduleDay[] };
const inflight = new Map<string, Promise<ScheduleDay[]>>();

function buildDays(): { days: ScheduleDay[]; windowStart: number; windowEnd: number } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days: ScheduleDay[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    days.push({ dayStart: Math.floor(d.getTime() / 1000), weekday: d.getDay(), items: [] });
  }
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
  return {
    days,
    windowStart: Math.floor(start.getTime() / 1000),
    windowEnd: Math.floor(end.getTime() / 1000),
  };
}

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function pickTitle(t: any): string {
  return (t?.romaji || t?.english || t?.native || "").trim();
}

async function fetchPage(start: number, end: number, page: number): Promise<{ items: any[]; hasNext: boolean }> {
  const body = JSON.stringify({ query: QUERY, variables: { start, end, page } });
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  // Prefer the main process (net.fetch: no CORS, DoH-routed); fall back to the
  // renderer's fetch when the bridge is unavailable.
  let json: any = null;
  try {
    const viaMain = await window.pantoufa?.fetchJson?.({ url: ANILIST_URL, method: "POST", body, headers });
    if (viaMain) json = JSON.parse(viaMain);
  } catch {}
  if (!json) {
    try {
      const res = await fetch(ANILIST_URL, { method: "POST", headers, body });
      if (!res.ok) return { items: [], hasNext: false };
      json = await res.json();
    } catch {
      return { items: [], hasNext: false };
    }
  }
  const p = json?.data?.Page;
  return { items: p?.airingSchedules || [], hasNext: !!p?.pageInfo?.hasNextPage };
}

async function doFetch(): Promise<ScheduleDay[]> {
  const { days, windowStart, windowEnd } = buildDays();
  const start = windowStart - 1;
  const seen = new Set<string>();

  for (let page = 1; page <= MAX_PAGES; page++) {
    const { items, hasNext } = await fetchPage(start, windowEnd, page).catch(() => ({ items: [], hasNext: false }));
    for (const s of items) {
      const m = s?.media;
      if (!m || m.isAdult) continue;
      if (m.countryOfOrigin && m.countryOfOrigin !== "JP") continue;
      const title = pickTitle(m.title);
      if (!title) continue;
      const airingAt: number = s.airingAt;
      const d = new Date(airingAt * 1000);
      const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000;
      const day = days.find((x) => x.dayStart === midnight);
      if (!day) continue;
      const dedupe = `${m.id}#${day.dayStart}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      day.items.push({
        id: m.id,
        title,
        image: m.coverImage?.large || m.coverImage?.medium || null,
        episode: typeof s.episode === "number" ? s.episode : 0,
        airingAt,
        format: m.format || null,
        score: typeof m.averageScore === "number" ? m.averageScore : null,
      });
    }
    if (!hasNext) break;
  }

  for (const day of days) day.items.sort((a, b) => a.airingAt - b.airingAt);
  return days;
}

/** Resolve the 7-day airing calendar grouped by local day. */
export async function fetchWeeklySchedule(force = false): Promise<ScheduleDay[]> {
  const key = CACHE_PREFIX + todayKey();

  if (!force) {
    const pending = inflight.get(key);
    if (pending) return pending;
    try {
      const raw = await storage.getItem(key);
      if (raw) {
        const parsed: Cached = JSON.parse(raw);
        if (Date.now() - parsed.ts < TTL && Array.isArray(parsed.data) && parsed.data.length === 7) {
          return parsed.data;
        }
      }
    } catch {}
  }

  const p = (async () => {
    try {
      const data = await doFetch();
      const hasAny = data.some((d) => d.items.length > 0);
      if (hasAny) {
        try { await storage.setItem(key, JSON.stringify({ ts: Date.now(), data } as Cached)); } catch {}
      }
      return data;
    } catch {
      return buildDays().days;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/* ── Source availability ── */
const SRCURL_PREFIX = "@anime_srcurl_v1:";
const SRCURL_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
const srcUrlMem = new Map<string, string | null>();
const srcUrlInflight = new Map<string, Promise<string | null>>();

function availKey(title: string): string {
  return title.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Resolve a title to a playable source anime URL (anime4up preferred, then
 * anime3rb). Returns null when neither source carries the title. Cached in
 * memory + on disk for a week (positive hits only).
 */
export async function resolveSourceUrl(title: string): Promise<string | null> {
  const key = availKey(title);
  if (!key) return null;
  if (srcUrlMem.has(key)) return srcUrlMem.get(key)!;
  const pending = srcUrlInflight.get(key);
  if (pending) return pending;

  const p = (async () => {
    try {
      const raw = await storage.getItem(SRCURL_PREFIX + key);
      if (raw) {
        const parsed = JSON.parse(raw) as { ts: number; url: string };
        if (Date.now() - parsed.ts < SRCURL_TTL && parsed.url) {
          srcUrlMem.set(key, parsed.url);
          return parsed.url;
        }
      }
    } catch {}

    const ITEM_TIMEOUT_MS = 6000;
    const withTo = <T,>(pr: Promise<T>, ms: number): Promise<T | null> =>
      Promise.race([pr.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), ms))]);
    const u3p = withTo(searchAnime3rbCatalog(title), ITEM_TIMEOUT_MS);
    let url: string | null = await withTo(searchAnime4upDirect(title), ITEM_TIMEOUT_MS);
    if (!url) url = await u3p;

    srcUrlMem.set(key, url ?? null);
    try {
      if (url) await storage.setItem(SRCURL_PREFIX + key, JSON.stringify({ ts: Date.now(), url }));
    } catch {}
    return url ?? null;
  })();
  srcUrlInflight.set(key, p);
  p.finally(() => srcUrlInflight.delete(key));
  return p;
}

async function isAnimeAvailable(title: string): Promise<boolean> {
  return !!(await resolveSourceUrl(title).catch(() => null));
}

// Like filterAvailableItems but ATTACHES the resolved source URL to each kept item.
export async function resolveAvailableItems<T extends { title: string }>(
  items: T[],
  onProgress?: (soFar: (T & { sourceHref: string })[]) => void,
  concurrency = 6,
): Promise<(T & { sourceHref: string })[]> {
  if (items.length === 0) return [];
  await searchAnime3rbCatalog(items[0]?.title || "").catch(() => {});
  const urls = new Array<string | null>(items.length).fill(null);
  const build = () =>
    items
      .map((it, i) => (urls[i] ? { ...it, sourceHref: urls[i]! } : null))
      .filter((x): x is T & { sourceHref: string } => !!x);
  const emit = () => onProgress?.(build());

  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      urls[i] = await resolveSourceUrl(items[i].title).catch(() => null);
      if (urls[i]) emit();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return build();
}

// Return only the items the sources can actually serve, preserving order.
// `onProgress` fires after every resolution with the available items found so far.
export async function filterAvailableItems<T extends { title: string }>(
  items: T[],
  onProgress?: (availableSoFar: T[]) => void,
): Promise<T[]> {
  if (items.length === 0) return [];
  await searchAnime3rbCatalog(items[0]?.title || "").catch(() => {});

  const keep = new Array<boolean>(items.length).fill(false);
  const emit = () => onProgress?.(items.filter((_, i) => keep[i]));

  const CONCURRENCY = 12;
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      keep[i] = await isAnimeAvailable(items[i].title).catch(() => false);
      if (keep[i]) emit();
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return items.filter((_, i) => keep[i]);
}
