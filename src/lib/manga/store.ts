// Manga store — library + reading progress + read marks, all local
// (AsyncStorage), all in one listener so any screen updates when any of them
// changes. Same module-cache + subscribe pattern as lib/favorites.ts; cloud
// sync is deliberately deferred until a Supabase manga table exists.

import { storage as AsyncStorage } from "../storage";
import { useEffect, useState } from "react";
import type { MangaCard, MangaSourceId } from "./types";

const LIB_KEY = "manga_library";
const PROGRESS_KEY = "manga_progress";
const READ_KEY = "manga_read";
const SOURCE_KEY = "manga_source";

export interface MangaLibraryEntry extends MangaCard {
  addedAt: number;
}

export interface MangaProgress {
  /** Anchor work identity (stable across sources). */
  source: MangaSourceId;
  id: string;
  title: string;
  cover: string | null;
  /** Native chapter id + its owning source (may differ from the anchor). */
  chapterId: string;
  chapterSource?: MangaSourceId;
  chapterMangaId?: string;
  chapterNumber: string;
  page: number;
  total: number;
  updatedAt: number;
}

export function mangaKey(source: MangaSourceId, id: string): string {
  return `${source}:${id}`;
}

/** Read-mark key for a merged chapter: the same chapter number may exist on
 * several sources with colliding native ids ("3"), so the owning source is
 * part of the key. */
export function mangaChapterReadKey(source: MangaSourceId, chapterId: string): string {
  return `${source}:${chapterId}`;
}

type Listener = () => void;
const listeners = new Set<Listener>();
function emit() {
  for (const listener of listeners) listener();
}

