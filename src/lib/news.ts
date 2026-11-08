// Anime News feed — scraped straight from MyAnimeList's global news index
// (https://myanimelist.net/news), which lists the LATEST articles across every
// anime, newest-first, ~20 per page (?p=N). This replaces the old Jikan
// per-season aggregation, which could only ever surface news about a handful
// of airing titles and routinely showed weeks-old items as "latest".
//
// Brand safety: two layers drop adult (+18) articles before they are translated
// or displayed — a keyword guard on the English headline (isSafeNews), and a
// subject check (adultNewsIds): the work each headline quotes is looked up on
// AniList (one batched request per index page) and adult / Hentai / Ecchi
// subjects are dropped. Headlines use Japanese titles ("Killing Bites",
// "Yumene Connect"), so the keyword guard alone let most of these through.
//
// Speed: the adult check and the Arabic translation run in parallel, and the
// first page is cached on disk so the screen paints instantly on open
// (getCachedNewsFirstPage) while the fresh feed loads behind it.
//
// Everything user-facing is Arabic: headlines, tag chips and article bodies are
// translated lazily (only the visible page / the opened article) via
// translateToArabic, which caches results on disk.
//
// The article DETAIL (app/news/[id].tsx) wants the full body + inline images +
// trailer embeds. MAL serves the article statically inside
// `<div class="… news-content-body">` — fetchNewsArticle() scrapes it into
// ordered text/image/video blocks and translates every text block, so the whole
// post (trailers included) reads in-app, in Arabic.

import { storage as AsyncStorage } from "./storage";
import { translateToArabic } from "./translate";
import { anilistPost } from "./malInfo";

// Cross-origin fetch lives in the main process; no CORS in the renderer.
function fetchHtml(url: string, referer?: string): Promise<string | null> {
  return (
    window.pantoufa.fetchHtml?.(url, referer).catch(() => null) ?? Promise.resolve(null)
  );
}

const MAL = "https://myanimelist.net";
const PAGE_SIZE = 20; // == MAL index page size, so one app page == one GET

export interface NewsItem {
  /** MAL news post id — stable list key + de-dupe. */
  id: number;
  /** Headline, translated to Arabic (the NSFW guard runs on the English original first). */
  title: string;
  url: string;
  /** ISO timestamp of publication. */
  date: string;
  image: string | null;
  /** MAL tag chips ("Preview · Fall 2026"), translated to Arabic. */
  tags: string;
  comments: number;
}

/* ── NSFW guard ─────────────────────────────────────────────────
 * Keyword net over the English headline — MAL's editorial news feed rarely
 * covers adult titles, but when it does (eroge/18+ announcements) the post
 * never reaches the screen. Exported + self-tested (see bottom). */
const NSFW_RE = /(\bhentai\b|\becchi\b|\bnsfw\b|18\s*\+|\br-?18\b|\beroge\b|\bporn\b|\bdoujinshi?\b|\badult (?:game|visual novel)\b)/i;

export function isSafeNews(title: string): boolean {
  return !NSFW_RE.test(title);
}

/* ── Adult-subject filter ───────────────────────
 * MAL headlines quote the work they're about ('Killing Bites', 'Hagure Idol:
 * Jigoku-hen'). All quoted titles of an index page are searched on AniList in
 * ONE batched GraphQL request (~0.5s); for each title the most popular entry
 * whose romaji/english/synonym EXACTLY matches decides — isAdult or a
 * Hentai/Ecchi genre drops the article. Exact + most-popular matching avoids
 * false hits on lookalike titles ('Magi' vs an adult 'Magi Magic').
 * Verdicts are permanent per post, so they're cached on disk; network failures
 * fail OPEN (not cached) so an AniList outage can't empty the feed — the
 * headline keyword guard still applies. */

const BLOCKED_GENRES = ["Hentai", "Ecchi"];
const VERDICT_KEY = "news-adult-verdicts-v2";
const VERDICT_MAX = 600;
let verdicts: Record<string, 0 | 1> | null = null;

