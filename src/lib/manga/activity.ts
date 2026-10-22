// Pure row shaping for the manga_activity mirror (RN-free so it is unit
// testable — see activity.test.ts). One row per work: the library entry and the
// reading progress of the same work collapse onto its anchor key.

export interface MangaActivityRow {
  user_id: string;
  manga_key: string;
  source: string;
  manga_id: string;
  title: string;
  cover: string | null;
  chapter_number: string | null;
  page: number;
  total: number;
  in_library: boolean;
  updated_at: string;
}

interface LibraryLike { source: string; id: string; title: string; cover: string | null; addedAt: number }
interface ProgressLike { source: string; id: string; title: string; cover: string | null; chapterNumber: string; page: number; total: number; updatedAt: number }

/** Server cap per user — keeps one heavy reader from uploading thousands of rows. */
export const MANGA_ACTIVITY_CAP = 300;

export function buildMangaActivityRows(
  userId: string,
  library: readonly LibraryLike[],
  progress: readonly ProgressLike[],
): MangaActivityRow[] {
  const byKey = new Map<string, MangaActivityRow>();
  const keyOf = (source: string, id: string) => `${source}:${id}`;
  for (const p of progress) {
    if (!p?.source || !p.id) continue;
    byKey.set(keyOf(p.source, p.id), {
      user_id: userId,
      manga_key: keyOf(p.source, p.id),
      source: p.source,
      manga_id: p.id,
      title: p.title || "",
      cover: p.cover || null,
      chapter_number: p.chapterNumber || null,
      page: Math.max(0, Math.floor(p.page || 0)),
      total: Math.max(0, Math.floor(p.total || 0)),
      in_library: false,
      updated_at: new Date(p.updatedAt || 0).toISOString(),
    });
  }
  for (const l of library) {
    if (!l?.source || !l.id) continue;
    const key = keyOf(l.source, l.id);
    const cur = byKey.get(key);
    if (cur) {
      cur.in_library = true;
      if (!cur.cover) cur.cover = l.cover || null;
      if (!cur.title) cur.title = l.title || "";
      continue;
    }
    byKey.set(key, {
      user_id: userId,
      manga_key: key,
      source: l.source,
      manga_id: l.id,
      title: l.title || "",
      cover: l.cover || null,
      chapter_number: null,
      page: 0,
      total: 0,
      in_library: true,
      updated_at: new Date(l.addedAt || 0).toISOString(),
    });
  }
  return [...byKey.values()]
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
    .slice(0, MANGA_ACTIVITY_CAP);
}
