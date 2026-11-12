// Taste engine — data gathering, AniList lookups, caching.
// Pure logic: lib/tasteCore.ts · queries: lib/tasteAniList.ts.
//
// Pipeline (computeTaste):
//   history (device ∪ account) + completion records
//     → per-anime behaviour (groupForTaste) → AniList media for each show
//     → signed taste profile (finished/binged = +, dropped = −)
//     → candidates: community recs of the user's favourites + acclaimed shows
//       in their top genres / themes
//     → ranked, explained, diversified (rankTaste).
// The whole bundle is cached so the screen opens instantly and filters/
// "not interested" re-rank locally with no network.

import { storage as AsyncStorage } from "./storage";
import { anilistPost } from "./malInfo";
import { getCompletionMap } from "./completion";
import { getFavorites } from "./favorites";
import { animeTitleKey, getHistory, normAnimeKey, type WatchEntry } from "./history";
import { canonTitle, pickBestMedia, scoreMedia, slugToTitle, type AniListMedia } from "./relations";
import { isSupabaseConfigured, supabase } from "./supabase";
import {
  buildProfile,
  groupForTaste,
  profileSignature,
  rankTaste,
  topAffinities,
  usableTags,
  type Endorsement,
  type HiddenMedia,
  type ScoredCandidate,
  type TasteAnime,
  type TasteFilter,
  type TasteMedia,
  type TasteProfile,
} from "./tasteCore";
import {
  DISCOVER_QUERY,
  MEDIA_BY_IDS_QUERY,
  SEED_RECS_QUERY,
  buildResolveQuery,
  cleanSearchTitle,
  parseSeedRecs,
  parseTasteMedia,
} from "./tasteAniList";

export * from "./tasteCore";

/* ── Storage keys / TTLs ── */
const MEDIA_PREFIX = "@taste_media_v2:";
const MEDIA_TTL = 30 * 24 * 3600_000;
const MEDIA_MISS_TTL = 7 * 24 * 3600_000;
const RECS_PREFIX = "@taste_seedrecs_v1:";
const RECS_TTL = 7 * 24 * 3600_000;
const DISCOVER_PREFIX = "@taste_discover_v1:";
const DISCOVER_TTL = 3 * 24 * 3600_000;
const BUNDLE_KEY = "@taste_bundle_v2";
const HIDDEN_KEY = "@taste_hidden_v1";
/** A cached bundle younger than this is reused when nothing changed. */
export const TASTE_FRESH_MS = 12 * 3600_000;

/** Most-recent shows resolved per run (older ones resolve on later runs). */
const RESOLVE_PER_RUN = 64;
const RESOLVE_BATCH = 8;
const SEEDS_FOR_RECS = 10;

export type TastePhase = "reading" | "resolving" | "matching" | "done";

export interface TasteBundle {
  at: number;
  sig: string;
  anime: TasteAnime[];
  candidates: TasteMedia[];
  endorsements: [number, Endorsement[]][];
}

/* ── small cache helpers ── */
async function readCache<T>(key: string, ttl: number): Promise<T | undefined> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return undefined;
    const c = JSON.parse(raw) as { at: number; v: T; miss?: boolean };
    const age = Date.now() - c.at;
    if (age > (c.miss ? Math.min(ttl, MEDIA_MISS_TTL) : ttl)) return undefined;
    return c.v;
  } catch {
    return undefined;
  }
}
function writeCache(key: string, v: unknown, miss = false): void {
  AsyncStorage.setItem(key, JSON.stringify({ at: Date.now(), v, miss })).catch(() => {});
}

/* ── 1. history (device ∪ account) ── */

