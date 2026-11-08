// Filler / canon detection for an anime (network + cache layer).
//
// Primary: animefillerlist.com (show list + per-show category page, plain
// HTML, not Cloudflare-gated). Fallback: MyAnimeList filler/recap flags via
// Jikan for shows the list doesn't cover. Results are cached per anime so
// the detail page and the player share one lookup; misses are cached too so
// a show without filler data costs nothing on revisits.

import { storage as AsyncStorage } from "./storage";
import { animeTitleKey } from "./history";
import { slugToTitle } from "./relations";
import {
  kindsFromJikan,
  matchAflShow,
  parseAflShowList,
  parseAflShowPage,
  type AflShow,
  type FillerData,
} from "./fillerParse";

export * from "./fillerParse";

const AFL = "https://www.animefillerlist.com";
const SHOWS_KEY = "@afl_shows_v1";
const SHOWS_TTL = 7 * 24 * 60 * 60 * 1000;
const DATA_PREFIX = "@filler_v1:";
const DATA_TTL = 3 * 24 * 60 * 60 * 1000;
const MISS_TTL = 2 * 24 * 60 * 60 * 1000;

async function fetchText(url: string, timeoutMs = 10000): Promise<string | null> {
  // Main-process GET: animefillerlist sends no CORS headers, and the main
  // process rides DoH when the ISP DNS blocks a host.
  try {
    if (/^https:\/\/api\.jikan\.moe\//.test(url)) return (await window.pantoufa?.fetchText?.(url)) ?? null;
    return (await window.pantoufa?.fetchHtml?.(url, AFL + "/", { attempts: 1, timeoutMs })) ?? null;
  } catch {
    return null;
  }
}

let showsMem: AflShow[] | null = null;
let showsInflight: Promise<AflShow[]> | null = null;

function getAflShows(): Promise<AflShow[]> {
  if (showsMem) return Promise.resolve(showsMem);
  if (showsInflight) return showsInflight;
  showsInflight = (async () => {
    try {
      const raw = await AsyncStorage.getItem(SHOWS_KEY).catch(() => null);
      if (raw) {
        const c = JSON.parse(raw) as { at: number; shows: AflShow[] };
        if (Date.now() - c.at < SHOWS_TTL && Array.isArray(c.shows) && c.shows.length > 50 && c.shows[0]?.alts) {
          showsMem = c.shows;
          return c.shows;
        }
      }
      const html = await fetchText(`${AFL}/shows`);
      const shows = html ? parseAflShowList(html) : [];
      if (shows.length > 50) {
        showsMem = shows;
        AsyncStorage.setItem(SHOWS_KEY, JSON.stringify({ at: Date.now(), shows })).catch(() => {});
      }
      return shows;
    } catch {
      return [];
    } finally {
      showsInflight = null;
    }
  })();
  return showsInflight;
}

/** Thrown for network failures so a transient error is never cached as "no filler data". */
class TransientError extends Error {}

async function fromAfl(titles: string[]): Promise<FillerData | null> {
  const shows = await getAflShows();
  if (!shows.length) throw new TransientError("afl list unavailable");
  const slug = matchAflShow(shows, titles);
  if (!slug) return null;
  const html = await fetchText(`${AFL}/shows/${slug}`);
  if (!html) throw new TransientError("afl page unavailable");
  const kinds = parseAflShowPage(html);
  return Object.keys(kinds).length ? { show: slug, source: "afl", kinds } : null;
}

async function fromJikan(title: string, href: string): Promise<FillerData | null> {
  try {
    const { resolveMalId } = await import("./aniskip");
    const malId = await resolveMalId(title, href);
    if (!malId) return null;
    const pages: unknown[] = [];
    for (let page = 1; page <= 6; page++) {
      const text = await fetchText(`https://api.jikan.moe/v4/anime/${malId}/episodes?page=${page}`, 8000);
      if (!text) break;
      const j = JSON.parse(text);
      pages.push(j);
      if (!j?.pagination?.has_next_page) break;
      // Jikan allows ~3 req/s.
      await new Promise((r) => setTimeout(r, 450));
    }
    const kinds = kindsFromJikan(pages);
    return Object.keys(kinds).length ? { show: `mal:${malId}`, source: "jikan", kinds } : null;
  } catch {
    return null;
  }
}

const mem = new Map<string, FillerData | null>();
const inflight = new Map<string, Promise<FillerData | null>>();

/** Synchronous peek (memory only) for first render. undefined = not looked up yet. */
export function peekFillerData(title: string): FillerData | null | undefined {
  const key = animeTitleKey(title);
  return mem.has(key) ? mem.get(key) ?? null : undefined;
}

/**
 * Filler data for an anime, or null when no source knows it. Never throws.
 * `extraTitles` (AniList romaji/English names) widen the exact-name match.
 */
export function getFillerData(opts: {
  title: string;
  href?: string | null;
  extraTitles?: string[];
}): Promise<FillerData | null> {
  const key = animeTitleKey(opts.title);
  if (!key) return Promise.resolve(null);
  if (mem.has(key)) return Promise.resolve(mem.get(key) ?? null);
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = (async () => {
    try {
      const raw = await AsyncStorage.getItem(DATA_PREFIX + key).catch(() => null);
      if (raw) {
        const c = JSON.parse(raw) as { at: number; data: FillerData | null };
        const ttl = c.data ? DATA_TTL : MISS_TTL;
        if (Date.now() - c.at < ttl) {
          mem.set(key, c.data);
          return c.data;
        }
      }
      const slugTitle = slugToTitle(opts.href || "");
      const titles = [opts.title, slugTitle, ...(opts.extraTitles ?? [])].filter(Boolean) as string[];
      let data = await fromAfl(titles);
      if (!data && !opts.extraTitles) {
        // Source titles are often Arabic or decorated; AniList's official
        // romaji/English names are what the filler list uses.
        try {
          const { getAltTitles } = await import("./altTitles");
          const alts = await getAltTitles(slugTitle || opts.title);
          if (alts.length) data = await fromAfl([...titles, ...alts]);
        } catch {}
      }
      if (!data) data = await fromJikan(opts.title, opts.href || "");
      mem.set(key, data);
      AsyncStorage.setItem(DATA_PREFIX + key, JSON.stringify({ at: Date.now(), data })).catch(() => {});
      return data;
    } catch (e) {
      // Offline / site down: try Jikan, but never persist the miss.
      if (e instanceof TransientError) {
        const data = await fromJikan(opts.title, opts.href || "");
        if (data) {
          mem.set(key, data);
          AsyncStorage.setItem(DATA_PREFIX + key, JSON.stringify({ at: Date.now(), data })).catch(() => {});
        }
        return data;
      }
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}
