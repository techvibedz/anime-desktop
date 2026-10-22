// Cross-source aggregation — the "one page" layer.
//
// Everything the UI consumes (home rails, search, browse, detail chapters)
// goes through here. Works are identified by a normalized title key, so the
// same series appearing on several sources is one card; detail chapters are
// unioned by chapter number so a gap in one source is filled by another (the
// same merge idea as the anime episode grid). Each chapter remembers which
// source owns its native ids, so the reader always fetches from a source that
// actually has it.
//
// Page-quality routing: when several sources carry the same chapter number the
// highest-resolution source wins (3asq ≈2000px scans, mangalik ≈967px,
// mangawy ≈720px — measured live). Coverage is never lost: chapters missing
// from the best source are served by whichever source has them.

import { storage as AsyncStorage } from "../storage";
import { fuzzyScore, levenshtein, normFuzzy, sourceSearchQueries } from "../fuzzy";
import { createRequestCache, withTimeout } from "../requestCache";
import {
  browseMangaAll,
  browseMangaGenre,
  fetchMangaDetail,
  fetchMangaHome,
  readCachedMangaHome,
  searchManga,
} from "./api";
import type {
  MangaCard,
  MangaDetail,
  MangaFilterOptions,
  MangaHome,
  MangaHomeSection,
  MangaSort,
  MangaSourceId,
  MergedChapter,
  MergedMangaDetail,
} from "./types";

export const COMBINED_SOURCES: MangaSourceId[] = ["asq", "mangawy", "mangalik"];

/** Widest chapter pages first (measured live). Used to pick which source's
 * copy of a duplicated chapter renders and which card wins a title tie. */
export const SOURCE_QUALITY_ORDER: MangaSourceId[] = ["asq", "mangalik", "mangawy"];

export function sourceRank(source: MangaSourceId): number {
  const index = SOURCE_QUALITY_ORDER.indexOf(source);
  return index < 0 ? SOURCE_QUALITY_ORDER.length : index;
}

// ── identity ─────────────────────────────────────────────────────────────────

/** Type words that sources append to titles but that are not part of the work. */
const TITLE_NOISE = new Set([
  "manga", "manhwa", "manhua", "comic", "novel", "webtoon",
  "مانجا", "مانهوا", "مانها", "رواية", "مترجم", "مترجمة",
]);

/** Normalized title key shared by cards, search hits and details. */
export function mangaTitleKey(title: string): string {
  return normFuzzy(title)
    .split(" ")
    .filter((token) => token && !TITLE_NOISE.has(token))
    .join(" ");
}

/** Chapter-number key: Arabic digits folded to ASCII, first numeric token wins
 * ("الفصل 179" → "179", "24.1" → "24.1"); non-numeric labels fall back to the
 * normalized text ("خاص" → "خاص"). */
export function chapterNumberKey(number: string | null | undefined): string {
  const raw = String(number ?? "").trim();
  if (!raw) return "";
  const ascii = raw
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)));
  const match = /(\d+(?:\.\d+)*)/.exec(ascii);
  if (match) {
    // Keep every dotted segment so "2.5.1" and "2.5" stay distinct keys.
    return match[1]
      .split(".")
      .map((part) => String(Number(part)))
      .join(".");
  }
  return normFuzzy(ascii);
}

function chapterSortValue(number: string): number {
  const value = Number.parseFloat(chapterNumberKey(number));
  return Number.isFinite(value) ? value : -1;
}

function latestNumber(label: string | null | undefined): number {
  return chapterSortValue(String(label ?? "").replace(/^الفصل\s*/, ""));
}

/** Function words that must not make or break a match ("Return of the Mount
 * Hua Sect" vs "Return of Mount Hua Sect"). */
const TITLE_STOPWORDS = new Set([
  "the", "of", "a", "an", "and", "to", "no", "part", "season", "cour",
  "في", "من", "على", "الجزء", "الموسم",
]);

/** Whole-title similarity (0..1). Strict on purpose: fuzzy token coverage
 * would happily merge "Solo Leveling" with "Solo Leveling Ragnarok". Combines
 * a stopword-insensitive token overlap with a whole-string edit ratio. */