/** One subscription covers library + progress + read marks. */
export function subscribeMangaStore(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let libCache: MangaLibraryEntry[] | null = null;
let progressCache: Record<string, MangaProgress> | null = null;
let readCache: Record<string, Record<string, true>> | null = null;

async function loadJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Coalesced emit for high-frequency progress writes: a page turn updates
 * memory instantly but subscribers are notified at most every ~1.2 s, so the
 * reader doesn't re-render the whole tree twice per page. */
let progressEmitTimer: ReturnType<typeof setTimeout> | null = null;
function emitProgressSoon() {
  if (progressEmitTimer) return;
  progressEmitTimer = setTimeout(() => {
    progressEmitTimer = null;
    emit();
  }, 1200);
}

/** Debounced writes — a webtoon scroll fires a progress save per page, and
 * AsyncStorage should not be hit at that rate. Memory is always current. */
function persistDebounced(key: string, value: unknown) {
  const existing = persistTimers.get(key);
  if (existing) clearTimeout(existing);
  persistTimers.set(
    key,
    setTimeout(() => {
      persistTimers.delete(key);
      void AsyncStorage.setItem(key, JSON.stringify(value)).catch(() => {});
    }, 1200),
  );
}

/** Flush pending debounced writes immediately (reader unmount / background). */
export function flushMangaStore(): void {
  const hadPendingProgressEmit = progressEmitTimer != null;
  if (progressEmitTimer) {
    clearTimeout(progressEmitTimer);
    progressEmitTimer = null;
  }
  for (const [key, timer] of persistTimers) {
    clearTimeout(timer);
    persistTimers.delete(key);
    const value =
      key === LIB_KEY ? libCache : key === PROGRESS_KEY ? progressCache : key === READ_KEY ? readCache : null;
    if (value != null) void AsyncStorage.setItem(key, JSON.stringify(value)).catch(() => {});
  }
  // A save within the last coalescing window never reached subscribers; emit
  // once now so the continue-reading rail is current after unmount/background.
  if (hadPendingProgressEmit) emit();
}

// ── preferred source ─────────────────────────────────────────────────────────

export async function getPreferredMangaSource(): Promise<MangaSourceId | null> {
  try {
    const raw = await AsyncStorage.getItem(SOURCE_KEY);
    return raw ? (raw as MangaSourceId) : null;
  } catch {
    return null;
  }
}

export function setPreferredMangaSource(source: MangaSourceId): void {
  void AsyncStorage.setItem(SOURCE_KEY, source).catch(() => {});
}

// ── library ──────────────────────────────────────────────────────────────────

export async function getMangaLibrary(): Promise<MangaLibraryEntry[]> {
  if (!libCache) libCache = await loadJson<MangaLibraryEntry[]>(LIB_KEY, []);
  return [...libCache].sort((a, b) => b.addedAt - a.addedAt);
}

export async function isInMangaLibrary(source: MangaSourceId, id: string): Promise<boolean> {
  if (!libCache) libCache = await loadJson<MangaLibraryEntry[]>(LIB_KEY, []);
  const key = mangaKey(source, id);
  return libCache.some((entry) => mangaKey(entry.source, entry.id) === key);
}

/** Returns the new state: true = saved, false = removed. */
export async function toggleMangaLibrary(card: MangaCard): Promise<boolean> {
  if (!libCache) libCache = await loadJson<MangaLibraryEntry[]>(LIB_KEY, []);
  const key = mangaKey(card.source, card.id);
  const exists = libCache.some((entry) => mangaKey(entry.source, entry.id) === key);
  if (exists) {
    libCache = libCache.filter((entry) => mangaKey(entry.source, entry.id) !== key);
  } else {
    // Copy only card fields — callers may pass a full merged detail (with a
    // 1000+ chapter list) and the library must never persist that.
    libCache = [
      {
        source: card.source,
        id: card.id,
        title: card.title,
        cover: card.cover ?? null,
        type: card.type ?? null,
        status: card.status ?? null,
        rating: card.rating ?? null,
        latest: card.latest ?? null,
        addedAt: Date.now(),
      },
      ...libCache,
    ];
  }
  persistDebounced(LIB_KEY, libCache);
  emit();
  return !exists;
}

export async function removeFromMangaLibrary(source: MangaSourceId, id: string): Promise<void> {
  if (!libCache) libCache = await loadJson<MangaLibraryEntry[]>(LIB_KEY, []);
  const key = mangaKey(source, id);
  libCache = libCache.filter((entry) => mangaKey(entry.source, entry.id) !== key);
  persistDebounced(LIB_KEY, libCache);
  emit();
}

// ── progress ─────────────────────────────────────────────────────────────────

export async function saveMangaProgress(entry: Omit<MangaProgress, "updatedAt">): Promise<void> {
  if (!progressCache) progressCache = await loadJson<Record<string, MangaProgress>>(PROGRESS_KEY, {});
  progressCache[mangaKey(entry.source, entry.id)] = { ...entry, updatedAt: Date.now() };
  persistDebounced(PROGRESS_KEY, progressCache);
  emitProgressSoon();
}

/** Drop a work from "متابعة القراءة" (read by accident / don't want it back). */
export async function removeMangaProgress(source: MangaSourceId, id: string): Promise<void> {
  if (!progressCache) progressCache = await loadJson<Record<string, MangaProgress>>(PROGRESS_KEY, {});
  const key = mangaKey(source, id);
  if (!progressCache[key]) return;
  delete progressCache[key];
  persistDebounced(PROGRESS_KEY, progressCache);
  emit();
}

export async function getMangaProgress(source: MangaSourceId, id: string): Promise<MangaProgress | null> {
  if (!progressCache) progressCache = await loadJson<Record<string, MangaProgress>>(PROGRESS_KEY, {});
  return progressCache[mangaKey(source, id)] ?? null;
}

export async function getContinueReading(limit = 12): Promise<MangaProgress[]> {
  if (!progressCache) progressCache = await loadJson<Record<string, MangaProgress>>(PROGRESS_KEY, {});
  return Object.values(progressCache)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

// ── read marks ───────────────────────────────────────────────────────────────

export async function setMangaChapterRead(
  source: MangaSourceId,
  id: string,
  chapterId: string,
  read: boolean,
): Promise<void> {
  if (!readCache) readCache = await loadJson<Record<string, Record<string, true>>>(READ_KEY, {});
  const key = mangaKey(source, id);
  const marks = readCache[key] ?? {};
  if (read) {
    if (marks[chapterId]) return;
    marks[chapterId] = true;
  } else {
    if (!marks[chapterId]) return;
    delete marks[chapterId];
  }
  // 3000 chapters is beyond every Arabic series in the catalog; trim oldest to
  // stop a single manga's read log from growing without bound.
  const ids = Object.keys(marks);
  if (ids.length > 3000) for (const old of ids.slice(0, ids.length - 3000)) delete marks[old];
  readCache[key] = marks;
  persistDebounced(READ_KEY, readCache);
  emit();
}

export async function markMangaChapterRead(
  source: MangaSourceId,
  id: string,
  chapterId: string,
): Promise<void> {
  return setMangaChapterRead(source, id, chapterId, true);
}

export async function getReadChapters(source: MangaSourceId, id: string): Promise<string[]> {
  if (!readCache) readCache = await loadJson<Record<string, Record<string, true>>>(READ_KEY, {});
  return Object.keys(readCache[mangaKey(source, id)] ?? {});
}

// ── hooks ────────────────────────────────────────────────────────────────────

function useMangaSnapshot<T>(
  load: () => Promise<T>,
  initial: T,
  deps: unknown[],
  equal?: (previous: T, next: T) => boolean,
): T {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    let alive = true;
    const run = () => {
      load().then(
        (next) => {
          if (!alive) return;
          // Identity-preserving bailout: store emits (e.g. a page-progress
          // write) must not re-render screens whose slice didn't change.
          setValue((previous) => (equal && equal(previous, next) ? previous : next));
        },
        () => { /* keep previous value on load failure */ },
      );
    };
    run();
    const unsubscribe = subscribeMangaStore(run);
    return () => { alive = false; unsubscribe(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return value;
}

function sameStringArray(a: string[], b: string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameProgressList(a: MangaProgress[], b: MangaProgress[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    // `updatedAt` deliberately ignored: it changes on every page save, and
    // re-rendering the covered hub/detail every 1.2s while reading is waste.
    if (
      x.source !== y.source || x.id !== y.id || x.chapterId !== y.chapterId ||
      x.chapterSource !== y.chapterSource || x.chapterMangaId !== y.chapterMangaId ||
      x.page !== y.page || x.total !== y.total
    ) {
      return false;
    }
  }
  return true;
}

export function useMangaLibrary(): MangaLibraryEntry[] {
  return useMangaSnapshot(getMangaLibrary, [], [], (a, b) => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i].source !== b[i].source || a[i].id !== b[i].id || a[i].addedAt !== b[i].addedAt) return false;
    }
    return true;
  });
}

export function useContinueReading(limit = 12): MangaProgress[] {
  return useMangaSnapshot(() => getContinueReading(limit), [], [limit], sameProgressList);
}

export function useMangaProgress(source: MangaSourceId, id: string): MangaProgress | null {
  return useMangaSnapshot(
    () => getMangaProgress(source, id),
    null,
    [source, id],
    (a, b) => {
      if (a === b) return true;
      if (!a || !b) return false;
      return (
        a.chapterId === b.chapterId && a.page === b.page && a.total === b.total &&
        a.chapterNumber === b.chapterNumber
      );
    },
  );
}

export function useReadChapters(source: MangaSourceId, id: string): string[] {
  return useMangaSnapshot(() => getReadChapters(source, id), [], [source, id], sameStringArray);
}

export function useInMangaLibrary(source: MangaSourceId, id: string): boolean | null {
  return useMangaSnapshot(() => isInMangaLibrary(source, id), null, [source, id]);
}