async function loadVerdicts(): Promise<Record<string, 0 | 1>> {
  if (verdicts) return verdicts;
  try { verdicts = JSON.parse((await AsyncStorage.getItem(VERDICT_KEY)) || "{}") || {}; }
  catch { verdicts = {}; }
  return verdicts!;
}
function saveVerdicts(): void {
  if (!verdicts) return;
  const keys = Object.keys(verdicts);
  if (keys.length > VERDICT_MAX) {
    // Keep the newest posts (MAL ids grow over time).
    const keep = keys.sort((a, b) => Number(b) - Number(a)).slice(0, VERDICT_MAX);
    verdicts = Object.fromEntries(keep.map((k) => [k, verdicts![k]]));
  }
  AsyncStorage.setItem(VERDICT_KEY, JSON.stringify(verdicts)).catch(() => {});
}

/** Exported for the self-check: the work titles a headline quotes ('…'). */
export function quotedTitles(headline: string): string[] {
  const out: string[] = [];
  const re = /['‘’]([^'‘’]{2,80})['‘’]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(headline)) && out.length < 2) out.push(m[1].trim());
  return out;
}

const normTitle = (s: string | null | undefined) =>
  (s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "");

interface AlMedia {
  isAdult: boolean;
  genres: string[] | null;
  popularity: number | null;
  synonyms: string[] | null;
  title: { romaji: string | null; english: string | null } | null;
}

/** Returns the set of ids judged adult, or null when AniList couldn't answer. */
async function anilistAdultCheck(queries: { id: number; q: string }[]): Promise<Set<number> | null> {
  if (!queries.length) return new Set();
  const vars: Record<string, string> = {};
  const decl: string[] = [];
  const body: string[] = [];
  queries.forEach((x, i) => {
    vars[`q${i}`] = x.q;
    decl.push(`$q${i}:String`);
    body.push(`r${i}:Page(perPage:6){media(search:$q${i}){isAdult genres popularity synonyms title{romaji english}}}`);
  });
  const query = `query(${decl.join(",")}){${body.join(" ")}}`;
  try {
    // Main-process POST (DoH, no CORS); capped so the feed never waits long on AniList.
    const j = await Promise.race([
      anilistPost(query, vars),
      new Promise<null>((r) => setTimeout(() => r(null), 8000)),
    ]);
    if (!j?.data) return null;
    const bad = new Set<number>();
    queries.forEach((x, i) => {
      const want = normTitle(x.q);
      const media: AlMedia[] = j.data[`r${i}`]?.media || [];
      const best = media
        .filter((m) => [m.title?.romaji, m.title?.english, ...(m.synonyms || [])].some((s) => normTitle(s) === want))
        .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))[0];
      if (best && (best.isAdult || (best.genres || []).some((g) => BLOCKED_GENRES.includes(g)))) bad.add(x.id);
    });
    return bad;
  } catch {
    return null;
  }
}

/**
 * Ids of articles whose subject is adult content. `titles` are the ENGLISH
 * headlines (captured before translation mutates the items).
 */
async function adultNewsIds(titles: { id: number; title: string }[]): Promise<Set<number>> {
  const v = await loadVerdicts();
  const pending = titles.filter((n) => v[n.id] === undefined);
  if (pending.length) {
    const queries = pending.flatMap((n) => quotedTitles(n.title).map((q) => ({ id: n.id, q })));
    const bad = await anilistAdultCheck(queries);
    if (bad) {
      for (const n of pending) v[n.id] = bad.has(n.id) ? 1 : 0;
      saveVerdicts();
    }
  }
  return new Set(titles.filter((n) => v[n.id] === 1).map((n) => n.id));
}

/* ── HTML helpers ─────────────────────────────── */

const ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#039;": "'",
  "&#39;": "'", "&apos;": "'", "&nbsp;": " ", "&mdash;": "—", "&ndash;": "–", "&hellip;": "…",
};
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? e);
}
function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

// MAL thumbnails are served resized (cdn…/r/130x130/….jpeg?s=sig) — strip the
// resize prefix + signature so the card shows the full-resolution image.
function malFullImg(u: string): string {
  return u.replace(/\/r\/\d+x\d+/, "").replace(/\?s=.*$/, "");
}

