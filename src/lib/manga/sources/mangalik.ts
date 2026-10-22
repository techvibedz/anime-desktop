// Mangalik (مانجا ليك) manga source adapter — https://lekmanga.site
// (moved from mangalik.net 2026-10-22: the old domain now serves an empty
// LiteSpeed "Index of /"; slugs and markup carried over unchanged).
//
// WordPress + Madara (same theme family as 3asq), but every page this adapter
// needs ships fully server-rendered to a plain GET: the home/listing loops
// (`page-item-detail manga` cards), the series page (metadata blocks + the
// complete chapter list inline in `.listing-chapters_wrap`), and the reader
// (`.reading-content` with direct `wp-manga-chapter-img` srcs). No AJAX, no
// JSON API (wp/v2 doesn't expose `wp-manga` — verified 404), so HTML parsing
// covers all four entry points. fetchMangaHtml (direct GET → hidden-WebView
// fallback) handles Cloudflare.
//
// IDs: manga id = slug (`roxana`), chapter id = numeric/segment path (`3`);
// both rebuild URLs from id alone: /manga/{slug}/ and /manga/{slug}/{chapter}/.

import { fetchMangaHtml } from "../fetch";
import { madaraSearchPath } from "../madara";
import { mangalikGenreSlug } from "../genres";
import { absoluteUrl, attr, chapterImageUrl, decodeEntities, firstMatch, stripTags } from "../html";
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

const SITE = "https://lekmanga.site";

const TYPE_LABELS: Record<string, string> = {
  manga: "مانجا",
  manhwa: "مانهوا",
  manhua: "مانها",
};

const STATUS_LABELS: Record<string, string> = {
  ongoing: "مستمر",
  "on going": "مستمر",
  "on-going": "مستمر",
  completed: "مكتمل",
  complete: "مكتمل",
  finished: "مكتمل",
  hiatus: "معلق",
  "on hold": "معلق",
};

const ARABIC_STATUS: Record<string, string> = {
  مستمرة: "مستمر",
  مكتملة: "مكتمل",
  معلقة: "معلق",
  متوقفة: "معلق",
};

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
function coverFrom(html: string, marker: string): string | null {
  const img = firstTag(region(html, marker), "img");
  if (!img) return null;
  const raw = (attr(img, "data-src") || attr(img, "src") || "").trim();
  if (!raw || /^data:/i.test(raw)) return null;
  return absoluteUrl(raw, SITE);
}