export function strictTitleScore(a: string, b: string): number {
  const na = mangaTitleKey(a);
  const nb = mangaTitleKey(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const tokensA = na.split(" ").filter((token) => token && !TITLE_STOPWORDS.has(token));
  const tokensB = nb.split(" ").filter((token) => token && !TITLE_STOPWORDS.has(token));
  let jaccard = 0;
  if (tokensA.length && tokensB.length) {
    const setB = new Set(tokensB);
    let intersection = 0;
    for (const token of tokensA) if (setB.has(token)) intersection++;
    jaccard = intersection / (tokensA.length + tokensB.length - intersection);
  }

  const maxLength = Math.max(na.length, nb.length);
  const cap = Math.ceil(maxLength * 0.2);
  const distance = levenshtein(na, nb, cap);
  // A capped distance means the titles are further apart than the cap; the
  // ratio would be a floor, not a similarity — treat it as no signal.
  const ratio = distance > cap ? 0 : 1 - distance / maxLength;
  return Math.max(jaccard, ratio);
}

const MATCH_THRESHOLD = 0.88;

// ── card merge ───────────────────────────────────────────────────────────────

function cardScore(card: MangaCard): number {
  return (
    (card.cover ? 2 : 0) +
    (card.latest ? 1 : 0) +
    (card.rating ? 1 : 0) +
    (card.status ? 1 : 0) +
    (card.type ? 1 : 0)
  );
}

function higherLatest(a: string | null | undefined, b: string | null | undefined): string | null {
  const na = latestNumber(a);
  const nb = latestNumber(b);
  if (na !== nb) return na > nb ? a ?? null : b ?? null;
  return a ?? b ?? null;
}

/** Dedupe cards by normalized title: the richest card wins the identity
 * (cover/latest/rating/status) and, on a tie, the best-page-quality source.
 * The loser still fills any field the winner lacks, and the newest chapter
 * label always survives so a rail never shows a stale "latest". */
export function mergeCards(cards: MangaCard[]): MangaCard[] {
  const byKey = new Map<string, MangaCard>();
  for (const card of cards) {
    const key = mangaTitleKey(card.title);
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, card);
      continue;
    }
    const next = cardScore(card);
    const current = cardScore(existing);
    const winner =
      next > current || (next === current && sourceRank(card.source) < sourceRank(existing.source))
        ? card
        : existing;
    const loser = winner === card ? existing : card;
    const cover = winner.cover ?? loser.cover ?? null;
    const coverAlts = [...new Set([winner.cover, ...(winner.coverAlts ?? []), loser.cover, ...(loser.coverAlts ?? [])])]
      .filter((url): url is string => !!url && url !== cover);
    byKey.set(key, {
      ...winner,
      cover,
      ...(coverAlts.length ? { coverAlts } : {}),
      latest: higherLatest(winner.latest, loser.latest),
      rating: winner.rating ?? loser.rating ?? null,
      status: winner.status ?? loser.status ?? null,
      type: winner.type ?? loser.type ?? null,
    });
  }
  return [...byKey.values()];
}

function interleave(lists: MangaCard[][]): MangaCard[] {
  const out: MangaCard[] = [];
  const longest = lists.reduce((max, list) => Math.max(max, list.length), 0);
  for (let i = 0; i < longest; i++) {
    for (const list of lists) if (list[i]) out.push(list[i]);
  }
  return out;
}

// ── home merge ───────────────────────────────────────────────────────────────

interface HomeEntry {
  source: MangaSourceId;
  home: MangaHome;
}

const SECTION_TITLES: Record<string, string> = {
  latest: "أحدث الفصول",
  popular: "الأكثر قراءة",
  new: "مانجا جديدة",
  completed: "مكتملة",
  "popular-today": "شائع اليوم",
};

const SECTION_ORDER = ["latest", "popular", "new", "completed", "popular-today"];

/** Union every source's rails into one feed. "أحدث الفصول" is re-sorted by the
 * latest chapter number; ranked rails interleave sources so no source dominates
 * the top; the rest keep source order. Titles dedupe across rails too. */