async function fetchCloudHistory(): Promise<WatchEntry[]> {
  if (!isSupabaseConfigured) return [];
  try {
    const { data: s } = await supabase.auth.getSession();
    const uid = s?.session?.user?.id;
    if (!uid) return [];
    const out: WatchEntry[] = [];
    for (let page = 0; page < 4; page++) {
      const { data, error } = await supabase
        .from("watch_history")
        .select("episode_href,episode_title,anime_title,anime_href,image,position_ms,duration_ms,updated_at,completed")
        .eq("user_id", uid)
        .order("updated_at", { ascending: false })
        .range(page * 1000, page * 1000 + 999);
      if (error || !data) break;
      for (const row of data as Record<string, any>[]) {
        out.push({
          episodeHref: row.episode_href,
          episodeTitle: row.episode_title || "",
          animeTitle: row.anime_title || "",
          animeHref: row.anime_href || "",
          image: row.image || "",
          positionMs: row.position_ms || 0,
          durationMs: row.duration_ms || 0,
          updatedAt: new Date(row.updated_at).getTime(),
          completed: !!row.completed,
        });
      }
      if (data.length < 1000) break;
    }
    return out;
  } catch {
    return [];
  }
}

function epNumOf(e: WatchEntry): number | null {
  if (typeof e.epNum === "number" && e.epNum > 0) return e.epNum;
  for (const s of [e.episodeHref, e.episodeTitle]) {
    if (!s) continue;
    let d = s;
    try { d = decodeURIComponent(s); } catch {}
    const m = d.match(/الحلقة[\s\-_]*(\d+)/) || d.match(/\/(?:episode|watch)\/[^/]+\/(\d+)(?:\/|$)/i) || d.match(/\bepisode\s*(\d+)/i);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

const animeKeyOf = (title: string, href: string) => animeTitleKey(title) || normAnimeKey(href);

async function gatherAnime(): Promise<TasteAnime[]> {
  const [local, cloud, completion] = await Promise.all([
    getHistory().catch(() => [] as WatchEntry[]),
    fetchCloudHistory(),
    getCompletionMap().catch(() => ({})),
  ]);
  // Local ∪ cloud, one row per episode href (newest wins).
  const byHref = new Map<string, WatchEntry>();
  for (const e of [...cloud, ...local]) {
    if (!e?.episodeHref) continue;
    const cur = byHref.get(e.episodeHref);
    if (!cur || e.updatedAt >= cur.updatedAt) byHref.set(e.episodeHref, e);
  }
  const anime = groupForTaste(
    [...byHref.values()].map((e) => ({
      animeTitle: e.animeTitle,
      animeHref: e.animeHref,
      image: e.image,
      epNum: epNumOf(e),
      updatedAt: e.updatedAt,
      completed: !!e.completed || (e.durationMs > 0 && e.positionMs / e.durationMs >= 0.8),
    })),
    (e) => animeKeyOf(e.animeTitle, e.animeHref),
    new Date().getTimezoneOffset(),
  );

  // Completion records: finished / caught-up / hand-marked. A marked anime
  // with no history still counts (the user told us they finished it).
  const byKey = new Map(anime.map((a) => [a.key, a]));
  for (const rec of Object.values(completion)) {
    const keys = [...rec.titles.map((t) => animeTitleKey(t)), ...rec.hrefs.map((h) => normAnimeKey(h))].filter(Boolean);
    let target = keys.map((k) => byKey.get(k)).find(Boolean);
    if (!target && rec.marked && rec.titles[0]) {
      target = {
        key: animeKeyOf(rec.titles[0], rec.hrefs[0] || ""),
        title: rec.titles[0],
        href: rec.hrefs[0] || "",
        image: rec.image || "",
        watchedEps: 0, touchedEps: 0, maxEp: rec.lastEpNum || 0,
        firstAt: rec.updatedAt, lastAt: rec.updatedAt, activeDays: 0, bestDay: 0,
        finished: false, marked: false, caughtUp: false,
      };
      anime.push(target);
      byKey.set(target.key, target);
    }
    if (!target) continue;
    target.finished = target.finished || rec.finished;
    target.marked = target.marked || !!rec.marked;
    target.caughtUp = target.caughtUp || rec.caughtUp;
  }
  return anime;
}

/* ── 2. AniList media for each watched show ── */

function searchTitleFor(a: TasteAnime): string {
  // Source titles are usually romaji; Arabic ones fall back to the URL slug.
  const t = cleanSearchTitle(a.title || "");
  if (/[a-z]/i.test(t)) return t;
  return cleanSearchTitle(slugToTitle(a.href)) || t;
}

/** Second-chance query from the URL slug (differs from the title on witanime). */
function slugTitleFor(a: TasteAnime): string {
  const s = cleanSearchTitle(slugToTitle(a.href) || "");
  return s && s.toLowerCase() !== searchTitleFor(a).toLowerCase() ? s : "";
}

/**
 * Strict pick first; else trust AniList's own best match (SEARCH_MATCH order)
 * when it still shares a clear part of the name — source titles are exact
 * romaji far more often than not.
 */
function pickMedia(raws: AniListMedia[], q: string): AniListMedia | null {
  const strict = pickBestMedia(raws, q, 55);
  if (strict) return strict;
  const first = raws.find((m) => m && (!m.type || m.type === "ANIME"));
  return first && scoreMedia(first, q) >= 32 ? first : null;
}

async function resolveMedia(anime: TasteAnime[], onProgress?: () => void): Promise<void> {
  const pending: TasteAnime[] = [];
  for (const a of anime) {
    const cached = await readCache<TasteMedia | null>(MEDIA_PREFIX + a.key, MEDIA_TTL);
    if (cached !== undefined) a.media = cached;
    else pending.push(a);
  }
  const todo = pending.sort((x, y) => y.lastAt - x.lastAt).slice(0, RESOLVE_PER_RUN);
  const runPass = async (items: { a: TasteAnime; q: string }[], final: boolean) => {
    const misses: TasteAnime[] = [];
    for (let i = 0; i < items.length; i += RESOLVE_BATCH) {
      const batch = items.slice(i, i + RESOLVE_BATCH).filter((x) => x.q.length >= 2);
      if (!batch.length) continue;
      const { query, variables } = buildResolveQuery(batch.map((x) => x.q));
      const json = await anilistPost(query, variables);
      if (!json?.data) continue; // rate-limited/offline: retry on the next run
      batch.forEach(({ a, q }, idx) => {
        const raws = (json.data[`m${idx}`]?.media ?? []) as AniListMedia[];
        const best = pickMedia(raws, q);
        const media = best ? parseTasteMedia(best) : null;
        if (media || final) {
          a.media = media;
          writeCache(MEDIA_PREFIX + a.key, media, media == null);
        } else {
          misses.push(a);
        }
      });
      onProgress?.();
    }
    return misses;
  };
  // Pass 1: cleaned title. Pass 2: the URL slug. Pass 3: the name before
  // the subtitle ("Kimetsu no Yaiba: Mugen-jou-hen …" → "Kimetsu no Yaiba") —
  // a sibling entry of the same franchise carries the same taste signal.
  const misses1 = await runPass(todo.map((a) => ({ a, q: searchTitleFor(a) })), false);
  const slugTries = misses1.map((a) => ({ a, q: slugTitleFor(a) })).filter((x) => x.q);
  const misses2 = [
    ...misses1.filter((a) => !slugTitleFor(a)),
    ...(await runPass(slugTries, false)),
  ];
  const headOf = (a: TasteAnime) => {
    const t = searchTitleFor(a);
    const head = t.includes(":") ? t.split(":")[0].trim() : "";
    return head.length >= 4 && head.toLowerCase() !== t.toLowerCase() ? head : "";
  };
  const headTries = misses2.map((a) => ({ a, q: headOf(a) }));
  await runPass(headTries.filter((x) => x.q), true);
  for (const x of headTries.filter((r) => !r.q)) {
    x.a.media = null;
    writeCache(MEDIA_PREFIX + x.a.key, null, true);
  }
}

/* ── 3. candidates ── */

async function seedEndorsements(profile: TasteProfile): Promise<Map<number, Endorsement[]>> {
  const out = new Map<number, Endorsement[]>();
  const seeds = profile.seeds.slice(0, SEEDS_FOR_RECS);
  const missing: number[] = [];
  const recsBySeed = new Map<number, { id: number; rating: number }[]>();
  for (const s of seeds) {
    const cached = await readCache<{ id: number; rating: number }[]>(RECS_PREFIX + s.anilistId, RECS_TTL);
    if (cached) recsBySeed.set(s.anilistId, cached);
    else missing.push(s.anilistId);
  }
  if (missing.length) {
    const json = await anilistPost(SEED_RECS_QUERY, { ids: missing });
    if (json?.data) {
      const parsed = parseSeedRecs(json);
      for (const id of missing) {
        const recs = parsed.get(id) ?? [];
        recsBySeed.set(id, recs);
        writeCache(RECS_PREFIX + id, recs);
      }
    }
  }
  for (const [seedId, recs] of recsBySeed) {
    for (const r of recs) {
      const list = out.get(r.id) ?? [];
      list.push({ seedId, rating: r.rating });
      out.set(r.id, list);
    }
  }
  return out;
}

async function discover(args: { genres?: string[]; tags?: string[] }): Promise<TasteMedia[]> {
  const key = DISCOVER_PREFIX + JSON.stringify(args);
  const cached = await readCache<TasteMedia[]>(key, DISCOVER_TTL);
  if (cached) return cached;
  const json = await anilistPost(DISCOVER_QUERY, { ...args, page: 1 });
  const list = ((json?.data?.Page?.media ?? []) as unknown[]).map(parseTasteMedia).filter((m): m is TasteMedia => !!m);
  if (list.length) writeCache(key, list);
  return list;
}

async function mediaByIds(ids: number[]): Promise<TasteMedia[]> {
  const out: TasteMedia[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const json = await anilistPost(MEDIA_BY_IDS_QUERY, { ids: chunk });
    for (const raw of json?.data?.Page?.media ?? []) {
      const m = parseTasteMedia(raw);
      if (m) out.push(m);
    }
  }
  return out;
}

/* ── hidden ("not interested") ── */

export async function getHidden(): Promise<HiddenMedia[]> {
  try {
    const raw = await AsyncStorage.getItem(HIDDEN_KEY);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export async function hideRecommendation(m: TasteMedia): Promise<void> {
  const list = (await getHidden()).filter((h) => h.id !== m.id);
  list.unshift({ id: m.id, genres: m.genres, tags: usableTags(m) });
  await AsyncStorage.setItem(HIDDEN_KEY, JSON.stringify(list.slice(0, 200))).catch(() => {});
}

export async function unhideRecommendation(id: number): Promise<void> {
  const list = (await getHidden()).filter((h) => h.id !== id);
  await AsyncStorage.setItem(HIDDEN_KEY, JSON.stringify(list)).catch(() => {});
}

/* ── exclusions: anything already watched, listed or completed ── */

async function buildExcluded(anime: TasteAnime[]): Promise<(m: TasteMedia) => boolean> {
  const favorites = await getFavorites().catch(() => []);
  const keys = new Set<string>();
  const canons = new Set<string>();
  const remember = (t: string | null | undefined) => {
    if (!t) return;
    const k = animeTitleKey(t);
    if (k) keys.add(k);
    canons.add(canonTitle(t));
  };
  for (const a of anime) remember(a.title);
  for (const f of favorites) remember(f.title);
  return (m) => [m.title, m.titleEnglish].some((t) => !!t && (keys.has(animeTitleKey(t)) || canons.has(canonTitle(t))));
}

/* ── public API ── */

export interface TasteView {
  profile: TasteProfile;
  ranked: ScoredCandidate[];
  anime: TasteAnime[];
  at: number;
}

let bundleMem: TasteBundle | null = null;

export async function readTasteBundle(): Promise<TasteBundle | null> {
  if (bundleMem) return bundleMem;
  try {
    const raw = await AsyncStorage.getItem(BUNDLE_KEY);
    if (!raw) return null;
    const b = JSON.parse(raw) as TasteBundle;
    if (!b || !Array.isArray(b.anime) || !Array.isArray(b.candidates)) return null;
    bundleMem = b;
    return b;
  } catch {
    return null;
  }
}

/** Rank a bundle locally (filters, "not interested") — no network. */
export async function viewFromBundle(b: TasteBundle, filter: TasteFilter = "all", cap = 40): Promise<TasteView> {
  const hidden = await getHidden();
  const now = Date.now();
  const profile = buildProfile(b.anime, now, hidden);
  const excluded = await buildExcluded(b.anime);
  const ranked = rankTaste(b.candidates, profile, {
    endorsements: new Map(b.endorsements),
    excluded,
    filter,
    cap,
  });
  return { profile, ranked, anime: b.anime, at: b.at };
}

let inflight: Promise<TasteBundle | null> | null = null;

/**
 * Recompute the taste bundle. Reuses a fresh cached bundle when the history
 * signature hasn't changed (unless `force`). Resolves null when there is not
 * enough history to say anything (fewer than 2 shows with AniList data).
 */
export function computeTaste(opts: { force?: boolean; onPhase?: (p: TastePhase) => void } = {}): Promise<TasteBundle | null> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      opts.onPhase?.("reading");
      const anime = await gatherAnime();
      const hidden = await getHidden();
      const sig = profileSignature(anime, hidden.map((h) => h.id));
      const prev = await readTasteBundle();
      if (!opts.force && prev && prev.sig === sig && Date.now() - prev.at < TASTE_FRESH_MS) {
        opts.onPhase?.("done");
        return prev;
      }

      opts.onPhase?.("resolving");
      await resolveMedia(anime);
      const now = Date.now();
      const profile = buildProfile(anime, now, hidden);
      if (profile.stats.analysed < 2 || profile.seeds.length === 0) {
        opts.onPhase?.("done");
        return null;
      }

      opts.onPhase?.("matching");
      const topGenres = topAffinities(profile.genres, 3).map((g) => g.name);
      const topTags = topAffinities(profile.tags, 2).map((t) => t.name);
      const [endorsements, ...discovered] = await Promise.all([
        seedEndorsements(profile),
        ...topGenres.slice(0, 2).map((g) => discover({ genres: [g] })),
        ...(topTags.length ? [discover({ tags: topTags.slice(0, 1) })] : []),
        ...(topGenres.length >= 2 ? [discover({ genres: topGenres.slice(1, 3) })] : []),
      ]);
      const pool = new Map<number, TasteMedia>();
      for (const list of discovered) for (const m of list) pool.set(m.id, m);
      const missingIds = [...endorsements.keys()].filter((id) => !pool.has(id) && !profile.seenIds.has(id));
      for (const m of await mediaByIds(missingIds.slice(0, 150))) pool.set(m.id, m);

      const bundle: TasteBundle = {
        at: Date.now(),
        sig,
        anime,
        candidates: [...pool.values()],
        endorsements: [...endorsements.entries()],
      };
      bundleMem = bundle;
      AsyncStorage.setItem(BUNDLE_KEY, JSON.stringify(bundle)).catch(() => {});
      opts.onPhase?.("done");
      return bundle;
    } catch {
      opts.onPhase?.("done");
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Forget everything (sign-out / account switch). */
export async function resetTaste(): Promise<void> {
  bundleMem = null;
  await Promise.all([AsyncStorage.removeItem(BUNDLE_KEY), AsyncStorage.removeItem(HIDDEN_KEY)]).catch(() => {});
}
