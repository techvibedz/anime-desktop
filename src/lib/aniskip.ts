// AniSkip skip-times (openings / endings) for the player, ported from the
// mobile app's lib/aniskip.ts. MAL id resolution goes through Jikan (the same
// convention as lib/altTitles.ts — the mobile app resolves via MAL's
// prefix.json, which isn't available here without porting animeInfo.ts) and
// the AniSkip v2 API is called from the privileged main process via
// window.pantoufa.fetchJson (no CORS). AsyncStorage → the storage shim.

import { storage } from "./storage";
import { fuzzyScore } from "./fuzzy";

export interface SkipInterval {
  startTime: number; // in seconds
  endTime: number;   // in seconds
}

export interface EpisodeSkipTimes {
  op?: SkipInterval;
  ed?: SkipInterval;
  found: boolean;
  episodeLength?: number;
}

export interface ActiveSkip {
  type: "op" | "ed";
  interval: SkipInterval;
}

const CACHE_PREFIX = "@aniskip_v1:";
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days for found
const NOT_FOUND_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days for miss

const memCache = new Map<string, EpisodeSkipTimes>();
const inflight = new Map<string, Promise<EpisodeSkipTimes>>();

const malIdMemCache = new Map<string, number>();

/**
 * Pure parser for the AniSkip API response payload.
 */