const ANCHOR_RE = /<a\b[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;

function anchors(html: string): { href: string; text: string }[] {
  const out: { href: string; text: string }[] = [];
  for (const m of html.matchAll(ANCHOR_RE)) out.push({ href: decodeEntities(m[1]), text: stripTags(m[2]) });
  return out;
}

/** First anchor with visible text; optionally preferring links that contain a
 * path fragment (skips badge links, ad anchors, etc.). */
function firstAnchor(html: string, hrefIncludes?: string): { href: string; text: string } | null {
  const list = anchors(html);
  if (hrefIncludes) {
    const preferred = list.find((a) => a.href.includes(hrefIncludes) && a.text);
    if (preferred) return preferred;
  }
  return list.find((a) => a.text) ?? null;
}

/** Manga slug from an absolute or relative series URL (or a bare slug). */
function mangaSlug(id: string): string | null {
  const m = /\/manga\/([^/?#]+)/.exec(id);
  if (m) return decodeURIComponent(m[1]);
  const bare = id.replace(/[/?#].*$/, "").replace(/^\/+|\/+$/g, "").trim();
  return bare ? decodeURIComponent(bare) : null;
}

function chapterIdFromLink(link: string | null): string | null {
  if (!link) return null;
  const m = /\/manga\/[^/?#]+\/([^/?#]+)/.exec(link);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Madara stores junk as "Updating" for empty optional fields. */
function cleanMeta(raw: string | null): string | null {
  const s = raw ? stripTags(raw).trim() : "";
  return !s || /^updating$/i.test(s) ? null : s;
}

function normalizeStatus(raw: string | null): string | null {
  const s = cleanMeta(raw);
  if (!s) return null;
  return ARABIC_STATUS[s] ?? STATUS_LABELS[s.toLowerCase()] ?? s;
}

function normalizeType(raw: string | null): string | null {
  const s = cleanMeta(raw);
  if (!s) return null;
  return TYPE_LABELS[s.toLowerCase()] ?? s;
}

function latestLabel(number: string | null | undefined): string | null {
  const n = (number ?? "").trim();
  return n ? `الفصل ${n}` : null;
}

/** The site's genre taxonomy carries the type words as genre values, so the
 * type filter rides the same `genre[]` param (verified live: `genre[]=مانهوا`
 * returns only manhwa). */
function typeGenre(options: MangaFilterOptions | undefined): string | undefined {
  const type = options?.type?.trim();
  return type === "مانجا" || type === "مانهوا" || type === "مانها" ? type : undefined;
}

/** Value of a Madara `<h5>label</h5>…<div class="summary-content">value</div>`
 * metadata block. */
function metaValue(html: string, label: string): string | null {
  const re = new RegExp(
    `<h5>\\s*${label}\\s*<\\/h5>[\\s\\S]{0,300}?<div class="summary-content">([\\s\\S]*?)<\\/div>`,
    "i",
  );
  const m = re.exec(html);
  return m ? cleanMeta(m[1]) : null;
}

// ── pure parsers (offline-testable) ──────────────────────────────────────────

/** One `.page-item-detail manga` card (home rail, /manga/ listing). */
function parseListingCard(chunk: string): MangaCard | null {
  const href = absoluteUrl(attr(firstTag(region(chunk, "item-thumb"), "a") ?? "", "href"), SITE);
  const id = href ? mangaSlug(href) : null;
  if (!id) return null;
  const title =
    firstAnchor(region(chunk, "post-title", "list-chapter"), "/manga/")?.text ||
    attr(firstTag(chunk, "img") ?? "", "alt")?.trim() ||
    "";
  if (!title || /^(cover|avatar)$/i.test(title)) return null;
  const latest = firstAnchor(region(chunk, "list-chapter"))?.text ?? null;
  return {
    source: "mangalik",
    id,
    title,
    cover: coverFrom(chunk, "item-thumb"),
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

export function parseMangalikHome(
  html: string,
  popularHtml?: string | null,
  newHtml?: string | null,
): MangaHome | null {
  const latest = parseListing(html);
  const popular = popularHtml ? parseListing(popularHtml) : [];
  const fresh = newHtml ? parseListing(newHtml) : [];
  const sections: MangaHomeSection[] = [];
  if (latest.length) sections.push({ id: "latest", title: "أحدث الفصول", kind: "latest", items: latest });
  if (popular.length) sections.push({ id: "popular", title: "الأكثر قراءة", kind: "ranked", items: popular });
  if (fresh.length) sections.push({ id: "new", title: "مانجا جديدة", kind: "grid", items: fresh });
  if (!sections.length) return null;
  // No hero carousel on the live home — backfill featured from the latest rail.
  return { featured: latest.slice(0, 6), sections };
}

export function parseMangalikSearch(html: string): MangaCard[] {
  const out: MangaCard[] = [];
  for (const chunk of html.split(/<div[^>]*class="[^"]*c-tabs-item__content/).slice(1)) {
    const href = absoluteUrl(attr(firstTag(region(chunk, "tab-thumb"), "a") ?? "", "href"), SITE);
    const id = href ? mangaSlug(href) : null;
    if (!id) continue;
    const title =
      firstAnchor(region(chunk, "post-title", "tab-meta"))?.text ||
      firstAnchor(region(chunk, "post-title"))?.text ||
      "";
    if (!title) continue;
    const latest = firstAnchor(region(chunk, "latest-chap"))?.text ?? null;
    out.push({
      source: "mangalik",
      id,
      title,
      cover: coverFrom(chunk, "tab-thumb"),
      status: normalizeStatus(firstMatch(region(chunk, "mg_status"), /summary-content[^>]*>\s*([^<]*)/i)),
      rating: firstMatch(chunk, /total_votes"[^>]*>\s*([\d.]+)/i),
      latest: latestLabel(latest),
    });
  }
  return out;
}

/** Chapter list from a Madara `.wp-manga-chapter` list — order kept exactly as
 * served (the live series page renders newest-first). */
export function parseMangalikChapters(html: string): MangaChapterInfo[] {
  const out: MangaChapterInfo[] = [];
  const itemRe = /<li[^>]*class="[^"]*wp-manga-chapter[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  for (const m of html.matchAll(itemRe)) {
    const block = m[1];
    const a = /<a\b[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!a) continue;
    const link = absoluteUrl(decodeEntities(a[1]), SITE);
    const id = chapterIdFromLink(link);
    if (!id) continue;
    const number = stripTags(a[2]) || id;
    const dateBlock = region(block, "chapter-release-date");
    const date =
      stripTags(firstMatch(dateBlock, /<i[^>]*>([\s\S]*?)<\/i>/i) ?? "") ||
      attr(firstTag(region(dateBlock, "c-new-tag"), "a") ?? "", "title") ||
      null;
    out.push({ id, number, title: null, date });
  }
  return out;
}

export function parseMangalikDetail(html: string, id: string): MangaDetail | null {
  const title = stripTags(
    firstMatch(html, /<div class="post-title[^"]*">[\s\S]*?<h1[^>]*>([\s\S]*?)<\/h1>/i) ?? "",
  );
  if (!title) return null;
  const slug = mangaSlug(id) ?? id;
  const chapters = parseMangalikChapters(html);
  const synopsis =
    firstMatch(html, /description-summary[\s\S]*?<div class="summary__content[^"]*">([\s\S]*?)<\/div>/i) ??
    attr(firstTag(html, "meta[^>]*property=\"og:description\"") ?? "", "content");
  return {
    source: "mangalik",
    id: slug,
    title,
    cover: coverFrom(html, "summary_image"),
    type: normalizeType(metaValue(html, "النوع")),
    status: normalizeStatus(metaValue(html, "الحالة")),
    rating:
      firstMatch(html, /id="averagerate"[^>]*>\s*([\d.]+)/i) ??
      firstMatch(html, /total_votes"[^>]*>\s*([\d.]+)/i),
    synopsis: synopsis ? stripTags(synopsis) : null,
    genres: anchors(region(html, "genres-content", "</div>"))
      .map((a) => a.text)
      .filter(Boolean),
    chapters,
    author:
      cleanMeta(firstMatch(html, /<div class="author-content">([\s\S]*?)<\/div>/i)) ??
      metaValue(html, "المؤلف") ??
      metaValue(html, "الكاتب"),
    year: firstMatch(metaValue(html, "سنة الانتاج") ?? "", /((?:19|20)\d{2})/),
    latest: chapters.length ? latestLabel(chapters[0].number) : null,
  };
}

/** Reader pages from a chapter page: `.reading-content` images only, so the
 * header logo, ad banners and comment avatars never leak in. */
export function parseMangalikChapter(html: string, base: string): MangaReaderData | null {
  const start = html.search(/<div class="reading-content"/i);
  const open = start >= 0 ? start : html.search(/reading-content/i);
  const scope = open >= 0 ? html.slice(open) : html;
  const pages: string[] = [];
  for (const m of scope.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const abs = chapterImageUrl(tag, base || SITE);
    if (!abs) continue;
    const isChapter = /wp-manga-chapter-img/i.test(tag) || /\/data\//i.test(abs);
    if (!isChapter) continue;
    if (abs && !pages.includes(abs)) pages.push(abs);
  }
  if (!pages.length) return null;
  const title = stripTags(firstMatch(html, /<title>([\s\S]*?)<\/title>/i) ?? "");
  return { pages, title: title || null };
}

// ── network ──────────────────────────────────────────────────────────────────

export const mangalikSource: MangaSource = {
  id: "mangalik",
  label: "مانجا ليك",

  async home() {
    const [html, popularHtml, newHtml] = await Promise.all([
      fetchMangaHtml(`${SITE}/`, `${SITE}/`, "wp-manga"),
      fetchMangaHtml(`${SITE}/manga/?m_orderby=views`, `${SITE}/`, "wp-manga"),
      fetchMangaHtml(`${SITE}/manga/?m_orderby=new-manga`, `${SITE}/`, "wp-manga"),
    ]);
    if (!html) throw new Error("mangalik: home fetch failed");
    const home = parseMangalikHome(html, popularHtml, newHtml);
    if (!home) throw new Error("mangalik: home parse found no manga");
    return home;
  },

  async search(query, options) {
    const path = madaraSearchPath(query.trim(), (options?.genres ?? []).map(mangalikGenreSlug), options, options?.page ?? 1, typeGenre(options));
    const html = await fetchMangaHtml(`${SITE}${path}`, `${SITE}/`, "wp-manga");
    return html ? parseMangalikSearch(html) : [];
  },

  async browseGenre(label, page, options) {
    const slug = mangalikGenreSlug(label);
    if (!slug) return [];
    const path = madaraSearchPath("", [slug], options, page, typeGenre(options));
    const html = await fetchMangaHtml(`${SITE}${path}`, `${SITE}/`, "wp-manga");
    return html ? parseMangalikSearch(html) : [];
  },

  async browseAll(page, options) {
    const path = madaraSearchPath("", [], options, page, typeGenre(options));
    const html = await fetchMangaHtml(`${SITE}${path}`, `${SITE}/`, "wp-manga");
    return html ? parseMangalikSearch(html) : [];
  },

  async detail(id) {
    const slug = mangaSlug(id);
    if (!slug) throw new Error(`mangalik: bad detail id ${id}`);
    const url = `${SITE}/manga/${encodeURIComponent(slug)}/`;
    const html = await fetchMangaHtml(url, `${SITE}/`, "wp-manga");
    if (!html) throw new Error(`mangalik: detail fetch failed for ${id}`);
    const detail = parseMangalikDetail(html, slug);
    if (!detail) throw new Error(`mangalik: detail parse found nothing for ${id}`);
    return detail;
  },

  async chapter(mangaId, chapterId) {
    const slug = mangaSlug(mangaId);
    if (!slug || !chapterId) throw new Error(`mangalik: bad chapter ref ${mangaId}/${chapterId}`);
    const url = `${SITE}/manga/${encodeURIComponent(slug)}/${encodeURIComponent(chapterId)}/`;
    const html = await fetchMangaHtml(url, `${SITE}/manga/${encodeURIComponent(slug)}/`, "wp-manga-chapter-img");
    if (!html) throw new Error(`mangalik: chapter fetch failed for ${chapterId}`);
    const reader = parseMangalikChapter(html, url);
    if (!reader) throw new Error(`mangalik: no pages parsed for ${chapterId}`);
    return reader;
  },
};
