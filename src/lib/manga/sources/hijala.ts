// Hijala (الحجالة) manga source adapter — https://hijala.org
//
// 2026-11-13: Hijala moved off its old WordPress site (hijala.com, now locked
// behind an interactive Cloudflare Turnstile the hidden WebView can't pass) to
// a new Next.js app on hijala.org — no challenge, a JSON API, and the same
// series slugs, so saved favorites/history keep working.
//
// Endpoints (verified live 2026-11-13):
//   /api/series/search?q=&genre=Any&status=Any&type=Any&sort=Latest+Chapters
//     → { series: [{ id: slug, title, image, type, genre: "A, B", rating,
//          status, views, chapters: [latest 6 { id, num: "Chapter 62" }] }] }
//     The WHOLE filtered catalog in one response (~310 works); genre/status/
//     type filter server-side (English names), sort "A-Z" = title order.
//   /api/home/popular?timeframe=Weekly → { popular: [{ id, title, image, ... }] }
//   /series/{slug}            SSR; the RSC payload holds the series object
//                             (synopsis, genre[], author, full chapter list)
//   /series/{slug}/chapter-N  SSR; RSC `pageKeys` = ordered page image keys
//                             under /hijala-cdn/ (no hot-link protection)
//
// IDs: manga id = slug; chapter id = chapter number ("62", "41.2"). Old
// hijala.com chapter ids (`{slug}-{n}` or URLs) are still accepted.

import { fetchMangaHtml, fetchMangaRawText } from "../fetch";
import { hijalaGenreName } from "../genres";
import { joinColumnPages } from "../columns";
import type {
  MangaCard,
  MangaChapterInfo,
  MangaDetail,
  MangaFilterOptions,
  MangaHome,
  MangaHomeSection,
  MangaReaderData,
  MangaSource,
} from "../types";

export const HIJALA_SITE = "https://hijala.org";
const SITE = HIJALA_SITE;
const CDN = `${SITE}/hijala-cdn/`;
/** Every Next.js RSC page carries this — a valid SSR response, not a wall. */
const RSC_MARKER = "self.__next_f";
/** Client-side page size over the one-shot catalog response. */
export const HIJALA_PAGE_SIZE = 30;

const TYPE_LABELS: Record<string, string> = {
  manga: "مانجا",
  manhwa: "مانهوا",
  manhua: "مانها",
};

const TYPE_PARAMS: Record<string, string> = {
  مانجا: "Manga",
  مانهوا: "Manhwa",
  مانها: "Manhua",
};

const STATUS_LABELS: Record<string, string> = {
  ongoing: "مستمر",
  completed: "مكتمل",
  complete: "مكتمل",
  hiatus: "معلق",
  "on hold": "معلق",
};

const STATUS_PARAMS: Record<string, string> = {
  مستمر: "Ongoing",
  مكتمل: "Completed",
  معلق: "Hiatus",
};

// ── helpers ──────────────────────────────────────────────────────────────────

function str(value: unknown): string | null {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value !== "string") return null;
  const s = value.trim();
  // The site renders missing fields as an em dash ("author": "—").
  return s && !/^[-—–]+$/.test(s) ? s : null;
}

/** Unrated works come back as 0 — no rating, not a zero score. */
function rating(value: unknown): string | null {
  const s = str(value);
  const n = s ? Number(s) : NaN;
  return Number.isFinite(n) && n > 0 ? String(Math.round(n * 10) / 10) : null;
}

function normalizeType(raw: unknown): string | null {
  const s = str(raw);
  return s ? TYPE_LABELS[s.toLowerCase()] ?? s : null;
}

function normalizeStatus(raw: unknown): string | null {
  const s = str(raw);
  return s ? STATUS_LABELS[s.toLowerCase()] ?? s : null;
}

/** "Chapter 62" / "62" / "41.2" → "41.2". */
function chapterNum(raw: unknown): string | null {
  const m = /(\d+(?:\.\d+)?)/.exec(str(raw) ?? "");
  return m ? m[1] : null;
}

function latestLabel(raw: unknown): string | null {
  const n = chapterNum(raw);
  return n ? `الفصل ${n}` : null;
}

