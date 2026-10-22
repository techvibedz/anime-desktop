// Manga API — one entry point in front of the four source adapters, with the
// in-memory request cache so tab switches and back-navigation never re-fetch.
// Mirrors lib/api.ts's role for anime, but stays fully separate from it.

import { storage as AsyncStorage } from "../storage";
import { createRequestCache, withTimeout } from "../requestCache";
import type {
  MangaCard,
  MangaDetail,
  MangaFilterOptions,
  MangaHome,
  MangaReaderData,
  MangaSource,
  MangaSourceId,
} from "./types";
import { asqSource } from "./sources/asq";
import { mangawySource } from "./sources/mangawy";
import { mangalikSource } from "./sources/mangalik";

export const MANGA_SOURCES: Record<MangaSourceId, MangaSource> = {
  asq: asqSource,
  mangawy: mangawySource,
  mangalik: mangalikSource,
};

const homeCache = createRequestCache<MangaHome>(10 * 60_000);
const searchCache = createRequestCache<MangaCard[]>(2 * 60_000);
const browseCache = createRequestCache<MangaCard[]>(10 * 60_000);
const detailCache = createRequestCache<MangaDetail>(10 * 60_000);
const chapterCache = createRequestCache<MangaReaderData>(30 * 60_000);

// ── stale-while-revalidate persistence ───────────────────────────────────────
// The hub/detail screens show the last-known payload from AsyncStorage on the
// first frame, then the network refresh replaces it — the app never opens on
// an empty manga tab again. 7-day staleness cap.

const HOME_CACHE_PREFIX = "manga_home_cache_v1:";
const DETAIL_CACHE_PREFIX = "manga_detail_cache_v1:";
const SWR_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function readSwrCache<T>(key: string): Promise<T | null> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { ts?: number; value?: T };
    if (!parsed?.ts || Date.now() - parsed.ts > SWR_TTL_MS || parsed.value == null) return null;
    return parsed.value;
  } catch {
    return null;
  }
}

function writeSwrCache(key: string, value: unknown) {
  void AsyncStorage.setItem(key, JSON.stringify({ ts: Date.now(), value })).catch(() => {});
}

export function readCachedMangaHome(source: MangaSourceId): Promise<MangaHome | null> {
  return readSwrCache<MangaHome>(`${HOME_CACHE_PREFIX}${source}`);
}

export function readCachedMangaDetail(source: MangaSourceId, id: string): Promise<MangaDetail | null> {
  return readSwrCache<MangaDetail>(`${DETAIL_CACHE_PREFIX}${source}|${id}`);
}

export function fetchMangaHome(source: MangaSourceId, options?: { force?: boolean }): Promise<MangaHome> {
  return homeCache.run(
    source,
    async () => {
      const home = await MANGA_SOURCES[source].home();
      writeSwrCache(`${HOME_CACHE_PREFIX}${source}`, home);
      return home;
    },
    { force: options?.force },
  );
}

/** Filter hints participate in the cache key so a type/status/sort change never
 * serves another filter's cards. */
function filterKey(options?: MangaFilterOptions): string {
  return JSON.stringify([options?.status, options?.type, options?.sort, [...(options?.genres ?? [])].sort(), options?.page ?? 1]);
}

export function searchManga(
  source: MangaSourceId,
  query: string,
  options?: MangaFilterOptions,
): Promise<MangaCard[]> {
  const q = query.trim();
  if (!q) return Promise.resolve([]);
  // Hard cap per source: a stuck fetch must never hold the whole search page.
  return withTimeout(
    searchCache.run(`${source}|${q}|${filterKey(options)}`, () => MANGA_SOURCES[source].search(q, options), { valid: cards => cards.length > 0 }),
    // Direct retries plus the 28s browser fallback must fit inside this cap.
    45_000,
    [],
  );
}

/** Give direct retries and browser verification the same budget as search. */
export function browseMangaGenre(
  source: MangaSourceId,
  label: string,
  page: number,
  options?: MangaFilterOptions,
): Promise<MangaCard[]> {
  return withTimeout(
    browseCache.run(`${source}|${label}|${page}|${filterKey(options)}`, () =>
      MANGA_SOURCES[source].browseGenre(label, page, options),
      { valid: cards => cards.length > 0 },
    ),
    45_000,
    [],
  );
}

/** Whole-catalog page for the empty-query filter flow. */
export function browseMangaAll(
  source: MangaSourceId,
  page: number,
  options?: MangaFilterOptions,
): Promise<MangaCard[]> {
  return withTimeout(
    browseCache.run(`${source}|*|${page}|${filterKey(options)}`, () =>
      MANGA_SOURCES[source].browseAll(page, options),
      { valid: cards => cards.length > 0 },
    ),
    45_000,
    [],
  );
}

export function fetchMangaDetail(
  source: MangaSourceId,
  id: string,
  options?: { force?: boolean },
): Promise<MangaDetail> {
  return detailCache.run(
    `${source}|${id}`,
    async () => {
      const detail = await MANGA_SOURCES[source].detail(id);
      writeSwrCache(`${DETAIL_CACHE_PREFIX}${source}|${id}`, detail);
      return detail;
    },
    { force: options?.force },
  );
}

export function fetchMangaChapter(
  source: MangaSourceId,
  mangaId: string,
  chapterId: string,
  options?: { force?: boolean },
): Promise<MangaReaderData> {
  return chapterCache.run(
    `${source}|${mangaId}|${chapterId}`,
    async () => {
      const data = await MANGA_SOURCES[source].chapter(mangaId, chapterId);
      if (!data.pages.length) throw new Error("manga: empty chapter");
      return data;
    },
    { force: options?.force },
  );
}


