// Manga navigation helpers — one place that knows how manga routes are built,
// so hub / detail / reader / library never drift apart (mobile nav.ts parity,
// as react-router paths instead of expo-router pushes).

import { encodeMangaRef, encodeReaderRef, type MangaSourceId } from "./types";

export interface MangaOpenTarget {
  source: MangaSourceId;
  id: string;
  title: string;
  cover?: string | null;
}

function query(params: Record<string, string | null | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) qs.set(key, value);
  const out = qs.toString();
  return out ? `?${out}` : "";
}

export function mangaDetailPath(target: MangaOpenTarget): string {
  return `/manga/title/${encodeURIComponent(encodeMangaRef(target.source, target.id))}${query({
    title: target.title,
    cover: target.cover ?? "",
  })}`;
}

export interface MangaChapterTarget {
  /** Source that owns this chapter's native ids. */
  source: MangaSourceId;
  /** Native manga id on `source`. */
  mangaId: string;
  id: string;
  number: string;
}

export interface MangaReaderTarget {
  /** Anchor work identity (stable for progress/library across sources). */
  source: MangaSourceId;
  mangaId: string;
  mangaTitle: string;
  chapter: MangaChapterTarget;
  cover?: string | null;
}

export function mangaReaderPath(target: MangaReaderTarget): string {
  const ref = encodeReaderRef(
    { source: target.source, id: target.mangaId },
    { source: target.chapter.source, mangaId: target.chapter.mangaId, id: target.chapter.id },
  );
  return `/manga/read/${encodeURIComponent(ref)}${query({
    title: target.mangaTitle,
    num: target.chapter.number,
    cover: target.cover ?? "",
  })}`;
}

export const MANGA_LIBRARY_PATH = "/manga/library";