function cdnUrl(raw: unknown): string | null {
  const s = str(raw);
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s.replace(/^http:\/\//i, "https://");
  return CDN + s.replace(/^\/+/, "").replace(/^hijala-cdn\//, "");
}

/** Series slug from a bare slug or a hijala.org / legacy hijala.com URL. */
export function hijalaSlug(id: string): string | null {
  let path = id.trim();
  if (!path) return null;
  if (/^https?:/i.test(path)) {
    try {
      const url = new URL(path);
      if (!/(^|\.)hijala\.(org|com)$/i.test(url.hostname)) return null;
      path = url.pathname;
    } catch {
      return null;
    }
  }
  const parts = path.replace(/[?#].*$/, "").split("/").filter(Boolean);
  const first = parts[0] === "series" ? parts[1] : parts[0];
  if (!first) return null;
  try {
    return decodeURIComponent(first);
  } catch {
    return first;
  }
}

/** Chapter number from any chapter id we ever produced: "62", "chapter-62",
 * legacy hijala.com slugs "{slug}-62" / "{slug}-41-2", or full URLs. */
export function hijalaChapterNum(chapterId: string, mangaId?: string): string | null {
  let id = chapterId.trim().replace(/[?#].*$/, "").replace(/\/+$/, "");
  if (/^https?:/i.test(id)) id = id.split("/").pop() ?? "";
  try {
    id = decodeURIComponent(id);
  } catch {
    // keep raw
  }
  if (/^\d+(?:\.\d+)?$/.test(id)) return id;
  const chapter = /^chapter-(\d+(?:[.-]\d+)?)$/i.exec(id);
  if (chapter) return chapter[1].replace("-", ".");
  const slug = mangaId ? hijalaSlug(mangaId) : null;
  if (slug && id.startsWith(`${slug}-`)) {
    const rest = id.slice(slug.length + 1);
    const m = /^(\d+)(?:[.-](\d+))?$/.exec(rest);
    if (m) return m[2] ? `${m[1]}.${m[2]}` : m[1];
  }
  const tail = /(\d+(?:\.\d+)?)$/.exec(id);
  return tail ? tail[1] : null;
}

export function hijalaChapterUrl(mangaId: string, chapterId: string): string | null {
  const slug = hijalaSlug(mangaId);
  const num = hijalaChapterNum(chapterId, mangaId);
  return slug && num ? `${SITE}/series/${encodeURIComponent(slug)}/chapter-${num}` : null;
}

/** Concatenated, unescaped Next.js flight payload (`self.__next_f.push`). */
export function rscPayload(html: string): string {
  let all = "";
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)) {
    try {
      all += JSON.parse(`"${m[1]}"`) as string;
    } catch {
      // a malformed chunk only loses its own slice
    }
  }
  return all;
}

/** The smallest JSON object enclosing the first occurrence of `key`. String
 * contents are skipped so braces inside synopses don't unbalance the scan. */
export function enclosingObject(payload: string, key: string): Record<string, unknown> | null {
  const at = payload.indexOf(key);
  if (at < 0) return null;
  // Candidate starts walking backwards; the first one that parses as an object
  // spanning past `key` wins.
  for (let start = payload.lastIndexOf("{", at); start >= 0; start = payload.lastIndexOf("{", start - 1)) {
    const end = objectEnd(payload, start);
    if (end > at) {
      try {
        const value = JSON.parse(payload.slice(start, end)) as unknown;
        if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
      } catch {
        // not a real object boundary — keep walking out
      }
    }
    if (at - start > 200_000) break;
  }
  return null;
}

function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

// ── pure parsers (offline-testable) ──────────────────────────────────────────

function cardFrom(raw: unknown): MangaCard | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id) ?? str(r.slug);
  const title = str(r.title);
  if (!id || !title || /^\d+$/.test(id) && !str(r.slug)) return null;
  const chapters = Array.isArray(r.chapters) ? r.chapters : [];
  const first = chapters[0] as Record<string, unknown> | undefined;
  return {
    source: "hijala",
    id: str(r.slug) ?? id,
    title,
    cover: cdnUrl(r.image),
    type: normalizeType(r.type),
    status: normalizeStatus(r.status),
    rating: rating(r.rating),
    latest: latestLabel(first?.num),
  };
}

/** `/api/series/search` and `/api/home/popular` bodies → cards. */
export function parseHijalaCards(body: string | null): MangaCard[] {
  if (!body) return [];
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return [];
  }
  const rec = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
  const list = Array.isArray(json) ? json : Array.isArray(rec.series) ? rec.series : Array.isArray(rec.popular) ? rec.popular : [];
  const seen = new Set<string>();
  const out: MangaCard[] = [];
  for (const raw of list) {
    const card = cardFrom(raw);
    if (card && !seen.has(card.id)) {
      seen.add(card.id);
      out.push(card);
    }
  }
  return out;
}

/** Views for the client-side "popular" order (not on MangaCard). */
function viewsById(body: string | null): Map<string, number> {
  const out = new Map<string, number>();
  try {
    const json = JSON.parse(body ?? "") as { series?: { id?: string; views?: number }[] };
    for (const s of json.series ?? []) if (s.id) out.set(s.id, Number(s.views) || 0);
  } catch {
    // no views → keep server order
  }
  return out;
}

export function parseHijalaHome(latestBody: string | null, popularBody: string | null): MangaHome | null {
  const latest = parseHijalaCards(latestBody).slice(0, 24);
  const popular = parseHijalaCards(popularBody);
  const sections: MangaHomeSection[] = [];
  if (latest.length) sections.push({ id: "latest", title: "أحدث الفصول", kind: "latest", items: latest });
  if (popular.length) sections.push({ id: "popular", title: "الأكثر قراءة", kind: "ranked", items: popular });
  if (!sections.length) return null;
  return { featured: (popular.length ? popular : latest).slice(0, 6), sections };
}

/** Series RSC object chapters → newest-first list; locked (paid) chapters are
 * left out — they can't be read, other sources fill those numbers. */
export function parseHijalaChapters(rawChapters: unknown): MangaChapterInfo[] {
  if (!Array.isArray(rawChapters)) return [];
  const out: MangaChapterInfo[] = [];
  const seen = new Set<string>();
  for (const raw of rawChapters) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as Record<string, unknown>;
    if (c.locked === true || (typeof c.coins === "number" && c.coins > 0)) continue;
    const number = chapterNum(c.num);
    if (!number || seen.has(number)) continue;
    seen.add(number);
    out.push({ id: number, number, title: str(c.sub), date: str(c.time) });
  }
  return out.sort((a, b) => Number(b.number) - Number(a.number));
}

