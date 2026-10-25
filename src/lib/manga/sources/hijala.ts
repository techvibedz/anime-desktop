// Hijala (الحجالة) manga source adapter — https://hijala.com
//
// WordPress + the Themesia "MangaReader" theme (not Madara): `.bsx` cover
// cards, a `#chapterlist` `<li data-num>` list on the series page, and the
// reader's images server-rendered inside `#readerarea`'s <noscript>. Every
// page ships complete to a plain GET (no Cloudflare as of 2026-10-25), and
// the REST API doesn't expose the manga post type (wp/v2/manga 404), so HTML
// parsing covers all entry points. fetchMangaHtml still falls back to the
// hidden WebView if a challenge ever appears.
//
// Permalinks live at the site root: series `/{slug}/`, chapters
// `/{slug}-{n}/`. IDs are those slugs, so URLs rebuild from the id alone.
//
// Catalog is small (~320 works, mostly manhwa) — the point of this source is
// filling chapter gaps in works the bigger sources also carry; the aggregator
// unions chapters by number, so it never duplicates a work.
//
// Listing endpoints, verified live:
//   /?s=q (10/page, /page/N/?s=q)  — plain title search
//   /manga/?title=&status=&type=&genre[]=&order=&page=N (5/page) — filtered
//   `genre[]` takes the site's numeric term ids and ANDs multiple values, so
//   one id per request (lib/manga/genres.ts `hijala`).

import { fetchMangaHtml } from "../fetch";
import { hijalaGenreIds } from "../genres";
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

const SITE = "https://hijala.com";
const MARKER = "hijala";

const TYPE_LABELS: Record<string, string> = {
  manga: "مانجا",
  manhwa: "مانهوا",
  manhua: "مانها",
};

const TYPE_SLUGS: Record<string, string> = {
  مانجا: "manga",
  مانهوا: "manhwa",
  مانها: "manhua",
};

const STATUS_LABELS: Record<string, string> = {
  ongoing: "مستمر",
  completed: "مكتمل",
  complete: "مكتمل",
  hiatus: "معلق",
  "on hold": "معلق",
};

const STATUS_SLUGS: Record<string, string> = {
  مستمر: "ongoing",
  مكتمل: "completed",
  معلق: "hiatus",
};

/** Root-level paths that are site pages, not series. */
const RESERVED = new Set([
  "manga", "genres", "page", "blog", "bookmark", "call-us", "wp-content", "wp-admin",
  "wp-json", "feed", "tag", "category", "author", "test",
]);

// ── helpers ──────────────────────────────────────────────────────────────────

function region(html: string, from: string, to?: string): string {
  const start = html.indexOf(from);
  if (start < 0) return "";
  const rest = html.slice(start);
  if (to) {
    const end = rest.indexOf(to, from.length);
    if (end >= 0) return rest.slice(0, end);
  }
  return rest;
}

function firstTag(html: string, tag: string): string | null {
  const m = new RegExp(`<${tag}\\b[^>]*>`, "i").exec(html);
  return m ? m[0] : null;
}

function imgUrl(tag: string | null): string | null {
  if (!tag) return null;
  for (const name of ["data-src", "data-lazy-src", "src"]) {
    const raw = attr(tag, name)?.trim();
    const url = raw && !/^data:/i.test(raw) ? absoluteUrl(raw, SITE) : null;
    if (url) return https(url);
  }
  return null;
}