// MAL index dates look like "Jul 15, 2:48 AM" (no year for the current year).
// ponytail: parsed in DEVICE time while MAL shows US-Pacific — a few hours of
// skew on "time ago" labels; sorting is unaffected since the skew is uniform.
const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
function parseMalDate(s: string): string {
  const m = s.trim().match(/^([A-Za-z]{3})\.?\s+(\d{1,2}),?\s+(?:(\d{4}),?\s+)?(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return "";
  const year = m[3] ? Number(m[3]) : new Date().getFullYear();
  const hour = (Number(m[4]) % 12) + (m[6].toUpperCase() === "PM" ? 12 : 0);
  const d = new Date(year, MONTHS[m[1].slice(0, 3).toLowerCase()] ?? 0, Number(m[2]), hour, Number(m[5]));
  // At the year boundary a December post parsed in January lands in the
  // future — roll it back a year.
  if (!m[3] && d.getTime() - Date.now() > 24 * 3600 * 1000) d.setFullYear(d.getFullYear() - 1);
  return d.toISOString();
}

/* ── News index (the feed) ──────────────────────
 * The whole feed is the MAL index itself: globally newest-first. Index pages
 * are fetched on demand as the user scrolls; only the visible slice is
 * translated so first paint isn't gated on translating everything. */

// Flat id→item registry so the detail screen can render an item the list
// already fetched, without re-scraping the index or passing objects via params.
const registry = new Map<number, NewsItem>();

/** Concurrency-capped map — keeps fetch/translation bursts polite. */
async function mapLimit<T>(arr: T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async () => { while (i < arr.length) await fn(arr[i++]); };
  await Promise.all(Array.from({ length: Math.min(limit, arr.length) }, worker));
}

export function getNewsItem(id: number): NewsItem | undefined {
  return registry.get(id);
}

// Parse one MAL news index page. Scoped to the main list (everything before
// the pagination bar) — the "New Anime" rail below it is DB additions, not news.
function parseNewsIndex(html: string): NewsItem[] {
  const cut = html.indexOf('class="pagination');
  const scope = cut > 0 ? html.slice(0, cut) : html;
  const out: NewsItem[] = [];
  const blocks = scope.split('<div class="box-unit3">');
  for (let i = 1; i < blocks.length; i++) {
    const b = blocks[i];
    const hm = b.match(/href="https:\/\/myanimelist\.net\/news\/(\d+)"/);
    const tm = b.match(/<li class="title">([\s\S]*?)<\/li>/);
    if (!hm || !tm) continue;
    const title = decodeEntities(stripTags(tm[1])).replace(/\s+/g, " ").trim();
    if (!title || !isSafeNews(title)) continue;
    const im = b.match(/<img[^>]*\bdata-src="([^"]+)"/);
    const dm = b.match(/<span class="di-ib pr4">([^<]+)<\/span>/);
    const cm = b.match(/<span class="di-b comment">(\d+)/);
    const tags: string[] = [];
    const gre = /<span class="tag tag-color\d+">([\s\S]*?)<\/span>/g;
    let g: RegExpExecArray | null;
    while ((g = gre.exec(b))) {
      const tag = decodeEntities(stripTags(g[1])).trim();
      if (tag) tags.push(tag);
    }
    out.push({
      id: Number(hm[1]),
      title,
      url: `${MAL}/news/${hm[1]}`,
      date: dm ? parseMalDate(dm[1]) : "",
      image: im ? malFullImg(im[1]) : null,
      tags: tags.join(" · "),
      comments: cm ? Number(cm[1]) : 0,
    });
  }
  return out;
}

let feed: NewsItem[] = [];        // accumulated, globally newest-first
let malPage = 0;                  // index pages fetched so far
let exhausted = false;            // an index page came back empty
let feedInflight: Promise<void> | null = null;

async function fetchNextIndexPage(): Promise<void> {
  if (exhausted) return;
  const p = malPage + 1;
  const html = await fetchHtml(`${MAL}/news${p > 1 ? `?p=${p}` : ""}`, `${MAL}/`).catch(() => null);
  if (!html) return; // transient failure — state untouched so a retry can succeed
  const batch = parseNewsIndex(html);
  if (!batch.length) { exhausted = true; return; }
  malPage = p;
  const seen = new Set(feed.map((n) => n.id));
  const fresh = batch.filter((n) => !seen.has(n.id));
  // Capture the ENGLISH headlines before translateItem rewrites them, then run
  // the adult check and the translations side by side.
  const english = fresh.map((n) => ({ id: n.id, title: n.title }));
  const [bad] = await Promise.all([adultNewsIds(english), mapLimit(fresh, 8, translateItem)]);
  for (const n of fresh) {
    if (bad.has(n.id)) registry.delete(n.id);
    else feed.push(n);
  }
}

// Translate a visible item to Arabic in place + register it for the detail page.
// Idempotent: translateToArabic returns already-Arabic text untouched.
async function translateItem(n: NewsItem): Promise<void> {
  const [title, tags] = await Promise.all([
    translateToArabic(n.title),
    n.tags ? translateToArabic(n.tags) : Promise.resolve(""),
  ]);
  n.title = title;
  n.tags = tags;
  registry.set(n.id, n);
}

/**
 * One feed page = the next PAGE_SIZE items from the globally newest-first list,
 * translated to Arabic. The screen calls this on mount and on scroll-end.
 */
export async function fetchNewsPage(page: number): Promise<{ items: NewsItem[]; hasMore: boolean }> {
  const need = (page + 1) * PAGE_SIZE;
  while (feed.length < need && !exhausted) {
    const before = feed.length;
    feedInflight ??= fetchNextIndexPage().finally(() => { feedInflight = null; });
    await feedInflight;
    if (feed.length === before) break; // fetch failed — don't spin
  }
  const slice = feed.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  await mapLimit(slice, 8, translateItem); // no-op for already-translated items
  if (page === 0 && slice.length) {
    AsyncStorage.setItem(FEED_CACHE_KEY, JSON.stringify(slice)).catch(() => {});
  }
  return { items: slice, hasMore: !exhausted || feed.length > (page + 1) * PAGE_SIZE };
}

const FEED_CACHE_KEY = "news-feed-first-page-v1";

/**
 * Last successfully loaded first page (already translated + filtered), for an
 * instant first paint while fetchNewsPage(0) refreshes. Null if none cached.
 */
export async function getCachedNewsFirstPage(): Promise<NewsItem[] | null> {
  try {
    const raw = await AsyncStorage.getItem(FEED_CACHE_KEY);
    if (!raw) return null;
    const v = await loadVerdicts();
    const items = (JSON.parse(raw) as NewsItem[]).filter((n) => n && n.id && v[n.id] !== 1);
    for (const n of items) if (!registry.has(n.id)) registry.set(n.id, n);
    return items.length ? items : null;
  } catch {
    return null;
  }
}

/* ── Article detail (full body + images + trailers) ──────────
 * The MAL news page serves the whole article statically inside
 * `<div class="… news-content-body">` (inline <img>, <br>-separated text and
 * YouTube <iframe> embeds). We split it into ordered text/image/video blocks
 * and translate every text block to Arabic. If the container markup drifts,
 * fall back to the page's og:description so the screen never shows just a link. */

export interface ArticleBlock {
  type: "text" | "image" | "video";
  /** Arabic paragraph (text), absolute image URL (image), embed URL (video). */
  value: string;
}

const articleCache = new Map<number, ArticleBlock[]>();
const MAX_BLOCKS = 120; // bound translation cost on pathological list-style posts

// Inner HTML of the article container via balanced-div matching (the article
// can contain nested divs, so a naïve cut-to-next-marker would truncate).
function extractArticleDiv(html: string): string | null {
  const m = /<div[^>]*class="[^"]*news-content-body[^"]*"[^>]*>/i.exec(html);
  if (!m) return null;
  const from = m.index + m[0].length;
  const re = /<\/?div\b[^>]*>/gi;
  re.lastIndex = from;
  let depth = 1;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(html))) {
    if (mm[0].startsWith("</")) { if (--depth === 0) return html.slice(from, mm.index); }
    else depth++;
  }
  return html.slice(from); // unbalanced fallback
}

