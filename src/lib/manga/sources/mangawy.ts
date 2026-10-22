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
import { absoluteUrl, attr, decodeEntities, firstMatch, stripTags } from "../html";
import { mangawyGenreLabel } from "../genres";
import { normFuzzy } from "../../fuzzy";
import { withTimeout } from "../../requestCache";
import { fetchMangaHtml, fetchMangaRawText } from "../fetch";

const SITE = "https://mangawy.org";

// ponytail: regex HTML parse — mangawy is Nuxt SSR, so home/detail/chapter all
// ship in the first response; swap for a DOM parser only if the markup churns.

const TYPE_LABELS: Record<string, string> = {
  manga: "مانجا",
  manhwa: "مانهوا",
  manhua: "مانها",
};

const STATUS_LABELS: Record<string, string> = {
  ongoing: "مستمر",
  completed: "مكتمل",
  hiatus: "معلق",
};

// Request-side slugs for the /api/browse endpoint (verified live: type, status,
// genre, sort and page all filter server-side). "oel" has no UI option, so it
// only ever arrives through the client-side filter as an unknown type.
const TYPE_SLUGS: Record<string, string> = {
  مانجا: "manga",
  مانهوا: "manhwa",
  مانها: "manhua",
};

const STATUS_SLUGS: Record<string, string> = {
  مستمر: "ongoing",
  مكتمل: "completed",
  معلق: "hiatus",
};