export function parseHijalaDetail(html: string, id: string): MangaDetail | null {
  const payload = rscPayload(html);
  const series = enclosingObject(payload, '"synopsis":') ?? enclosingObject(payload, '"totalChapters":');
  if (!series) return null;
  const title = str(series.title);
  if (!title) return null;
  const chapters = parseHijalaChapters(series.chapters);
  const genres = Array.isArray(series.genre)
    ? series.genre.map(str).filter((g): g is string => !!g)
    : (str(series.genre) ?? "").split(",").map((g) => g.trim()).filter(Boolean);
  const year = /((?:19|20)\d{2})/.exec(str(series.released) ?? "")?.[1] ?? null;
  return {
    source: "hijala",
    id: str(series.slug) ?? hijalaSlug(id) ?? id,
    title,
    cover: cdnUrl(series.image),
    type: normalizeType(series.type),
    status: normalizeStatus(series.status),
    rating: rating(series.rating),
    synopsis: str(series.synopsis),
    genres,
    chapters,
    author: str(series.author),
    year,
    latest: chapters.length ? latestLabel(chapters[0].number) : null,
  };
}

/** Reader pages from a chapter page's RSC `pageKeys`. */
export function parseHijalaChapter(html: string): MangaReaderData | null {
  const payload = rscPayload(html);
  const holder = enclosingObject(payload, '"pageKeys":');
  const keys = holder && Array.isArray(holder.pageKeys) ? holder.pageKeys : [];
  const pages: string[] = [];
  for (const key of keys) {
    const url = cdnUrl(key);
    if (url && !pages.includes(url)) pages.push(url);
  }
  if (!pages.length) return null;
  const manga = holder?.manga as Record<string, unknown> | undefined;
  const num = str(holder?.currentChapterNum);
  const title = str(manga?.title);
  // Left/right halves of one page (`01_001` + `01_002`) → one page entry.
  return { pages: joinColumnPages(pages), title: title ? (num ? `${title} ${num}` : title) : null };
}

