// Readable chapter — a chapter whose page images actually load. Sources delete
// old uploads while the chapter page keeps listing them: 3asq's original
// Naruto 590–700 all point at 404 images (measured 2026-10-31), so the reader
// sat on empty spinners even though mangalik serves the same chapters fine.
// The chosen copy's first and last page are probed; a definitive dead answer
// moves on to the other sources' copies of the same chapter number.

import { fetchMangaChapter } from "./api";
import { upgradeMangaPage } from "./cover";
import type { MangaChapterRef as ChapterCopy, MangaReaderData } from "./types";

/** The owning site — the same Referer main's onBeforeSendHeaders stamps on
 * these hosts' images (hotlink checks 403 anything else). */
export function chapterImageReferer(copy: ChapterCopy): string {
  switch (copy.source) {
    case "asq":
      return "https://3asq.online/";
    case "mangalik":
      return "https://lekmanga.site/";
    case "hijala":
      return "https://hijala.com/";
    default:
      return "https://mangawy.org/";
  }
}

export interface ProbeAnswer {
  status: number;
  contentType: string;
  challenge: boolean;
}

/** False only on a definitive "this file is gone" answer (403/404/410, or an
 * HTML error page where an image should be). Timeouts, network errors and
 * Cloudflare challenges count as alive — they must never switch sources.
 * The renderer can't read a cross-origin status, so main answers. */
export async function probePageAlive(
  uri: string,
  referer: string,
  ask: (uri: string, referer: string) => Promise<ProbeAnswer> = (u, r) =>
    window.pantoufa?.probeMangaPage?.(u, r) ?? Promise.resolve({ status: 0, contentType: "", challenge: false }),
): Promise<boolean> {
  // Column entries (hijala) carry a fragment; the first column is the file —
  // upgraded exactly as the reader draws it.
  const file = upgradeMangaPage(uri.split("#")[0]);
  try {
    const res = await ask(file, referer);
    if (res.challenge || res.status === 0) return true;
    if (res.status === 403 || res.status === 404 || res.status === 410) return false;
    if (res.status >= 200 && res.status < 300 && /^text\/html/i.test(res.contentType)) return false;
    return true;
  } catch {
    return true;
  }
}

export interface ReadableChapter {
  data: MangaReaderData;
  /** The copy that is actually served — image Referers must follow it. */
  copy: ChapterCopy;
}

export interface ReadableDeps {
  fetchChapter: (copy: ChapterCopy, force: boolean) => Promise<MangaReaderData>;
  probe: (uri: string, referer: string) => Promise<boolean>;
}

const defaultDeps: ReadableDeps = {
  fetchChapter: (copy, force) => fetchMangaChapter(copy.source, copy.mangaId, copy.id, { force }),
  probe: (uri, referer) => probePageAlive(uri, referer),
};

const copyKey = (copy: ChapterCopy) => `${copy.source}|${copy.mangaId}|${copy.id}`;

// Primary copy → the copy that worked, so a reopen or a prefetched next
// chapter skips the dead source without probing again.
const resolved = new Map<string, ChapterCopy>();

// Works (source + manga id) seen serving dead images. Deletions hit whole runs
// of a work (Naruto 590–700), so its next chapters try the alternates first
// instead of paying a fetch + probe on the dead source every time.
const deadWorks = new Set<string>();
const workKey = (copy: ChapterCopy) => `${copy.source}|${copy.mangaId}`;

async function pagesAlive(data: MangaReaderData, copy: ChapterCopy, deps: ReadableDeps): Promise<boolean> {
  const referer = chapterImageReferer(copy);
  const { pages } = data;
  const sample = pages.length > 1 ? [pages[0], pages[pages.length - 1]] : [pages[0]];
  const verdicts = await Promise.all(sample.map((uri) => deps.probe(uri, referer)));
  return verdicts.every(Boolean);
}

/**
 * Pages for `primary`, or for the first alternate copy whose images load.
 * `alternates` is only awaited when the primary copy fails, so the common path
 * costs one small probe pair. When every copy looks dead the first copy that had a
 * page list is still returned — the reader then shows its per-page state
 * instead of a hard error.
 */
export async function fetchReadableChapter(
  primary: ChapterCopy,
  alternates: () => Promise<ChapterCopy[]>,
  options: { force?: boolean } = {},
  deps: ReadableDeps = defaultDeps,
): Promise<ReadableChapter> {
  const force = !!options.force;
  const primaryKey = copyKey(primary);
  const remembered = force ? undefined : resolved.get(primaryKey);
  const tried = new Set<string>();
  const state: { lastResort: ReadableChapter | null; lastError: unknown } = { lastResort: null, lastError: null };

  const attempt = async (copy: ChapterCopy): Promise<ReadableChapter | null> => {
    const key = copyKey(copy);
    if (tried.has(key)) return null;
    tried.add(key);
    try {
      const data = await deps.fetchChapter(copy, force);
      if (!data.pages.length) return null;
      const result = { data, copy };
      state.lastResort ??= result;
      if (await pagesAlive(data, copy, deps)) return result;
      deadWorks.add(workKey(copy));
      return null;
    } catch (error) {
      state.lastError = error;
      return null;
    }
  };

  const loadAlternates = async (): Promise<ChapterCopy[]> => {
    try {
      return await alternates();
    } catch {
      return [];
    }
  };

  const primaryDead = !force && deadWorks.has(workKey(primary));
  const tryInOrder = async (copies: ChapterCopy[]): Promise<ReadableChapter | null> => {
    for (const copy of copies) {
      const result = await attempt(copy);
      if (result) {
        resolved.set(primaryKey, result.copy);
        return result;
      }
    }
    return null;
  };

  if (remembered) {
    const result = await tryInOrder([remembered]);
    if (result) return result;
  }
  if (primaryDead) {
    // Known-dead work: live copies first, the primary only as the last try.
    const others = await loadAlternates();
    const ordered = [...others.filter((copy) => !deadWorks.has(workKey(copy))), ...others.filter((copy) => deadWorks.has(workKey(copy))), primary];
    const result = await tryInOrder(ordered);
    if (result) return result;
  } else {
    const result = (await tryInOrder([primary])) ?? (await tryInOrder(await loadAlternates()));
    if (result) return result;
  }

  if (state.lastResort) return state.lastResort;
  throw state.lastError instanceof Error ? state.lastError : new Error("manga: no readable copy");
}
