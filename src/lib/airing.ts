// Minimal "next airing episode" lookup (AniList) — the airing gate behind the
// completion feature's finished vs. caught-up distinction. Ported lean from the
// mobile app (lib/airing.ts): title search only, no alt-title bridge, cached.

import { storage } from "./storage";

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
      nextAiringEpisode { airingAt episode }
    }
  }
}`;

// Prefer the Electron main process (net.fetch: no CORS, DoH-routed); fall back
// to the renderer fetch when the bridge is unavailable (browser dev).
async function anilistPost(variables: Record<string, unknown>): Promise<any | null> {
  const body = JSON.stringify({ query: QUERY, variables });
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