function parseArticle(inner: string): ArticleBlock[] {
  const normalized = inner
    .replace(/\r/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<p\b[^>]*>/gi, "");

  const blocks: ArticleBlock[] = [];
  const pushText = (raw: string) => {
    const text = decodeEntities(stripTags(raw)).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    for (const para of text.split(/\n{2,}/)) {
      const p = para.trim();
      if (p) blocks.push({ type: "text", value: p });
    }
  };

  // Single pass over <img> and <iframe> tokens keeps blocks in article order.
  const tokRe = /<img[^>]*?\bsrc="([^"]+)"[^>]*>|<iframe[^>]*?\bsrc="([^"]+)"[^>]*>[\s\S]*?<\/iframe>/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = tokRe.exec(normalized))) {
    pushText(normalized.slice(last, m.index));
    if (m[1]) {
      // MAL bodies occasionally carry cleartext http:// (or protocol-relative
      // //) image URLs — Android blocks cleartext, so those images silently
      // never render. Upgrade everything to https (the CDN serves it fine).
      let src = m[1];
      if (src.startsWith("//")) src = `https:${src}`;
      else if (src.startsWith("http://")) src = `https://${src.slice(7)}`;
      if (/^https:\/\//.test(src) && !/sprite|icon|blank\.gif/i.test(src)) {
        blocks.push({ type: "image", value: src });
      }
    } else if (m[2]) {
      // Trailers embed as youtube-nocookie iframes — normalize to a clean embed.
      const vid = m[2].match(/(?:youtube(?:-nocookie)?\.com\/embed\/|youtu\.be\/)([\w-]{6,})/i);
      if (vid) blocks.push({ type: "video", value: `https://www.youtube-nocookie.com/embed/${vid[1]}?rel=0` });
    }
    last = tokRe.lastIndex;
  }
  pushText(normalized.slice(last));
  return blocks.slice(0, MAX_BLOCKS);
}