// ── request builders ─────────────────────────────────────────────────────────

/** `/api/series/search` URL. One genre per request (the UI unions them). */
export function hijalaSearchUrl(query: string, options?: MangaFilterOptions, genre?: string | null): string {
  const params = new URLSearchParams({
    q: query.trim(),
    genre: genre || "Any",
    status: STATUS_PARAMS[options?.status?.trim() ?? ""] ?? "Any",
    type: TYPE_PARAMS[options?.type?.trim() ?? ""] ?? "Any",
    sort: options?.sort === "title" ? "A-Z" : "Latest Chapters",
  });
  return `${SITE}/api/series/search?${params.toString()}`;
}

/** 1-based client-side page over the one-shot catalog. `popular` reorders by
 * views (the API has no popularity sort). */
export function hijalaPage(body: string | null, page: number, popular = false): MangaCard[] {
  let cards = parseHijalaCards(body);
  if (popular) {
    const views = viewsById(body);
    cards = [...cards].sort((a, b) => (views.get(b.id) ?? 0) - (views.get(a.id) ?? 0));
  }
  const start = (Math.max(1, page) - 1) * HIJALA_PAGE_SIZE;
  return cards.slice(start, start + HIJALA_PAGE_SIZE);
}

async function listing(url: string, page: number, popular = false): Promise<MangaCard[]> {
  return hijalaPage(await fetchMangaRawText(url, `${SITE}/series`), page, popular);
}

// ── network ──────────────────────────────────────────────────────────────────

export const hijalaSource: MangaSource = {
  id: "hijala",
  label: "الحجالة",

  async home() {
    const [latest, popular] = await Promise.all([
      fetchMangaRawText(hijalaSearchUrl(""), `${SITE}/`),
      fetchMangaRawText(`${SITE}/api/home/popular?timeframe=Weekly`, `${SITE}/`),
    ]);
    const home = parseHijalaHome(latest, popular);
    if (!home) throw new Error("hijala: home fetch failed");
    return home;
  },

  async search(query, options) {
    const page = options?.page ?? 1;
    const genres = (options?.genres ?? []).map(hijalaGenreName);
    if (genres.length) {
      // A genre this source doesn't carry → no results here, not "everything".
      const known = genres.filter((g): g is string => !!g);
      if (!known.length) return [];
      const lists = await Promise.all(known.map((g) => listing(hijalaSearchUrl(query, options, g), page)));
      const seen = new Set<string>();
      return lists.flat().filter((card) => !seen.has(card.id) && !!seen.add(card.id));
    }
    return listing(hijalaSearchUrl(query, options), page);
  },

  async browseGenre(label, page, options) {
    const genre = hijalaGenreName(label);
    if (!genre) return [];
    return listing(hijalaSearchUrl("", options, genre), page, !options?.sort || options.sort === "default");
  },

  async browseAll(page, options) {
    return listing(hijalaSearchUrl("", options), page, !options?.sort || options.sort === "default");
  },

  async detail(id) {
    const slug = hijalaSlug(id);
    if (!slug) throw new Error(`hijala: bad detail id ${id}`);
    const html = await fetchMangaHtml(`${SITE}/series/${encodeURIComponent(slug)}`, `${SITE}/series`, RSC_MARKER);
    if (!html) throw new Error(`hijala: detail fetch failed for ${id}`);
    const detail = parseHijalaDetail(html, slug);
    if (!detail) throw new Error(`hijala: detail parse found nothing for ${id}`);
    return detail;
  },

  async chapter(mangaId, chapterId) {
    const url = hijalaChapterUrl(mangaId, chapterId);
    if (!url) throw new Error(`hijala: bad chapter ref ${mangaId}/${chapterId}`);
    const html = await fetchMangaHtml(url, url.replace(/\/chapter-[^/]+$/, ""), RSC_MARKER);
    if (!html) throw new Error(`hijala: chapter fetch failed for ${chapterId}`);
    const reader = parseHijalaChapter(html);
    if (!reader) throw new Error(`hijala: no pages parsed for ${chapterId}`);
    return reader;
  },
};