const SORT_SLUGS: Record<string, string> = {
  latest: "latest",
  title: "title",
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function label(map: Record<string, string>, value: unknown): string | null {
  const key = str(value);
  return key ? map[key.toLowerCase()] ?? null : null;
}

function idFromHref(href: string): string | null {
  const match = /^\/series\/([^"/?#]+)/.exec(href);
  return match ? match[1] : null;
}

interface AnchorChunk {
  href: string;
  tag: string;
  chunk: string;
}

function anchoredChunks(scope: string): AnchorChunk[] {
  const matches = [...scope.matchAll(/<a\s[^>]*href="(\/series\/[^"#?]+)"[^>]*>/g)];
  return matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const next = matches[index + 1];
    const end = next?.index ?? Math.min(scope.length, (match.index ?? 0) + 2500);
    return { href: match[1], tag: match[0], chunk: scope.slice(start, end) };
  });
}

function parseFeatured(html: string): MangaCard[] {
  let start = html.indexOf('<section class="mb-10"');
  if (start < 0) {
    const main = html.indexOf("<main");
    start = html.indexOf("<section", main >= 0 ? main : 0);
  }
  if (start < 0) return [];
  const end = html.indexOf("</section>", start);
  const scope = html.slice(start, end < 0 ? start + 12000 : end);
  const active = scope.indexOf("fh-cover--active");
  // The 2026-10 redesign put a section heading ("اختيار المحرر") above the
  // card, which the first-<h2> read turned into the manga's title. The active
  // cover's alt names the featured work; else the first non-section heading.
  const sectionLabel = attr(firstMatch(scope, /(<section[^>]*>)/) ?? "", "aria-label");
  const activeAlt = active >= 0 ? stripTags(attr(firstMatch(scope.slice(active, active + 1200), /(<img[^>]+)>/) ?? "", "alt") ?? "") : "";
  const heading = [...scope.matchAll(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/g)]
    .map((m) => stripTags(m[1]))
    .find((text) => text && text !== sectionLabel && text !== "اختيار المحرر");
  const title = activeAlt || heading || "";
  const href = firstMatch(scope, /href="(\/series\/[^"#?]+)"/);
  const id = href ? idFromHref(href) : null;
  if (!title || !id) return [];
  const cover =
    active >= 0
      ? absoluteUrl(firstMatch(scope.slice(active, active + 1200), /<img[^>]*src="([^"]+)"/), SITE)
      : null;
  const status = stripTags(firstMatch(scope, /bg-emerald-400\/10[^"]*"[^>]*>([^<]+)</) ?? "");
  return [{ source: "mangawy", id, title, cover, status: status || null }];
}

function parsePopular(html: string): MangaCard[] {
  const start = html.indexOf("الأكثر قراءة اليوم");
  if (start < 0) return [];
  const next = html.indexOf("الأكثر متابعة", start);
  const scope = html.slice(start, next > start ? next : start + 40000);
  const cards: MangaCard[] = [];
  const seen = new Set<string>();
  for (const { href, tag, chunk } of anchoredChunks(scope)) {
    if (!tag.includes("group relative flex flex-col gap-2")) continue;
    const id = idFromHref(href);
    if (!id || seen.has(id)) continue;
    const image = firstMatch(chunk, /(<img[^>]+)>/) ?? "";
    const title =
      stripTags(firstMatch(chunk, /<h3[^>]*>([\s\S]*?)<\/h3>/) ?? "") || stripTags(attr(image, "alt") ?? "");
    if (!title) continue;
    seen.add(id);
    cards.push({
      source: "mangawy",
      id,
      title,
      cover: absoluteUrl(attr(image, "src"), SITE),
      type: firstMatch(chunk, />\s*(مانهوا|مانجا|مانها)\s*</) ?? null,
    });
  }
  return cards;
}

function parseLatest(html: string): MangaCard[] {
  const start = html.indexOf("reka-tabs-v-0-1-0-content-hot");
  if (start < 0) return [];
  const next = html.indexOf("reka-tabs-v-0-1-0-content-new", start);
  const scope = html.slice(start, next > start ? next : start + 40000);
  const cards: MangaCard[] = [];
  const seen = new Set<string>();
  for (const chunk of scope.split(/<div class="group flex h-full gap-3/).slice(1)) {
    const href = firstMatch(chunk, /href="(\/series\/[^"#?]+)"/);
    const id = href ? idFromHref(href) : null;
    if (!id || seen.has(id)) continue;
    const title = stripTags(firstMatch(chunk, /<h3[^>]*>([\s\S]*?)<\/h3>/) ?? "");
    if (!title) continue;
    const image = firstMatch(chunk, /(<img[^>]+)>/) ?? "";
    const number = stripTags(firstMatch(chunk, /<span[^>]*>\s*الفصل\s*([^<]*?)\s*<\/span>/) ?? "");
    seen.add(id);
    cards.push({
      source: "mangawy",
      id,
      title,
      cover: absoluteUrl(attr(image, "src"), SITE),
      type: firstMatch(chunk, />\s*(مانهوا|مانجا|مانها)\s*</) ?? null,
      latest: number ? `الفصل ${number}` : null,
    });
  }
  return cards;
}

function parseCompleted(html: string): MangaCard[] {
  const marker = html.indexOf("مكتمل حديثاً");
  if (marker < 0) return [];
  const scope = html.slice(marker, marker + 20000);
  const cards: MangaCard[] = [];
  const seen = new Set<string>();
  for (const { href, tag, chunk } of anchoredChunks(scope)) {
    if (!tag.includes("group flex min-h-16")) continue;
    const id = idFromHref(href);
    if (!id || seen.has(id)) continue;
    const title = stripTags(firstMatch(chunk, /<p class="text-sm font-bold[^"]*">([\s\S]*?)<\/p>/) ?? "");
    if (!title) continue;
    seen.add(id);
    cards.push({
      source: "mangawy",
      id,
      title,
      cover: absoluteUrl(attr(firstMatch(chunk, /(<img[^>]+)>/) ?? "", "src"), SITE),
    });
  }
  return cards;
}

// Current layout (verified 2026-10-21): each rail is an <h2> heading followed by
// cards that are `<a href="/series/<slug>">` with an <img alt> cover, an <h3>
// title, a type tag and "N فصل"; update cards also link `/chapter/<n>-<id>`.
// The 2026-10 redesign dropped every class the older parsers keyed on, which
// silently emptied the popular + latest rails (44 series on the page, 7
// parsed). Scope by heading and read structure, not utility classes.
function parseHeadingRail(html: string, heading: string, withLatest: boolean): MangaCard[] {
  const h = html.search(new RegExp(`<h2[^>]*>\\s*${heading}\\s*<\\/h2>`));
  if (h < 0) return [];
  const next = html.indexOf("<h2", h + 4);
  const scope = html.slice(h, next > h ? next : h + 60000);
  const order: string[] = [];
  const chunks = new Map<string, string>();
  for (const { href, chunk } of anchoredChunks(scope)) {
    const id = idFromHref(href);
    if (!id || href.includes("/chapter/")) continue;
    if (!chunks.has(id)) order.push(id);
    chunks.set(id, (chunks.get(id) ?? "") + chunk);
  }
  const cards: MangaCard[] = [];
  for (const id of order) {
    const chunk = chunks.get(id)!;
    const image = firstMatch(chunk, /(<img[^>]+)>/) ?? "";
    const title = stripTags(firstMatch(chunk, /<h3[^>]*>([\s\S]*?)<\/h3>/) ?? "") || stripTags(attr(image, "alt") ?? "");
    if (!title) continue;
    const chapter = firstMatch(chunk, new RegExp(`/series/${id}/chapter/(\\d+(?:\\.\\d+)?)-`)) ?? firstMatch(chunk, /(\d+(?:\.\d+)?)\s*فصل/);
    cards.push({
      source: "mangawy",
      id,
      title,
      cover: absoluteUrl(attr(image, "src"), SITE),
      type: firstMatch(chunk, />\s*(مانهوا|مانجا|مانها)\s*</) ?? null,
      ...(withLatest ? { latest: chapter ? `الفصل ${chapter}` : null } : {}),
    });
  }
  return cards;
}

export function parseMangawyHome(html: string): MangaHome | null {
  const featured = parseFeatured(html);
  const sections: MangaHomeSection[] = [];
  const railPopular = parseHeadingRail(html, "الأكثر قراءة اليوم", false);
  const popular = railPopular.length ? railPopular : parsePopular(html);
  if (popular.length) sections.push({ id: "popular", title: "الأكثر قراءة اليوم", kind: "ranked", items: popular });
  const railLatest = parseHeadingRail(html, "آخر التحديثات", true);
  const latest = railLatest.length ? railLatest : parseLatest(html);
  if (latest.length) sections.push({ id: "latest", title: "آخر الفصول", kind: "latest", items: latest });
  const completed = parseCompleted(html);
  if (completed.length) sections.push({ id: "completed", title: "مكتمل حديثاً", kind: "grid", items: completed });
  if (!featured.length && !sections.length) return null;
  return { featured, sections };
}

/** Map `/api/series/search` + `/api/browse` series entries to cards. Both
 * endpoints share the shape; `chapter_count` becomes the latest label. */
function seriesItemCards(items: unknown[]): MangaCard[] {
  const cards: MangaCard[] = [];
  for (const raw of items) {
    const item = record(raw);
    if (!item) continue;
    const id = str(item.slug);
    const title = str(item.title) ?? str(item.title_ar);
    if (!id || !title) continue;
    const count = Number(item.chapter_count);
    cards.push({
      source: "mangawy",
      id,
      title,
      cover: absoluteUrl(str(item.cover_url), SITE),
      type: label(TYPE_LABELS, item.type),
      status: label(STATUS_LABELS, item.status),
      latest: Number.isFinite(count) && count > 0 ? `الفصل ${count}` : null,
    });
  }
  return cards;
}

export function parseMangawySearch(body: string): MangaCard[] {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return [];
  }
  return Array.isArray(data) ? seriesItemCards(data) : [];
}

/** Browse listing from `/api/browse` — `{ items: [...] }` with server-side
 * type/status/genre/sort/page filters (unlike the HTML page, whose cards carry
 * no type at all). */
export function parseMangawyBrowse(body: string): MangaCard[] {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return [];
  }
  const items = record(data)?.items;
  return Array.isArray(items) ? seriesItemCards(items) : [];
}

export function parseMangawyDetail(html: string, id: string): MangaDetail | null {
  const title = stripTags(firstMatch(html, /<h1[^>]*>([\s\S]*?)<\/h1>/) ?? "");
  if (!title) return null;
  const meta = firstMatch(html, /(<meta[^>]*property="og:image"[^>]*>)/);
  const cover = absoluteUrl(
    (meta ? attr(meta, "content") : null) ??
      firstMatch(html, /<img[^>]*src="(https:\/\/img\.mangawy\.org\/covers\/[^"]+)"/),
    SITE,
  );
  const genres: string[] = [];
  for (const match of html.matchAll(/<a[^>]*href="\/browse\?genre=[^"]*"[^>]*>([^<]+)<\/a>/g)) {
    const genre = stripTags(match[1]);
    if (genre && !genres.includes(genre)) genres.push(genre);
  }
  const chapters: MangaChapterInfo[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(
    /<a\s[^>]*href="\/series\/[^"/]+\/chapter\/([^"/?#]+)"[^>]*>([\s\S]*?)<\/a>/g,
  )) {
    const chapterId = stripTags(match[1]);
    if (!chapterId || seen.has(chapterId)) continue;
    seen.add(chapterId);
    const body = match[2];
    const number =
      stripTags(firstMatch(body, />\s*ف\.\s*([^<]+)</) ?? "") ||
      firstMatch(body, /Chapter\s+([0-9]+(?:\.[0-9]+)?)/) ||
      chapterId;
    const chapterTitle = stripTags(firstMatch(body, /truncate text-sm font-medium[^"]*">([^<]*)</) ?? "");
    const date = stripTags(firstMatch(body, /lucide-calendar[\s\S]*?<\/svg>\s*([^<]*)</) ?? "");
    chapters.push({ id: chapterId, number, title: chapterTitle || null, date: date || null });
  }
  const rating = stripTags(firstMatch(html, /تقييم السلسلة، المتوسط\s+([0-9.]+)/) ?? "");
  const synopsis = stripTags(firstMatch(html, /<div id="series-description"[^>]*>([\s\S]*?)<\/div>/) ?? "");
  const year = firstMatch(html, /<span class="[^"]*rounded-full[^"]*">\s*((?:19|20)\d{2})\s*<\/span>/) ?? null;
  return {
    source: "mangawy",
    id,
    title,
    cover,
    type: firstMatch(html, /<span class="[^"]*rounded-full[^"]*">\s*(مانهوا|مانجا|مانها)\s*<\/span>/) ?? null,
    status:
      firstMatch(html, /w-2 h-2 rounded-full"><\/div>\s*<span class="font-medium text-foreground">([^<]+)<\/span>/) ??
      null,
    rating: rating || null,
    synopsis: synopsis || null,
    genres,
    chapters,
    year,
    latest: chapters.length ? `الفصل ${chapters[0].number}` : null,
  };
}

export function parseMangawyChapter(html: string, base: string): MangaReaderData | null {
  // SSR payloads can escape slashes; preserve query strings (signed image URLs).
  const normalized = html.replace(/\\u002f/gi, "/").replace(/\\\//g, "/");
  const pages = new Map<string, { url: string; page: number | null; variant: number }>();
  for (const match of normalized.matchAll(/((?:https?:\/\/)?img\.mangawy\.org\/published\/[^"'\s\\<>]+)/gi)) {
    const raw = decodeEntities(match[1]);
    const url = absoluteUrl(raw.startsWith("http") ? raw : `https://${raw}`, base);
    if (!url || /\/covers?\//i.test(url)) continue;
    const parsed = new URL(url);
    const numbered = /\/(\d+)_(\d+)\.(?:webp|jpe?g|png)$/i.exec(parsed.pathname);
    const key = numbered ? `${parsed.origin}${parsed.pathname.replace(/_\d+(\.[^.]+)$/, "$1")}` : url;
    const variant = numbered ? Number(numbered[2]) : 0;
    const existing = pages.get(key);
    if (existing && existing.variant <= variant) continue;
    pages.set(key, { url, page: numbered ? Number(numbered[1]) : null, variant });
  }
  const entries = [...pages.values()];
  // With mixed filenames keep the source order; never drop the unnumbered pages.
  if (entries.every((entry) => entry.page !== null)) entries.sort((a, b) => a.page! - b.page!);
  return entries.length ? { pages: entries.map((entry) => entry.url) } : null;
}

/** Query string for `/api/browse` (1-based page). */
function browseQuery(page: number, genreLabel: string | null, options?: MangaFilterOptions): string {
  const params = [`page=${page}`];
  if (genreLabel) params.push(`genre=${encodeURIComponent(genreLabel)}`);
  const type = options?.type ? TYPE_SLUGS[options.type] : undefined;
  if (type) params.push(`type=${type}`);
  const status = options?.status ? STATUS_SLUGS[options.status] : undefined;
  if (status) params.push(`status=${status}`);
  const sort = options?.sort ? SORT_SLUGS[options.sort] : undefined;
  if (sort) params.push(`sort=${sort}`);
  return params.join("&");
}

export const mangawySource: MangaSource = {
  id: "mangawy",
  label: "مانجاوي",

  async home(): Promise<MangaHome> {
    const html = await fetchMangaHtml(`${SITE}/`, undefined, "series/");
    const home = html ? parseMangawyHome(html) : null;
    if (!home) throw new Error("mangawy: home fetch or parse failed");
    return home;
  },

  async search(query: string, options?: MangaFilterOptions): Promise<MangaCard[]> {
    const q = query.trim();
    if (!q || (options?.page ?? 1) > 1) return [];
    try {
      // The shared fetcher also recovers JSON through browser verification.
      const body = await fetchMangaRawText(`${SITE}/api/series/search?q=${encodeURIComponent(q)}`);
      const cards = body ? parseMangawySearch(body) : [];
      if (!options?.genres?.length) return cards;
      const wanted = options.genres.map((genre) => normFuzzy(mangawyGenreLabel(genre)));
      const matches: MangaCard[] = [];
      const batch = await Promise.all(cards.map(async (card) => {
          const detail = await withTimeout(mangawySource.detail(card.id).catch(() => null), 6000, null);
          return detail?.genres.some((genre) => wanted.includes(normFuzzy(genre))) ? detail : null;
        }));
      matches.push(...batch.filter((card): card is MangaDetail => card !== null));
      return matches;
    } catch {
      return [];
    }
  },

  async browseGenre(label: string, page: number, options?: MangaFilterOptions): Promise<MangaCard[]> {
    // /api/browse filters genre/type/status/sort/page server-side (the /browse
    // HTML page ignores type, which is why the filter used to look dead).
    const body = await fetchMangaRawText(
      `${SITE}/api/browse?${browseQuery(page, mangawyGenreLabel(label), options)}`,
      `${SITE}/`,
    );
    return body ? parseMangawyBrowse(body) : [];
  },

  async browseAll(page: number, options?: MangaFilterOptions): Promise<MangaCard[]> {
    const body = await fetchMangaRawText(`${SITE}/api/browse?${browseQuery(page, null, options)}`, `${SITE}/`);
    return body ? parseMangawyBrowse(body) : [];
  },

  async detail(id: string): Promise<MangaDetail> {
    const html = await fetchMangaHtml(`${SITE}/series/${encodeURIComponent(id)}`, undefined, "chapter/");
    const detail = html ? parseMangawyDetail(html, id) : null;
    if (!detail) throw new Error(`mangawy: detail fetch or parse failed for ${id}`);
    return detail;
  },

  async chapter(mangaId: string, chapterId: string): Promise<MangaReaderData> {
    const url = `${SITE}/series/${encodeURIComponent(mangaId)}/chapter/${encodeURIComponent(chapterId)}`;
    const html = await fetchMangaHtml(url, `${SITE}/series/${encodeURIComponent(mangaId)}`, "img.mangawy.org");
    const reader = html ? parseMangawyChapter(html, url) : null;
    if (!reader) throw new Error(`mangawy: chapter fetch or parse failed for ${mangaId}/${chapterId}`);
    return reader;
  },
};
