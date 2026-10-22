// Last-resort manga cover: AniList's cover for the same work.
//
// Sources delete old uploads while their pages keep linking them — on
// 2026-10-21 14 of 50 mangalik home covers (and 3asq's Jujutsu Kaisen) were
// 403/404 for every size and for a real browser too, so no URL rewrite can
// recover them. AniList covers manga and most manhwa on a global CDN. A wrong
// cover is worse than the label tile, so only a near-exact title match counts
// (strictTitleScore, the same guard that keeps "Solo Leveling" apart from
// "Solo Leveling Ragnarok"), checked against every AniList name/synonym.

import { storage as AsyncStorage } from "../storage";
import { mangaTitleKey, strictTitleScore } from "./aggregate";

const CACHE_PREFIX = "@manga_cover_fallback_v1:";
const HIT_TTL = 30 * 24 * 60 * 60 * 1000;
const MISS_TTL = 3 * 24 * 60 * 60 * 1000;
const MATCH_THRESHOLD = 0.88;
const QUERY = `query ($s: String) { Page(perPage: 6) { media(search: $s, type: MANGA, isAdult: false) {
  title { romaji english native } synonyms coverImage { large } } } }`;

export interface AniListMangaHit {
  title: { romaji?: string | null; english?: string | null; native?: string | null };
  synonyms?: string[] | null;
  coverImage?: { large?: string | null } | null;
}

/** Pure: the cover of the best near-exact title match, else null. */
export function pickAniListCover(title: string, media: AniListMangaHit[]): string | null {
  let best: string | null = null;
  let bestScore = 0;
  for (const m of media) {
    const cover = m.coverImage?.large;
    if (!cover) continue;
    const names = [m.title.romaji, m.title.english, m.title.native, ...(m.synonyms ?? [])].filter((n): n is string => !!n);
    const score = Math.max(0, ...names.map((n) => strictTitleScore(title, n)));
    if (score > bestScore) { bestScore = score; best = cover; }
  }
  return bestScore >= MATCH_THRESHOLD ? best : null;
}

const mem = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();
// One AniList request at a time: a screen of dead covers must not burst past
// AniList's rate limit (90/min) and get every lookup 429'd.
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {}).then(() => new Promise((r) => setTimeout(r, 700)));
  return run;
}

async function search(title: string): Promise<AniListMangaHit[] | null> {
  // Main-process fetch (DoH, no CORS) — the same path desktop uses for AniList.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await window.pantoufa.fetchJson?.({
        url: "https://graphql.anilist.co",
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query: QUERY, variables: { s: title } }),
      });
      if (text) {
        const media = JSON.parse(text)?.data?.Page?.media;
        return Array.isArray(media) ? media : [];
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null; // network trouble: don't cache, retry next time
}

/** Cached AniList cover for a manga title, or null when there's no safe match. */
export function findFallbackMangaCover(title: string | null | undefined): Promise<string | null> {
  const key = mangaTitleKey(title || "");
  if (!key || !/[a-z]/.test(key)) return Promise.resolve(null); // AniList search is Latin-only
  if (mem.has(key)) return Promise.resolve(mem.get(key) ?? null);
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = (async () => {
    try {
      const raw = await AsyncStorage.getItem(CACHE_PREFIX + key);
      if (raw) {
        const cached = JSON.parse(raw) as { ts: number; url: string | null };
        if (Date.now() - cached.ts < (cached.url ? HIT_TTL : MISS_TTL)) { mem.set(key, cached.url); return cached.url; }
      }
    } catch {}
    const media = await serial(() => search(title!));
    if (media == null) return null;
    const url = pickAniListCover(title!, media);
    mem.set(key, url);
    try { await AsyncStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ ts: Date.now(), url })); } catch {}
    return url;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