export function mergeHomes(entries: HomeEntry[]): MangaHome {
  const featured: MangaCard[] = [];
  const sectionItems = new Map<string, MangaCard[][]>();
  const sectionKind = new Map<string, MangaHomeSection["kind"]>();

  for (const { home } of entries) {
    featured.push(...home.featured);
    for (const section of home.sections) {
      if (!sectionItems.has(section.id)) {
        sectionItems.set(section.id, []);
        sectionKind.set(section.id, section.kind);
      }
      sectionItems.get(section.id)!.push(section.items);
    }
  }

  const ids = [
    ...SECTION_ORDER.filter((id) => sectionItems.has(id)),
    ...[...sectionItems.keys()].filter((id) => !SECTION_ORDER.includes(id)),
  ];

  const sections: MangaHomeSection[] = ids.map((id) => {
    const lists = sectionItems.get(id)!;
    const kind = sectionKind.get(id) ?? "grid";
    let items: MangaCard[];
    if (id === "latest") {
      items = mergeCards(lists.flat()).sort((a, b) => latestNumber(b.latest) - latestNumber(a.latest));
    } else if (kind === "ranked") {
      items = mergeCards(interleave(lists));
    } else {
      items = mergeCards(lists.flat());
    }
    return { id, title: SECTION_TITLES[id] ?? id, kind, items };
  });

  return { featured: mergeCards(featured).slice(0, 6), sections };
}

const mergedHomeCache = createRequestCache<MangaHome>(10 * 60_000);

/** All sources in parallel; `onPartial` re-emits the merged home the moment a
 * source answers so the hub paints progressively. */
export function fetchMergedHome(
  options: { force?: boolean; onPartial?: (home: MangaHome) => void } = {},
): Promise<MangaHome> {
  return mergedHomeCache.run(
    "merged-home",
    async () => {
      const entries: HomeEntry[] = [];
      await Promise.all(
        COMBINED_SOURCES.map(async (source) => {
          try {
            const home = await fetchMangaHome(source, { force: options.force });
            entries.push({ source, home });
            options.onPartial?.(mergeHomes(entries));
          } catch {
            // a dead source must not kill the feed
          }
        }),
      );
      if (!entries.length) throw new Error("manga: no source answered");
      return mergeHomes(entries);
    },
    { force: options.force },
  );
}

/** Instant first paint from the per-source disk caches. */
export async function readCachedMergedHome(): Promise<MangaHome | null> {
  const entries = (
    await Promise.all(
      COMBINED_SOURCES.map(async (source) => {
        const home = await readCachedMangaHome(source);
        return home ? { source, home } : null;
      }),
    )
  ).filter((entry): entry is HomeEntry => entry !== null);
  return entries.length ? mergeHomes(entries) : null;
}

// ── search + browse ──────────────────────────────────────────────────────────

export type MangaTypeFilter = "مانجا" | "مانهوا" | "مانها" | null;
export type MangaStatusFilter = "مستمر" | "مكتمل" | "معلق" | null;

export interface MangaFilters {
  type: MangaTypeFilter;
  status: MangaStatusFilter;
  sort: MangaSort;
}

const TYPE_ALIASES: Record<string, string> = {
  manga: "مانجا",
  manhwa: "مانهوا",
  manhua: "مانها",
  novel: "رواية",
};

function normalizeTypeLabel(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim().replace(/ة$/, "");
  return TYPE_ALIASES[value.toLowerCase()] ?? value;
}

const STATUS_ALIASES: Record<string, string> = {
  ongoing: "مستمر",
  "on going": "مستمر",
  completed: "مكتمل",
  complete: "مكتمل",
  finished: "مكتمل",
  hiatus: "معلق",
  "on hold": "معلق",
};

function normalizeStatusLabel(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim().replace(/ة$/, "");
  return STATUS_ALIASES[value.toLowerCase()] ?? value;
}

/** Filters apply to what each card exposes: a card with no type/status is kept
 * (unknown ≠ excluded) so one source's missing metadata never hides a work. */
export function filterMangaCards(cards: MangaCard[], filters: MangaFilters): MangaCard[] {
  let out = cards;
  if (filters.type) {
    out = out.filter((card) => !card.type || normalizeTypeLabel(card.type) === filters.type);
  }
  if (filters.status) {
    out = out.filter((card) => !card.status || normalizeStatusLabel(card.status) === filters.status);
  }
  if (filters.sort === "latest") {
    out = [...out].sort((a, b) => latestNumber(b.latest) - latestNumber(a.latest));
  } else if (filters.sort === "title") {
    out = [...out].sort((a, b) => a.title.localeCompare(b.title, "ar"));
  }
  return out;
}

