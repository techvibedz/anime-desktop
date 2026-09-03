// Minimal "next airing episode" lookup (AniList) — the airing gate behind the
// completion feature's finished vs. caught-up distinction. Ported lean from the
// mobile app (lib/airing.ts): title search only, no alt-title bridge, cached.

import { storage } from "./storage";
import { fuzzyScore } from "./fuzzy";

const ANILIST_URL = "https://graphql.anilist.co";
const CACHE_PREFIX = "@anime_airing_v1:";
const HIT_TTL = 6 * 60 * 60 * 1000;
const MISS_TTL = 24 * 60 * 60 * 1000;

export interface NextAiring {
  episode: number;
  airingAt: number;
}

const QUERY = `query ($search: String) {
  Page(perPage: 10) {
    media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
      title { romaji english native }
      synonyms
      status
      episodes
      nextAiringEpisode { airingAt episode }
    }
  }
}`;

// Prefer the Electron main process (net.fetch: no CORS, DoH-routed); fall back
// to the renderer fetch when the bridge is unavailable (browser dev).
async function anilistPost(variables: Record<string, unknown>, query: string = QUERY): Promise<any | null> {
  const body = JSON.stringify({ query, variables });
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  try {
    const viaMain = await (window as any).pantoufa?.fetchJson?.({ url: ANILIST_URL, method: "POST", body, headers });
    if (viaMain) return JSON.parse(viaMain);
  } catch {}
  try {
    const res = await fetch(ANILIST_URL, { method: "POST", headers, body });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function norm(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

function baseTitle(title: string): string {
  let s = (title || "").toLowerCase();
  s = s.split(/[:：]/)[0];
  s = s
    .replace(/\b\d+(st|nd|rd|th)\s+season\b.*$/i, "")
    .replace(/\bseason\s*\d+\b.*$/i, "")
    .replace(/\bpart\s*\d+\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return s;
}

function validAiring(n: any): NextAiring | null {
  if (!n || typeof n.airingAt !== "number" || typeof n.episode !== "number") return null;
  if (n.airingAt * 1000 <= Date.now()) return null;
  return { episode: n.episode, airingAt: n.airingAt };
}

function titleScore(c: any, queries: string[]): number {
  const titles = [c?.title?.romaji, c?.title?.english, c?.title?.native, ...(Array.isArray(c?.synonyms) ? c.synonyms : [])]
    .filter(Boolean)
    .map(norm)
    .filter(Boolean);
  let score = 0;
  for (const q of queries) {
    if (!q) continue;
    for (const nt of titles) {
      if (nt === q) score = Math.max(score, 1000);
      else if (nt.includes(q) || q.includes(nt)) score = Math.max(score, 500);
    }
  }
  return score;
}

function pickAiring(cands: any[], queries: string[]): NextAiring | null {
  if (!cands.length) return null;
  const ranked = cands.map((c) => ({ c, s: titleScore(c, queries) })).sort((a, b) => b.s - a.s);
  const good = ranked.filter((x) => x.s >= 500);
  const pool = (good.length ? good : ranked).map((x) => x.c);
  for (const c of pool) {
    const n = validAiring(c.nextAiringEpisode);
    if (n) return n;
  }
  return null;
}

function rankedCandidates(cands: any[], queries: string[]): any[] {
  const ranked = cands.map((c) => ({ c, s: titleScore(c, queries) })).sort((a, b) => b.s - a.s);
  const good = ranked.filter((x) => x.s >= 500);
  return (good.length ? good : ranked).map((x) => x.c);
}

function pickFinished(cands: any[], queries: string[], lastKnownEp?: number | null): boolean | null {
  for (const c of rankedCandidates(cands, queries)) {
    if (validAiring(c.nextAiringEpisode) || c.status === "RELEASING") return false;
    if (c.status === "FINISHED") {
      const total = typeof c.episodes === "number" ? c.episodes : null;
      if (total && lastKnownEp && lastKnownEp < total) return false;
      return true;
    }
  }
  return null;
}

async function search(s: string): Promise<any[]> {
  const json = await anilistPost({ search: s.trim() });
  return json?.data?.Page?.media || [];
}

/** Next airing episode, or null when the anime isn't currently airing. Cached. */
export async function fetchNextAiring(title: string): Promise<NextAiring | null> {
  if (!title || !title.trim()) return null;
  const key = title.toLowerCase().trim();
  try {
    const raw = await storage.getItem(CACHE_PREFIX + key);
    if (raw) {
      const parsed = JSON.parse(raw);
      const ttl = parsed.data ? HIT_TTL : MISS_TTL;
      const stillFuture = !parsed.data || parsed.data.airingAt * 1000 > Date.now();
      if (Date.now() - parsed.ts < ttl && stillFuture) return parsed.data;
    }
  } catch {}
  const base = baseTitle(title);
  const queries = [norm(title), norm(base)].filter(Boolean);
  let pick = pickAiring(await search(title), queries);
  if (!pick && base && base !== title.trim().toLowerCase()) {
    pick = pickAiring(await search(base), queries);
  }
  try { await storage.setItem(CACHE_PREFIX + key, JSON.stringify({ ts: Date.now(), data: pick })); } catch {}
  return pick;
}

/** True only when AniList explicitly says the matching series is finished. */
export async function fetchSeriesFinished(title: string, lastKnownEp?: number | null): Promise<boolean> {
  if (!title || !title.trim()) return false;
  const base = baseTitle(title);
  const queries = [norm(title), norm(base)].filter(Boolean);
  let pick = pickFinished(await search(title), queries, lastKnownEp);
  if (pick != null) return pick;
  if (base && base !== title.trim().toLowerCase()) {
    pick = pickFinished(await search(base), queries, lastKnownEp);
    if (pick != null) return pick;
  }
  return false;
}

/* ── Release year + movie/series format (AniList) ──
 * Powers the anime3rb old-vs-new disambiguation: franchises that have BOTH an
 * old film and a new TV remake share one base name ("Koukaku Kidoutai" 1995
 * vs "Koukaku Kidoutai (TV)" 2026), so title matching alone locks onto the
 * wrong entry — the release year / format is the only reliable discriminator.
 * Resolved via AniList (keyless), cached for a week. A null result simply
 * disables the check: the caller falls back to title-only matching. */
export type AnimeYearType = { year: number | null; isMovie: boolean | null };

const YT_CACHE_PREFIX = "@anime_yt_v1:";
const YT_TTL = 7 * 24 * 60 * 60 * 1000;
const ytMem = new Map<string, AnimeYearType>();
const YEAR_TYPE_QUERY = `query ($s: String) { Page(perPage: 5) { media(search: $s, type: ANIME) { title { romaji english } seasonYear format } } }`;

export async function getAnimeYearType(title: string): Promise<AnimeYearType> {
  const none: AnimeYearType = { year: null, isMovie: null };
  const q = (title || "").trim();
  // AniList's search is Latin-only — an Arabic title can't resolve, so skip
  // the network entirely and let the caller run its title-only fallback.
  if (!q || !/[a-z]/i.test(q)) return none;
  const key = q.toLowerCase();
  const hit = ytMem.get(key);
  if (hit) return hit;
  try {
    const raw = await storage.getItem(YT_CACHE_PREFIX + key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Date.now() - parsed.ts < YT_TTL) {
        ytMem.set(key, parsed.data);
        return parsed.data as AnimeYearType;
      }
    }
  } catch {}
  try {
    const json = await anilistPost({ s: q }, YEAR_TYPE_QUERY);
    const medias: any[] = json?.data?.Page?.media || [];
    let best: { score: number; year: number | null; isMovie: boolean | null } | null = null;
    for (const m of medias) {
      const romaji = m?.title?.romaji || "";
      const english = m?.title?.english || "";
      const sc = Math.max(fuzzyScore(q, romaji), english ? fuzzyScore(q, english) : 0);
      if (!best || sc > best.score) {
        best = {
          score: sc,
          year: typeof m?.seasonYear === "number" ? m.seasonYear : null,
          isMovie: m?.format == null ? null : m.format === "MOVIE",
        };
      }
    }
    // A weak best match means AniList resolved to a different anime entirely —
    // treat as unknown rather than disambiguate against the wrong year.
    const out: AnimeYearType = best && best.score >= 0.55 ? { year: best.year, isMovie: best.isMovie } : none;
    ytMem.set(key, out);
    // Only persist real hits — a miss is likely transient (rate-limit, offline)
    // and shouldn't be frozen for the whole week.
    if (out.year != null || out.isMovie != null) {
      try { await storage.setItem(YT_CACHE_PREFIX + key, JSON.stringify({ ts: Date.now(), data: out })); } catch {}
    }
    return out;
  } catch {
    return none;
  }
}
