// 3asq (مانجا العاشق) manga source adapter.
//
// Live site is WordPress + WP-Manga (Madara). Everything is static HTML served
// to a plain GET — except the manga page's chapter list: Madara no longer
// renders it server-side, the page ships an empty `#manga-chapters-holder` and
// script.js POSTs to `{manga}/ajax/chapters/?t=1` for the list (verified live —
// a GET to that URL returns the normal page, so the POST is required). detail()
// does that one POST with raw fetch (fetchMangaHtml is GET-only); everything
// else goes through fetchMangaHtml (direct GET → hidden-WebView fallback).

import { fetchMangaHtml, postMangaText } from "../fetch";
import { madaraSearchPath } from "../madara";
import { withTimeout } from "../../requestCache";
import { asqGenreSlug } from "../genres";
import { absoluteUrl, attr, chapterImageUrl, decodeEntities, firstMatch, stripTags } from "../html";
import type {
  MangaCard,
  MangaChapterInfo,
  MangaDetail,
  MangaHome,
  MangaHomeSection,
  MangaReaderData,
  MangaSource,
} from "../types";

const BASE = "https://3asq.online";

// ── small extraction helpers ─────────────────────────────────────────────────

/** Slice from a marker to an optional end marker (empty string if absent). */
function region(html: string, from: string, to?: string): string {
  const start = html.indexOf(from);
  if (start < 0) return "";
  const rest = html.slice(start);
  if (to) {
    const end = rest.indexOf(to);
    if (end >= 0) return rest.slice(0, end);
  }
  return rest;
}

function firstTag(html: string, tag: string): string | null {
  const m = new RegExp(`<${tag}\\b[^>]*>`, "i").exec(html);
  return m ? m[0] : null;
}

/** Cover URL from the first img in a scoped region — data-src (lazy) wins,
 * placeholders are skipped, relative URLs are made absolute. */
function coverFrom(html: string, marker: string, base: string): string | null {
  const img = firstTag(region(html, marker), "img");
  if (!img) return null;
  const raw = (attr(img, "data-src") || attr(img, "src") || "").trim();
  if (!raw || /^data:/i.test(raw)) return null;
  return absoluteUrl(raw, base);
}

