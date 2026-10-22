// Manga domain types — the source-agnostic shapes every manga source adapter
// normalizes into, and everything in the manga UI consumes. Screens never see
// source-specific fields, so adding a source means writing one adapter, not
// touching any screen.

export type MangaSourceId = "asq" | "mangawy" | "mangalik";

export interface MangaCard {
  source: MangaSourceId;
  /** Source-native id: 3asq absolute manga URL · mangawy/mangalik slug. */
  id: string;
  title: string;
  cover: string | null;
  /** Other sources' covers for the same work (set by mergeCards). Sources
   * delete old uploads (mangalik 403s on ~28% of covers), so a dead primary
   * cover falls back to these before the AniList lookup. */
  coverAlts?: string[];
  /** Arabic content type label: "مانجا" | "مانهوا" | "مانها". */
  type?: string | null;
  /** "مستمر" | "مكتمل" | "معلق" when the source exposes it. */
  status?: string | null;
  rating?: string | null;
  /** Latest chapter label ("الفصل 179") when the source exposes it. */
  latest?: string | null;
}

export interface MangaChapterInfo {
  /** Source-native chapter id: 3asq chapter URL · mangawy/mangalik path. */
  id: string;
  /** Display number ("179", "24.1", "خاص"). */
  number: string;
  title?: string | null;
  date?: string | null;
}

export interface MangaDetail extends MangaCard {
  synopsis?: string | null;
  genres: string[];
  /** Newest-first as returned by the source; the detail screen flips for display. */
  chapters: MangaChapterInfo[];
  author?: string | null;
  year?: string | null;
}

export interface MangaReaderData {
  /** Ordered absolute page image URLs. */
  pages: string[];
  /** Provider title when the source knows it ("One Piece 1194"). */
  title?: string | null;
}

export interface MangaHomeSection {
  id: string;
  title: string;
  /** "grid" = cover cards · "ranked" = numbered grid · "latest" = chapter rows. */
  kind: "grid" | "ranked" | "latest";
  items: MangaCard[];
}

export interface MangaHome {
  /** Hero carousel candidates; may be empty. */
  featured: MangaCard[];
  sections: MangaHomeSection[];
}

/** Sort modes offered by the search filter sheet. */
export type MangaSort = "default" | "latest" | "title";

/** Server-side filter hints for adapters that support them (Madara status /
 * order params, mangawy /api/browse). Sources without support ignore them and
 * the UI filters the returned cards client-side. */
export interface MangaFilterOptions {
  /** Selected genres match any; title/type/status still narrow the results. */
  genres?: string[];
  page?: number;
  /** Arabic status label ("مستمر" | "مكتمل" | "معلق"). */
  status?: string | null;
  /** Arabic type label ("مانجا" | "مانهوا" | "مانها"). */
  type?: string | null;
  sort?: MangaSort;
}

/** A source adapter. home/detail/chapter reject on total failure (the UI shows
 * an error state); search/browse resolve [] instead. */
export interface MangaSource {
  id: MangaSourceId;
  label: string;
  home(): Promise<MangaHome>;
  search(query: string, options?: MangaFilterOptions): Promise<MangaCard[]>;
  /** Genre listing page (1-based); sources without the taxonomy resolve []. */
  browseGenre(label: string, page: number, options?: MangaFilterOptions): Promise<MangaCard[]>;
  /** Whole-catalog page for the empty-query filter flow (1-based). */
  browseAll(page: number, options?: MangaFilterOptions): Promise<MangaCard[]>;
  detail(id: string): Promise<MangaDetail>;
  chapter(mangaId: string, chapterId: string): Promise<MangaReaderData>;
}

// ── cross-source merge ───────────────────────────────────────────────────────

/** One chapter of a merged work: its native ids belong to `source`, not to the
 * work's anchor source, so the reader must fetch it from `source`. */
export interface MergedChapter extends MangaChapterInfo {
  source: MangaSourceId;
  /** Native manga id on `source` (URL/slug) — required to build chapter URLs. */
  mangaId: string;
}

/** Detail with every matching source's chapters unioned by chapter number —
 * gaps in one source are filled by the others (the anime episode-merge logic). */
export interface MergedMangaDetail extends Omit<MangaDetail, "chapters"> {
  /** Every source that matched, best page quality first. */
  sources: MangaSourceId[];
  chapters: MergedChapter[];
}

/** Reader route ref: anchor work + the exact chapter's owning source/ids. */
export interface MangaReaderRef {
  source: MangaSourceId;
  mangaId: string;
  chapterSource: MangaSourceId;
  chapterMangaId: string;
  chapterId: string;
}

export function encodeReaderRef(
  anchor: { source: MangaSourceId; id: string },
  chapter: { source: MangaSourceId; mangaId: string; id: string },
): string {
  return `${anchor.source}:${anchor.id}#${chapter.source}#${chapter.mangaId}#${chapter.id}`;
}

export function decodeReaderRef(ref: string): MangaReaderRef | null {
  const hash = ref.indexOf("#");
  if (hash <= 0) return null;
  const anchor = decodeMangaRef(ref.slice(0, hash));
  if (!anchor) return null;
  // The chapter id can itself contain "#" (unlikely but free to support).
  const parts = ref.slice(hash + 1).split("#");
  if (parts.length < 3) return null;
  const chapterId = parts.slice(2).join("#");
  const chapterSource = parts[0] as MangaSourceId;
  const chapterMangaId = parts[1];
  if (!chapterId || !chapterMangaId) return null;
  return {
    source: anchor.source,
    mangaId: anchor.id,
    chapterSource,
    chapterMangaId,
    chapterId,
  };
}

/** Route param helpers — a manga ref is `${source}:${nativeId}` URI-encoded
 * into the route path; the chapter ref appends `#${chapterId}`. */
export function encodeMangaRef(source: MangaSourceId, id: string): string {
  return `${source}:${id}`;
}

export function decodeMangaRef(ref: string): { source: MangaSourceId; id: string } | null {
  const sep = ref.indexOf(":");
  if (sep <= 0) return null;
  const source = ref.slice(0, sep) as MangaSourceId;
  const id = ref.slice(sep + 1);
  if (!id) return null;
  return { source, id };
}

export function encodeChapterRef(source: MangaSourceId, mangaId: string, chapterId: string): string {
  return `${source}:${mangaId}#${chapterId}`;
}

export function decodeChapterRef(
  ref: string,
): { source: MangaSourceId; mangaId: string; chapterId: string } | null {
  const sep = ref.indexOf(":");
  const hash = ref.lastIndexOf("#");
  if (sep <= 0 || hash <= sep) return null;
  return {
    source: ref.slice(0, sep) as MangaSourceId,
    mangaId: ref.slice(sep + 1, hash),
    chapterId: ref.slice(hash + 1),
  };
}