/** Series/chapter slug from an absolute or relative URL (or a bare slug). */
export function hijalaSlug(id: string): string | null {
  let path = id.trim();
  try {
    if (/^https?:/i.test(path)) {
      const url = new URL(path);
      if (!/(^|\.)hijala\.com$/i.test(url.hostname)) return null;
      path = url.pathname;
    }
  } catch {
    return null;
  }
  const first = path.replace(/[?#].*$/, "").split("/").filter(Boolean)[0];
  if (!first) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(first);
  } catch {
    slug = first;
  }
  return RESERVED.has(slug.toLowerCase()) ? null : slug;
}

function normalizeType(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  return s ? TYPE_LABELS[s.toLowerCase()] ?? s : null;
}

function normalizeStatus(raw: string | null | undefined): string | null {
  const s = stripTags(raw ?? "");
  return s ? STATUS_LABELS[s.toLowerCase()] ?? s : null;
}

/** "فصل 154" / "الفصل.  35" / "14" → "الفصل 154". */
function latestLabel(raw: string | null | undefined): string | null {
  const n = firstMatch(stripTags(raw ?? ""), /([\d٠-٩]+(?:\.[\d٠-٩]+)?)/);
  return n ? `الفصل ${n}` : null;
}

// ── pure parsers (offline-testable) ──────────────────────────────────────────

/** Every `.bsx` cover card in a page fragment (home rails, search, listing). */
export function parseHijalaCards(html: string): MangaCard[] {
  const out: MangaCard[] = [];
  const seen = new Set<string>();
  for (const chunk of html.split(/<div class="bsx">/).slice(1)) {
    const a = firstTag(chunk, "a");
    const id = hijalaSlug(attr(a ?? "", "href") ?? "");
    if (!id || seen.has(id)) continue;
    const img = firstTag(chunk, "img");
    const title = stripTags(
      attr(a ?? "", "title") ||
        firstMatch(chunk, /<div class="tt">([\s\S]*?)<\/div>/i) ||
        attr(img ?? "", "alt") ||
        "",
    );
    if (!title) continue;
    seen.add(id);
    out.push({
      source: "hijala",
      id,
      title,
      cover: imgUrl(img),
      type: normalizeType(firstMatch(chunk, /<span class="type ([^"]+)"/i)),
      rating: firstMatch(chunk, /<div class="numscore">\s*([\d.]+)/i),
      latest: latestLabel(
        firstMatch(chunk, /<div class="epxs">([\s\S]*?)<\/div>/i) ??
          firstMatch(chunk, /<span class="fivchap">([\s\S]*?)<\/span>/i),
      ),
    });
  }
  return out;
}

export function parseHijalaHome(html: string): MangaHome | null {
  // "الأعمال الرائجة" slider — scoped to the next section box.
  const popular = parseHijalaCards(region(html, "popularslider", 'class="bixbox'));
  // "أحدث الإصدارات" = the `styletere` latest-update cards.
  const latest = parseHijalaCards(
    html
      .split(/<div class="bs styletere[^"]*">/)
      .slice(1)
      .map((chunk) => chunk.slice(0, chunk.indexOf("</ul>") + 5))
      .join(""),
  );
  const sections: MangaHomeSection[] = [];
  if (latest.length) sections.push({ id: "latest", title: "أحدث الفصول", kind: "latest", items: latest });
  if (popular.length) sections.push({ id: "popular", title: "الأكثر قراءة", kind: "ranked", items: popular });
  if (!sections.length) return null;
  return { featured: (popular.length ? popular : latest).slice(0, 6), sections };
}

/** `#chapterlist` rows, newest-first as served. */
export function parseHijalaChapters(html: string): MangaChapterInfo[] {
  // Bounded to the list itself — the footer menu is <li> links too.
  const list = region(html, 'id="chapterlist"', "</ul>");
  const out: MangaChapterInfo[] = [];
  const seen = new Set<string>();
  for (const m of list.matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/gi)) {
    const block = m[2];
    const id = hijalaSlug(attr(firstTag(block, "a") ?? "", "href") ?? "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const label = stripTags(firstMatch(block, /<span class="chapternum">([\s\S]*?)<\/span>/i) ?? "");
    const dataNum = attr(m[1], "data-num")?.trim();
    const number = dataNum || firstMatch(label, /([\d.]+)/) || label || id;
    out.push({
      id,
      number,
      title: null,
      date: stripTags(firstMatch(block, /<span class="chapterdate">([\s\S]*?)<\/span>/i) ?? "") || null,
    });
  }
  return out;
}

function infoValue(html: string, label: string): string | null {
  const m = new RegExp(`<div class="imptdt">\\s*${label}\\s*([\\s\\S]*?)<\\/div>`, "i").exec(html);
  const value = m ? stripTags(m[1]) : "";
  return value && value !== "-" ? value : null;
}

export function parseHijalaDetail(html: string, id: string): MangaDetail | null {
  const title = stripTags(firstMatch(html, /<h1 class="entry-title"[^>]*>([\s\S]*?)<\/h1>/i) ?? "");
  if (!title) return null;
  const chapters = parseHijalaChapters(html);
  const synopsis = stripTags(
    firstMatch(html, /<div class="entry-content entry-content-single"[^>]*>([\s\S]*?)<\/div>/i) ?? "",
  );
  const genres = [...region(html, '<span class="mgen">', "</span>").matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((m) => stripTags(m[1]))
    .filter(Boolean);
  const year = firstMatch(infoValue(html, "سنة الإصدار") ?? infoValue(html, "سنة النشر") ?? "", /((?:19|20)\d{2})/);
  return {
    source: "hijala",
    id: hijalaSlug(id) ?? id,
    title,
    cover: imgUrl(firstTag(region(html, 'class="thumb"'), "img")),
    type: normalizeType(infoValue(html, "النوع")),
    status: normalizeStatus(infoValue(html, "الحالة")),
    rating: firstMatch(html, /itemprop="ratingValue"[^>]*content="([\d.]+)"/i),
    synopsis: synopsis || null,
    genres,
    chapters,
    author: infoValue(html, "المؤلف"),
    year,
    latest: chapters.length ? latestLabel(chapters[0].number) : null,
  };
}

/** Older uploads are linked as http:// — Android blocks cleartext, and the
 * host serves the same files over https. */
function https(url: string): string {
  return url.replace(/^http:\/\/((?:[\w-]+\.)*hijala\.com)\//i, "https://$1/");
}

/** Reader pages: `#readerarea` images (the server-rendered <noscript> copy),
 * falling back to a `ts_reader.run({... "images": [...]})` payload. */
export function parseHijalaChapter(html: string, base: string): MangaReaderData | null {
  const pages: string[] = [];
  const area = region(html, 'id="readerarea"', 'id="readerarea-loading"');
  for (const m of area.matchAll(/<img\b[^>]*>/gi)) {
    const raw = chapterImageUrl(m[0], base || SITE);
    const url = raw ? https(raw) : null;
    if (url && !/\/themes\//.test(url) && !pages.includes(url)) pages.push(url);
  }
  if (!pages.length) {
    const json = firstMatch(html, /"images"\s*:\s*(\[[^\]]*\])/);
    if (json) {
      try {
        for (const raw of JSON.parse(json) as unknown[]) {
          const abs = typeof raw === "string" ? absoluteUrl(raw, base || SITE) : null;
          const url = abs ? https(abs) : null;
          if (url && !pages.includes(url)) pages.push(url);
        }
      } catch {
        // malformed payload — no pages
      }
    }
  }
  if (!pages.length) return null;
  const title = stripTags(firstMatch(html, /<h1 class="entry-title"[^>]*>([\s\S]*?)<\/h1>/i) ?? "");
  return { pages, title: title || null };
}

// ── request builders ─────────────────────────────────────────────────────────

/** `/manga/` filtered listing URL (5 cards a page). */
export function hijalaListingUrl(
  options: MangaFilterOptions | undefined,
  page: number,
  extra: { title?: string; genreId?: number } = {},
): string {
  const params: string[] = [];
  if (extra.title) params.push(`title=${encodeURIComponent(extra.title)}`);
  if (extra.genreId) params.push(`genre%5B%5D=${extra.genreId}`);
  const status = STATUS_SLUGS[options?.status?.trim() ?? ""];
  if (status) params.push(`status=${status}`);
  const type = TYPE_SLUGS[options?.type?.trim() ?? ""];
  if (type) params.push(`type=${type}`);
  const order = options?.sort === "title" ? "title" : options?.sort === "latest" ? "update" : extra.title ? "" : "popular";
  if (order) params.push(`order=${order}`);
  if (page > 1) params.push(`page=${page}`);
  return `${SITE}/manga/${params.length ? `?${params.join("&")}` : ""}`;
}

function hasServerFilters(options: MangaFilterOptions | undefined): boolean {
  return !!(STATUS_SLUGS[options?.status?.trim() ?? ""] || TYPE_SLUGS[options?.type?.trim() ?? ""]);
}

/** `directOnly`: WordPress 404s search pages past the last one — that is the
 * end of the results, not a challenge worth a 28s WebView render. */
async function listing(url: string, directOnly = false): Promise<MangaCard[]> {
  const html = directOnly
    ? ((await window.pantoufa.fetchHtml?.(url, `${SITE}/`, { attempts: 2, timeoutMs: 8000 }).catch(() => null)) ?? null)
    : await fetchMangaHtml(url, `${SITE}/`, MARKER);
  return html ? parseHijalaCards(region(html, 'class="listupd"') || html) : [];
}

/** One request per genre term id (the site ANDs `genre[]`), merged in order. */
async function genreListing(
  label: string,
  page: number,
  options: MangaFilterOptions | undefined,
  title?: string,
): Promise<MangaCard[]> {
  const ids = hijalaGenreIds(label);
  if (!ids.length) return [];
  const lists = await Promise.all(
    ids.map((genreId) => listing(hijalaListingUrl(options, page, { title, genreId })).catch(() => [])),
  );
  const seen = new Set<string>();
  return lists.flat().filter((card) => !seen.has(card.id) && !!seen.add(card.id));
}

// ── network ──────────────────────────────────────────────────────────────────

export const hijalaSource: MangaSource = {
  id: "hijala",
  label: "الحجالة",

  async home() {
    const html = await fetchMangaHtml(`${SITE}/`, `${SITE}/`, MARKER);
    if (!html) throw new Error("hijala: home fetch failed");
    const home = parseHijalaHome(html);
    if (!home) throw new Error("hijala: home parse found no manga");
    return home;
  },

  async search(query, options) {
    const q = query.trim();
    const page = options?.page ?? 1;
    const genres = options?.genres ?? [];
    if (genres.length) {
      return (await Promise.all(genres.map((g) => genreListing(g, page, options, q)))).flat();
    }
    if (hasServerFilters(options) || options?.sort === "title") {
      return listing(hijalaListingUrl(options, page, { title: q }));
    }
    if (page > 1) return listing(`${SITE}/page/${page}/?s=${encodeURIComponent(q)}`, true);
    return listing(`${SITE}/?s=${encodeURIComponent(q)}`);
  },

  async browseGenre(label, page, options) {
    return genreListing(label, page, options);
  },

  async browseAll(page, options) {
    return listing(hijalaListingUrl(options, page));
  },

  async detail(id) {
    const slug = hijalaSlug(id);
    if (!slug) throw new Error(`hijala: bad detail id ${id}`);
    const html = await fetchMangaHtml(`${SITE}/${encodeURIComponent(slug)}/`, `${SITE}/`, "chapterlist");
    if (!html) throw new Error(`hijala: detail fetch failed for ${id}`);
    const detail = parseHijalaDetail(html, slug);
    if (!detail) throw new Error(`hijala: detail parse found nothing for ${id}`);
    return detail;
  },

  async chapter(mangaId, chapterId) {
    const slug = hijalaSlug(chapterId);
    if (!slug) throw new Error(`hijala: bad chapter ref ${mangaId}/${chapterId}`);
    const url = `${SITE}/${encodeURIComponent(slug)}/`;
    const series = hijalaSlug(mangaId);
    const html = await fetchMangaHtml(url, series ? `${SITE}/${encodeURIComponent(series)}/` : `${SITE}/`, "readerarea");
    if (!html) throw new Error(`hijala: chapter fetch failed for ${chapterId}`);
    const reader = parseHijalaChapter(html, url);
    if (!reader) throw new Error(`hijala: no pages parsed for ${chapterId}`);
    return reader;
  },
};