/** Combined search: every source in parallel, merged/deduped by title and
 * streamed via `onPartial`. Source names never surface in the result. */
export async function searchMergedManga(
  query: string,
  options?: MangaFilterOptions,
  onPartial?: (cards: MangaCard[]) => void,
): Promise<MangaCard[]> {
  const q = query.trim();
  if (!q) return [];
  const collected: MangaCard[] = [];
  const results = () => mergeCards(collected).sort((a, b) => strictTitleScore(q, b.title) - strictTitleScore(q, a.title));
  // Home cards remain searchable when a source's search is temporarily down.
  // Genre membership is only known by the source, so don't bypass that filter.
  if ((options?.page ?? 1) === 1 && !options?.genres?.length) {
    const home = await readCachedMergedHome();
    if (home) {
      const known = [...home.featured, ...home.sections.flatMap(section => section.items)];
      collected.push(...known.filter(card => fuzzyScore(q, card.title) >= 0.8));
      if (collected.length) onPartial?.(results());
    }
  }
  await Promise.all(
    COMBINED_SOURCES.map(async (source) => {
      try {
        const selections = options?.genres?.length ? options.genres : [null];
        await Promise.all(selections.map(async (genre) => {
          // OR between genres, AND with the title/type/status on every request.
          const items = await searchManga(source, q, { ...options, genres: genre ? [genre] : [] });
          if (!items.length) return;
          collected.push(...items);
          onPartial?.(results());
        }));
      } catch {
        // degrade quietly — the other sources still answer
      }
    }),
  );
  return results();
}

/** Combined genre browse for one page. */
export async function browseMergedGenre(
  label: string,
  page: number,
  options?: MangaFilterOptions,
  onPartial?: (cards: MangaCard[]) => void,
): Promise<MangaCard[]> {
  const collected: MangaCard[] = [];
  await Promise.all(
    COMBINED_SOURCES.map(async (source) => {
      try {
        const items = await browseMangaGenre(source, label, page, options);
        if (!items.length) return;
        collected.push(...items);
        onPartial?.(mergeCards(collected));
      } catch {
        // degrade quietly
      }
    }),
  );
  return mergeCards(collected);
}

/** Combined whole-catalog browse (empty query + filters only). */
export async function browseMergedAll(
  page: number,
  options?: MangaFilterOptions,
  onPartial?: (cards: MangaCard[]) => void,
): Promise<MangaCard[]> {
  const collected: MangaCard[] = [];
  await Promise.all(
    COMBINED_SOURCES.map(async (source) => {
      try {
        const items = await browseMangaAll(source, page, options);
        if (!items.length) return;
        collected.push(...items);
        onPartial?.(mergeCards(collected));
      } catch {
        // degrade quietly
      }
    }),
  );
  return mergeCards(collected);
}

// ── detail merge ─────────────────────────────────────────────────────────────

interface DetailEntry {
  source: MangaSourceId;
  detail: MangaDetail;
}

export function mergeDetails(entries: DetailEntry[]): MergedMangaDetail {
  const primary = entries[0].detail;
  const ordered = [...entries].sort((a, b) => sourceRank(a.source) - sourceRank(b.source));

  const byKey = new Map<string, MergedChapter>();
  for (const { source, detail } of ordered) {
    for (const chapter of detail.chapters) {
      const key = chapterNumberKey(chapter.number) || `id:${source}:${chapter.id}`;
      const existing = byKey.get(key);
      if (existing) {
        // Keep the lower-ranked copies: a source can serve a chapter whose
        // images were never uploaded (3asq 404s), and the reader needs a way out.
        if (existing.source !== source) (existing.alternates ??= []).push({ source, mangaId: detail.id, id: chapter.id });
        continue;
      }
      byKey.set(key, { ...chapter, source, mangaId: detail.id });
    }
  }
  const chapters = [...byKey.values()].sort(
    (a, b) => chapterSortValue(b.number) - chapterSortValue(a.number),
  );

  const fill = ordered.find((entry) => entry.detail.synopsis)?.detail ?? primary;
  const genres = primary.genres.length ? primary.genres : fill.genres;

  return {
    ...primary,
    synopsis: primary.synopsis ?? fill.synopsis ?? null,
    cover: primary.cover ?? fill.cover ?? null,
    genres,
    author: primary.author ?? fill.author ?? null,
    year: primary.year ?? fill.year ?? null,
    rating: primary.rating ?? fill.rating ?? null,
    status: primary.status ?? fill.status ?? null,
    type: primary.type ?? fill.type ?? null,
    latest: chapters.length ? `الفصل ${chapters[0].number}` : primary.latest ?? null,
    chapters,
    sources: ordered.map((entry) => entry.source),
  };
}