export function parseAniSkipResponse(raw: any): EpisodeSkipTimes {
  if (!raw || typeof raw !== "object" || raw.found !== true || !Array.isArray(raw.results)) {
    return { found: false };
  }

  let op: SkipInterval | undefined;
  let ed: SkipInterval | undefined;
  let episodeLength: number | undefined;

  for (const item of raw.results) {
    if (!item || !item.interval) continue;
    const start = Number(item.interval.startTime);
    const end = Number(item.interval.endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;

    const interval: SkipInterval = {
      startTime: Math.max(0, Math.round(start * 10) / 10),
      endTime: Math.max(0, Math.round(end * 10) / 10),
    };

    if (item.skipType === "op" && (!op || interval.endTime > op.endTime)) {
      op = interval;
    } else if (item.skipType === "ed" && (!ed || interval.endTime > ed.endTime)) {
      ed = interval;
    }

    if (typeof item.episodeLength === "number" && item.episodeLength > 0) {
      episodeLength = item.episodeLength;
    }
  }

  const found = Boolean(op || ed);
  return {
    found,
    op,
    ed,
    episodeLength,
  };
}

/**
 * Returns true if current video playback time falls within the given interval.
 */
export function isInsideInterval(
  currentTime: number,
  interval?: SkipInterval | null,
  leadBuffer = 0.5,
  tailBuffer = 0.5,
): boolean {
  if (!interval || typeof currentTime !== "number" || isNaN(currentTime)) return false;
  return currentTime >= interval.startTime - leadBuffer && currentTime < interval.endTime - tailBuffer;
}

/**
 * Determines which skip interval (intro or outro) is currently active.
 */
export function activeSkipInterval(
  currentTime: number,
  skipTimes?: EpisodeSkipTimes | null,
): ActiveSkip | null {
  if (!skipTimes || !skipTimes.found) return null;
  if (isInsideInterval(currentTime, skipTimes.op)) {
    return { type: "op", interval: skipTimes.op! };
  }
  if (isInsideInterval(currentTime, skipTimes.ed)) {
    return { type: "ed", interval: skipTimes.ed! };
  }
  return null;
}

/* ── MAL id resolution (Jikan) ── */

// Derive a romaji-ish title from a source URL slug. witanime/anime4up/anime3rb
// slugs are clean romaji ("/anime/tensei-shitara-slime-datta-ken-4th-season/").
// Mirrors the mobile app's lib/relations.ts slugToTitle.
function slugToTitle(href: string | null | undefined): string {
  if (!href) return "";
  try {
    let path = String(href).split(/[?#]/)[0].replace(/\/+$/, "");
    let slug = path.split("/").pop() || "";
    try { slug = decodeURIComponent(slug); } catch {}
    // anime3rb uses /titles/<id>/<slug>; the numeric id segment is useless.
    if (/^\d+$/.test(slug)) {
      const parts = path.split("/");
      slug = parts[parts.length - 2] || slug;
    }
    return slug.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

function norm(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

const ARABIC_RE = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]+/g;

// Source-site titles carry Arabic season labels / parentheticals that Jikan's
// title search can't resolve — clean them off before querying.
function cleanQuery(title: string): string {
  return (title || "")
    .replace(ARABIC_RE, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/\b(the\s+)?(final\s+)?season\s*\d*\b/gi, " ")
    .replace(/\bpart\s*\d+\b/gi, " ")
    .replace(/[_–—-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// GET a Jikan endpoint via the main process, retrying 429/5xx-like failures.
// Same convention as lib/altTitles.ts.
async function jikanGet(url: string): Promise<any | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const text = await window.pantoufa?.fetchJson?.({ url });
      if (text) {
        try { return JSON.parse(text); } catch { return null; }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
  }
  return null;
}

// Score every candidate's titles against the query, break ties by popularity.
function pickMalId(candidates: any[], query: string): number | null {
  const q = norm(query);
  let best: any = null;
  let bestScore = -Infinity;
  for (const c of candidates) {
    const titles: string[] = [
      c.title, c.title_english, c.title_japanese,
      ...(Array.isArray(c.titles) ? c.titles.map((t: any) => t?.title) : []),
    ].filter(Boolean);
    let score = 0;
    for (const t of titles) {
      const nt = norm(t);
      if (!nt) continue;
      if (nt === q) score = Math.max(score, 1000);
      else if (nt.includes(q) || q.includes(nt)) score = Math.max(score, 500);
      else score = Math.max(score, fuzzyScore(q, nt) * 400);
    }
    if (score < 220) continue;
    score += Math.min((c.members || 0) / 100000, 4);
    if (score > bestScore) { bestScore = score; best = c; }
  }
  const id = best?.mal_id;
  return typeof id === "number" && id > 0 ? id : null;
}

async function fetchMalId(title: string): Promise<number | null> {
  const cleaned = cleanQuery(title);
  const attempts = [cleaned, title.trim()].filter((q, i, a) => q && a.indexOf(q) === i);
  for (const q of attempts) {
    const json = await jikanGet(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(q)}&limit=8&sfw`);
    const id = pickMalId(json?.data || [], q);
    if (id) return id;
  }
  return null;
}

/**
 * Resolve MyAnimeList ID from anime title and/or URL slug.
 */
export async function resolveMalId(title?: string | null, slugOrUrl?: string | null): Promise<number | null> {
  const normTitle = (title || "").trim();
  const slug = (slugOrUrl || "").trim();
  const cacheKey = (normTitle + "::" + slug).toLowerCase();

  if (malIdMemCache.has(cacheKey)) {
    return malIdMemCache.get(cacheKey) ?? null;
  }

  const candidates: string[] = [];
  if (normTitle) candidates.push(normTitle);
  if (slug) {
    const derived = slugToTitle(slug);
    if (derived && derived.toLowerCase() !== normTitle.toLowerCase()) {
      candidates.push(derived);
    }
  }

  for (const query of candidates) {
    try {
      const id = await fetchMalId(query);
      if (id && id > 0) {
        malIdMemCache.set(cacheKey, id);
        return id;
      }
    } catch {}
  }

  return null;
}

/* ── AniSkip v2 ── */

/**
 * Fetch skip intervals for a given MAL ID and episode number from AniSkip API.
 */
export async function fetchSkipTimesFromApi(
  malId: number,
  episodeNumber: number,
  durationSeconds = 0,
): Promise<EpisodeSkipTimes> {
  if (!malId || !episodeNumber || episodeNumber < 1) {
    return { found: false };
  }

  const cacheKey = `${malId}:${episodeNumber}`;
  if (memCache.has(cacheKey)) {
    return memCache.get(cacheKey)!;
  }

  const pending = inflight.get(cacheKey);
  if (pending) return pending;

  const promise = (async (): Promise<EpisodeSkipTimes> => {
    // 1. Check persistent cache
    try {
      const raw = await storage.getItem(CACHE_PREFIX + cacheKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        const ttl = parsed.data?.found ? CACHE_TTL_MS : NOT_FOUND_TTL_MS;
        if (parsed.data && Date.now() - parsed.ts < ttl) {
          memCache.set(cacheKey, parsed.data);
          return parsed.data;
        }
      }
    } catch {}

    // 2. Fetch from AniSkip via the main process. The mobile app aborts after
    // 4s; the bridge has its own 15s cap, so race it to keep the same budget.
    const url = `https://api.aniskip.com/v2/skip-times/${malId}/${episodeNumber}?types[]=op&types[]=ed&episodeLength=${Math.round(durationSeconds)}`;

    try {
      const bridged = (window.pantoufa?.fetchJson?.({ url, headers: { Accept: "application/json" } }) ?? Promise.resolve(null))
        .catch(() => null);
      const text = await Promise.race([
        bridged,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
      ]);

      // ponytail: the IPC bridge returns null for every failure, so a 404, a
      // timeout and an offline blip all read as "no skip times" and share the
      // 3-day miss cache. Add a status-returning bridge if offline misses bite.
      let result: EpisodeSkipTimes;
      try { result = text ? parseAniSkipResponse(JSON.parse(text)) : { found: false }; }
      catch { result = { found: false }; }

      memCache.set(cacheKey, result);
      try {
        await storage.setItem(CACHE_PREFIX + cacheKey, JSON.stringify({ ts: Date.now(), data: result }));
      } catch {}
      return result;
    } catch {
      return { found: false };
    } finally {
      inflight.delete(cacheKey);
    }
  })();

  inflight.set(cacheKey, promise);
  return promise;
}

/**
 * High-level helper: resolve anime MAL ID and fetch episode skip times.
 */
export async function getEpisodeSkipTimes({
  title,
  episodeNumber,
  slugOrUrl,
  durationSeconds = 0,
}: {
  title?: string | null;
  episodeNumber?: number | null;
  slugOrUrl?: string | null;
  durationSeconds?: number;
}): Promise<EpisodeSkipTimes> {
  if (!episodeNumber || episodeNumber < 1) {
    return { found: false };
  }

  const malId = await resolveMalId(title, slugOrUrl);
  if (!malId) {
    return { found: false };
  }

  return fetchSkipTimesFromApi(malId, episodeNumber, durationSeconds);
}