const ANCHOR_RE = /<a\b[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;

function anchors(html: string): { href: string; text: string }[] {
  const out: { href: string; text: string }[] = [];
  for (const m of html.matchAll(ANCHOR_RE)) out.push({ href: decodeEntities(m[1]), text: stripTags(m[2]) });
  return out;
}

/** First anchor with visible text; optionally preferring links that contain a
 * path fragment (skips badge links to x.com etc.). */
function firstAnchor(html: string, hrefIncludes?: string): { href: string; text: string } | null {
  const list = anchors(html);
  if (hrefIncludes) {
    const preferred = list.find((a) => a.href.includes(hrefIncludes) && a.text);
    if (preferred) return preferred;
  }
  return list.find((a) => a.text) ?? null;
}

function normalizeStatus(raw: string | null): string | null {
  const s = raw ? stripTags(raw).trim() : "";
  return s ? s.replace(/ة$/, "") : null;
}

function latestLabel(number: string | null | undefined): string | null {
  const n = (number ?? "").trim();
  return n ? `الفصل ${n}` : null;
}

// ── pure parsers (offline-testable) ──────────────────────────────────────────

/** One `.page-item-detail manga` card (home "أحدث الفصول", popular listing). */
function parseListingCard(chunk: string): MangaCard | null {
  const href = absoluteUrl(attr(firstTag(region(chunk, "item-thumb"), "a") ?? "", "href"), BASE);
  if (!href) return null;
  const title =
    firstAnchor(region(chunk, "post-title", "list-chapter") || chunk, "/manga/")?.text ||
    attr(firstTag(chunk, "img") ?? "", "alt")?.trim() ||
    "";
  if (!title) return null;
  const latest = firstAnchor(region(chunk, "list-chapter"))?.text ?? null;
  return {
    source: "asq",
    id: href,
    title,
    cover: coverFrom(chunk, "item-thumb", BASE),
    rating: firstMatch(chunk, /total_votes"[^>]*>\s*([\d.]+)/i),
    latest: latestLabel(latest),
  };
}

function parseListing(html: string): MangaCard[] {
  const out: MangaCard[] = [];
  for (const chunk of html.split(/<div class="[^"]*page-item-detail/).slice(1)) {
    const card = parseListingCard(chunk);
    if (card) out.push(card);
  }
  return out;
}

/** "إصدارات الفريق" home carousel — up to 6 cards. */
export function parseAsqFeatured(html: string): MangaCard[] {
  const out: MangaCard[] = [];
  for (const chunk of html.split(/<div class="slider__item[^"]*"/).slice(1)) {
    const href = absoluteUrl(attr(firstTag(region(chunk, "item__wrap"), "a") ?? "", "href"), BASE);
    if (!href) continue;
    const title =
      firstAnchor(region(chunk, "post-title", "chapter-item"), "/manga/")?.text ||
      attr(firstTag(chunk, "img") ?? "", "alt")?.trim() ||
      "";
    if (!title) continue;
    out.push({
      source: "asq",
      id: href,
      title,
      cover: coverFrom(chunk, "slider__thumb", BASE),
      latest: latestLabel(firstAnchor(region(chunk, "chapter-item"))?.text ?? null),
    });
    if (out.length >= 6) break;
  }
  return out;
}

export function parseAsqHome(html: string, popularHtml?: string | null): MangaHome {
  const latest = parseListing(html);
  let featured = parseAsqFeatured(html);
  if (!featured.length) featured = latest.slice(0, 6);
  const popular = popularHtml ? parseListing(popularHtml) : [];
  const sections: MangaHomeSection[] = [];
  if (latest.length) sections.push({ id: "latest", title: "أحدث الفصول", kind: "latest", items: latest });
  if (popular.length) sections.push({ id: "popular", title: "الأكثر مشاهدة", kind: "ranked", items: popular });
  return { featured: featured.slice(0, 6), sections };
}

export function parseAsqSearch(html: string): MangaCard[] {
  const out: MangaCard[] = [];
  for (const chunk of html.split(/<div class="[^"]*c-tabs-item__content/).slice(1)) {
    const href = absoluteUrl(attr(firstTag(region(chunk, "tab-thumb"), "a") ?? "", "href"), BASE);
    if (!href) continue;
    const title =
      firstAnchor(region(chunk, "post-title", "tab-meta"))?.text ||
      firstAnchor(region(chunk, "post-title"))?.text ||
      "";
    if (!title) continue;
    out.push({
      source: "asq",
      id: href,
      title,
      cover: coverFrom(chunk, "tab-thumb", BASE),
      status: normalizeStatus(firstMatch(region(chunk, "mg_status"), /summary-content">\s*([^<]*)/)),
      rating: firstMatch(chunk, /total_votes"[^>]*>\s*([\d.]+)/i),
      latest: latestLabel(firstAnchor(region(chunk, "latest-chap"))?.text ?? null),
    });
  }
  return out;
}

/** Chapter list from a WP-Manga `.wp-manga-chapter` list (the AJAX fragment,
 * or inline markup in a cached page). Order is kept exactly as served. */
export function parseAsqChapters(html: string): MangaChapterInfo[] {
  const out: MangaChapterInfo[] = [];
  const itemRe = /<li[^>]*class="[^"]*wp-manga-chapter[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  for (const m of html.matchAll(itemRe)) {
    const block = m[1];
    const a = /<a\b[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!a) continue;
    const link = absoluteUrl(decodeEntities(a[1]), BASE);
    if (!link) continue;
    const text = stripTags(a[2]);
    let number = (text.split(/\s*[-–—]\s*/)[0] ?? "").trim();
    if (!number) {
      number = decodeURIComponent(link.replace(/\/+$/, "").split("/").pop() ?? "").trim() || text;
    }
    const title = (() => {
      const dashAt = text.search(/\s[-–—]\s/);
      return dashAt > 0 ? text.slice(dashAt).replace(/^[\s\-–—]+/, "").trim() || null : null;
    })();
    const date = firstMatch(block, /timediff[^>]*>([\s\S]*?)<\/span>/i);
    out.push({ id: link, number, title, date: date ? stripTags(date) : null });
  }
  return out;
}

export function parseAsqDetail(html: string, id: string, chaptersHtml?: string | null): MangaDetail {
  const base = id || BASE;
  const synopsis = firstMatch(html, /manga-excerpt[^>]*>([\s\S]*?)<\/div>/i);
  const statusRaw = firstMatch(
    html,
    /<h5>\s*الحالة\s*<\/h5>\s*<\/div>\s*<div class="summary-content">\s*([^<]*)/,
  );
  const typeRaw = firstMatch(
    html,
    /<h5>\s*النوع\s*<\/h5>\s*<\/div>\s*<div class="summary-content">\s*([^<]*)/,
  );
  // The live page renders metadata but loads chapters over AJAX; accept inline
  // `.wp-manga-chapter` markup first (cached/page-rendered variants), then the
  // fetched fragment.
  let chapters = parseAsqChapters(html);
  if (!chapters.length && chaptersHtml) chapters = parseAsqChapters(chaptersHtml);
  return {
    source: "asq",
    id: base,
    title: stripTags(firstMatch(html, /<div class="post-title[^"]*">[\s\S]*?<h1[^>]*>([\s\S]*?)<\/h1>/i) ?? ""),
    cover: coverFrom(html, "summary_image", base),
    type: typeRaw ? stripTags(typeRaw) : null,
    status: normalizeStatus(statusRaw),
    rating:
      firstMatch(html, /id="averagerate"[^>]*>\s*([\d.]+)/i) ??
      firstMatch(html, /total_votes"[^>]*>\s*([\d.]+)/i),
    synopsis: synopsis ? stripTags(synopsis) : null,
    genres: anchors(region(html, "genres-content", "</div>"))
      .map((a) => a.text)
      .filter(Boolean),
    chapters,
    author: firstAnchor(region(html, "author-content", "</div>"))?.text ?? null,
    year: firstMatch(html, /manga-release\/[^"]*"[^>]*>([^<]*)</),
  };
}

/** Reader pages from a chapter page. Scopes to `.reading-content` and only
 * keeps real chapter images (URL shape `/WP-manga/data/` or the chapter-img
 * class) so logos/banners/comment avatars never leak in. */
export function parseAsqChapter(html: string, base: string): MangaReaderData {
  const start = html.search(/reading-content/i);
  const scoped = start >= 0 ? html.slice(start) : html;
  const pages: string[] = [];
  for (const m of scoped.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const abs = chapterImageUrl(tag, base || BASE);
    if (!abs || (!/\/WP-manga\/data\//i.test(abs) && !/wp-manga-chapter-img/i.test(tag))) continue;
    if (abs && !pages.includes(abs)) pages.push(abs);
  }
  return { pages };
}

// ── network ──────────────────────────────────────────────────────────────────

async function fetchAsqChapterPage(base: string, page: number): Promise<string | null> {
  // fetch-json caps at 15s in main; the rendered fallback carries the first
  // chapter page inline anyway, so a stalled POST never holds the detail hostage.
  const html = await postMangaText(`${base}ajax/chapters/?t=${page}`, {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    Accept: "text/html, */*; q=0.01",
    "Accept-Language": "ar,en;q=0.9",
    "X-Requested-With": "XMLHttpRequest",
    Referer: base,
  });
  return html && html.includes("wp-manga-chapter") ? html : null;
}

/** Highest page in the fragment's `.pagination` (1 when unpaginated). */
export function asqChapterPageCount(html: string): number {
  let max = 1;
  for (const m of html.matchAll(/data-page="(\d+)"/g)) max = Math.max(max, Number(m[1]) || 1);
  return Math.min(max, 80);
}

/** 3asq paginates the AJAX chapter list (50 per page, `?t=N`, newest first,
 * verified live 2026-10-22 — One Piece is 12+ pages). Fetch page 1, then the
 * rest a few at a time, and stitch them back in page order. */
async function fetchAsqChapters(mangaUrl: string): Promise<string | null> {
  const base = mangaUrl.endsWith("/") ? mangaUrl : `${mangaUrl}/`;
  const first = await fetchAsqChapterPage(base, 1);
  if (!first) return null;
  const count = asqChapterPageCount(first);
  if (count <= 1) return first;
  const rest: (string | null)[] = new Array(count - 1).fill(null);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, count - 1) }, async () => {
    while (next < count - 1) {
      const i = next++;
      rest[i] = await fetchAsqChapterPage(base, i + 2);
    }
  }));
  return [first, ...rest.filter((html): html is string => !!html)].join("\n");
}

export const asqSource: MangaSource = {
  id: "asq",
  label: "مانجا العاشق",

  async home() {
    // Latest rail is the first paint; the popular rail is capped at 8s so a
    // slow mirror can never block the whole home from rendering.
    const [html, popularHtml] = await Promise.all([
      fetchMangaHtml(`${BASE}/`, `${BASE}/`, "wp-manga"),
      withTimeout(fetchMangaHtml(`${BASE}/manga/?m_orderby=views`, `${BASE}/`, "wp-manga"), 8000, null).catch(() => null),
    ]);
    if (!html) throw new Error("asq: home fetch failed");
    const home = parseAsqHome(html, popularHtml);
    if (!home.featured.length && !home.sections.length) throw new Error("asq: home parse found no manga");
    return home;
  },

  async search(query, options) {
    const slugs = (options?.genres ?? []).map(asqGenreSlug).filter((slug): slug is string => !!slug);
    if (options?.genres?.length && !slugs.length) return [];
    const path = madaraSearchPath(query.trim(), slugs, options, options?.page ?? 1);
    const html = await fetchMangaHtml(`${BASE}${path}`, `${BASE}/`, "wp-manga");
    return html ? parseAsqSearch(html) : [];
  },

  async browseGenre(label, page, options) {
    const slug = asqGenreSlug(label);
    if (!slug) return [];
    const path = madaraSearchPath("", [slug], options, page);
    const html = await fetchMangaHtml(`${BASE}${path}`, `${BASE}/`, "wp-manga");
    return html ? parseAsqSearch(html) : [];
  },

  async browseAll(page, options) {
    const path = madaraSearchPath("", [], options, page);
    const html = await fetchMangaHtml(`${BASE}${path}`, `${BASE}/`, "wp-manga");
    return html ? parseAsqSearch(html) : [];
  },

  async detail(id) {
    const url = absoluteUrl(id, BASE) ?? id;
    const [html, chaptersHtml] = await Promise.all([
      fetchMangaHtml(url, `${BASE}/`, "wp-manga"),
      fetchAsqChapters(url),
    ]);
    if (!html) throw new Error(`asq: detail fetch failed for ${id}`);
    const detail = parseAsqDetail(html, url, chaptersHtml);
    if (!detail.title && !detail.chapters.length) throw new Error(`asq: detail parse found nothing for ${id}`);
    return detail;
  },

  async chapter(mangaId, chapterId) {
    const url = absoluteUrl(chapterId, BASE) ?? chapterId;
    const html = await fetchMangaHtml(url, mangaId || `${BASE}/`, "wp-manga-chapter-img");
    if (!html) throw new Error(`asq: chapter fetch failed for ${chapterId}`);
    const reader = parseAsqChapter(html, url);
    if (!reader.pages.length) throw new Error(`asq: no pages parsed for ${chapterId}`);
    return reader;
  },
};