/**
 * Full article for the detail screen — ordered Arabic text + image + trailer
 * blocks, or null if the page couldn't be fetched at all. Cached per id for
 * the session.
 */
export async function fetchNewsArticle(id: number): Promise<ArticleBlock[] | null> {
  const cached = articleCache.get(id);
  if (cached) return cached;

  // Safety net for deep links / stale screens: never render a blocked post.
  if ((await loadVerdicts())[id] === 1) return null;
  const item = registry.get(id);
  const url = item?.url || `${MAL}/news/${id}`;
  const html = await fetchHtml(url, `${MAL}/`).catch(() => null);
  if (!html) return null;

  const inner = extractArticleDiv(html);
  let blocks = inner ? parseArticle(inner) : [];
  if (!blocks.length) {
    // Markup drift fallback: og:description always ships with the page, so the
    // screen still shows the story's gist in-app instead of just a link.
    const og = html.match(/<meta property="og:description" content="([^"]+)"/i);
    if (!og) return null;
    blocks = [{ type: "text", value: decodeEntities(og[1]) }];
  }

  // Translate text blocks to Arabic (images/videos pass through untouched).
  await mapLimit(blocks.filter((b) => b.type === "text"), 4, async (b) => {
    b.value = await translateToArabic(b.value);
  });

  articleCache.set(id, blocks);
  return blocks;
}

/** Drop the session caches so a pull-to-refresh re-fetches everything. */
export function resetNews(): void {
  feed = [];
  malPage = 0;
  exhausted = false;
  registry.clear();
  articleCache.clear();
}

// ── self-check (security path) ────────────────────────────────────
// The NSFW guard is the brand-safety contract; assert it can't silently break.
if (import.meta.env.DEV) {
  console.assert(isSafeNews("New season announced") === true, "news: safe item rejected");
  console.assert(isSafeNews("Uncensored Hentai OVA listed") === false, "news: hentai not filtered");
  console.assert(isSafeNews("Spring Ecchi roundup") === false, "news: ecchi keyword not filtered");
  console.assert(isSafeNews("Top 10 of 2026") === true, "news: clean item wrongly rejected");
  console.assert(quotedTitles("Manga 'Hagure Idol: Jigoku-hen' Gets TV Anime").join() === "Hagure Idol: Jigoku-hen", "news: quoted title parse broke");
  console.assert(quotedTitles("Voice Actress Announces Marriage").length === 0, "news: phantom quoted title");
  // Date parser: a yearless date must land in the recent past, not the future.
  const iso = parseMalDate("Jul 15, 2:48 AM");
  console.assert(!!iso && new Date(iso).getTime() <= Date.now(), "news: yearless date in future");
}