/** Find the same work on another source: search its own catalog (the title,
 * its normalized spelling, then a meaningful word), keep the candidate whose
 * whole-title similarity clears the strict threshold. */
async function findMatch(source: MangaSourceId, title: string): Promise<MangaCard | null> {
  let best: { card: MangaCard; score: number } | null = null;
  for (const query of sourceSearchQueries(title, 3)) {
    const results = await withTimeout(searchManga(source, query), 9_000, []);
    for (const card of results) {
      const score = strictTitleScore(title, card.title);
      if (!best || score > best.score) best = { card, score };
    }
    if (best && best.score >= 0.99) break;
  }
  return best && best.score >= MATCH_THRESHOLD ? best.card : null;
}

const mergedDetailCache = createRequestCache<MergedMangaDetail>(10 * 60_000);
// Old merged metadata could combine the original and colored chapter lists.
const MERGED_DETAIL_PREFIX = "manga_merged_detail_v2:";
const SWR_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function readSwr(key: string): Promise<MergedMangaDetail | null> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { ts?: number; value?: MergedMangaDetail };
    if (!parsed?.ts || Date.now() - parsed.ts > SWR_TTL_MS || !parsed.value?.chapters) return null;
    return parsed.value;
  } catch {
    return null;
  }
}

function writeSwr(key: string, value: MergedMangaDetail): void {
  void AsyncStorage.setItem(key, JSON.stringify({ ts: Date.now(), value })).catch(() => {});
}

export function readCachedMergedDetail(
  source: MangaSourceId,
  id: string,
): Promise<MergedMangaDetail | null> {
  return readSwr(`${MERGED_DETAIL_PREFIX}${source}|${id}`);
}

/**
 * Detail with chapters merged across every matching source. `onUpdate` fires
 * twice when a merge is possible: once with the anchor source's chapters (so
 * the screen paints immediately) and once with the completed union.
 */
export function fetchMergedDetail(
  source: MangaSourceId,
  id: string,
  options: { force?: boolean; onUpdate?: (detail: MergedMangaDetail) => void } = {},
): Promise<MergedMangaDetail> {
  return mergedDetailCache.run(
    `${source}|${id}`,
    async () => {
      const primary = await fetchMangaDetail(source, id, { force: options.force });
      const anchor = mergeDetails([{ source, detail: primary }]);
      options.onUpdate?.(anchor);

      const others = COMBINED_SOURCES.filter((candidate) => candidate !== source);
      const matches = await Promise.all(
        others.map(async (candidate): Promise<DetailEntry | null> => {
          try {
            const card = await findMatch(candidate, primary.title);
            if (!card) return null;
            const detail = await fetchMangaDetail(candidate, card.id);
            return { source: candidate, detail };
          } catch {
            return null;
          }
        }),
      );
      const entries = [
        { source, detail: primary },
        ...matches.filter((entry): entry is DetailEntry => entry !== null),
      ];
      const merged = entries.length > 1 ? mergeDetails(entries) : anchor;
      writeSwr(`${MERGED_DETAIL_PREFIX}${source}|${id}`, merged);
      if (entries.length > 1) options.onUpdate?.(merged);
      return merged;
    },
    { force: options.force },
  );
}

/** Drop merged caches for a work (error retry paths). */
export function invalidateMergedDetail(source: MangaSourceId, id: string): void {
  mergedDetailCache.delete(`${source}|${id}`);
}
