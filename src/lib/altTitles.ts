// Cross-language alternative titles via Jikan (the free, key-less MyAnimeList
// API). The source sites index an anime under ONE language (sometimes only
// romaji, sometimes only English), so a query in the other language finds
// nothing. Jikan resolves the query to a MAL entry and hands back every name
// it's known by — romaji, English, Japanese and synonyms — which the caller
// re-probes the sites with, so "King's Game" finds "Ousama Game" and a witanime
// Arabic title bridges to anime3rb's Latin slug. Mirrors the mobile app's
// lib/animeInfo.ts getAltTitles, with RN fetch → window.pantoufa.fetchJson
// (the main-process privileged GET, which rides DoH and has no CORS).

function norm(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

const ARABIC_RE = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]+/g;

// witanime/anime4up titles carry Arabic season labels / parentheticals that
// Jikan's title search can't resolve — clean them off before querying.
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

// Jikan's plain `q` search often surfaces a side movie/OVA before the main
// series, so score every candidate's titles against the query and break ties by
// popularity (members) — the canonical entry is almost always the most popular.
function pickBest(candidates: any[], query: string): any | null {
  const q = norm(query);
  if (!q) return candidates[0] ?? null;
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
    }
    score += Math.min((c.members || 0) / 100000, 4);
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best;
}

// GET a Jikan endpoint via the main process, retrying the failures that actually
// happen in the wild (429 rate limit, 5xx transient). Returns parsed JSON / null.
async function jikanGet(url: string): Promise<any | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const text = await window.pantoufa.fetchJson?.({ url });
      if (text) {
        try { return JSON.parse(text); } catch { return null; }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
  }
  return null;
}

async function doFetchCandidates(title: string): Promise<any[]> {
  const cleaned = cleanQuery(title);
  const attempts = [cleaned, title.trim()].filter((q, i, a) => q && a.indexOf(q) === i);
  for (const q of attempts) {
    const json = await jikanGet(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(q)}&limit=8&sfw`);
    if (json?.data?.length) return json.data;
  }
  return [];
}

const altTitlesCache = new Map<string, string[]>();

/** Alternative names (romaji / English / Japanese / synonyms) for the best
 * Jikan match of `query`, most-canonical first. Empty array on any miss. */
export async function getAltTitles(query: string): Promise<string[]> {
  if (!query || !query.trim()) return [];
  const key = query.toLowerCase().trim();
  const cached = altTitlesCache.get(key);
  if (cached) return cached;
  try {
    const data = await doFetchCandidates(query);
    const best = pickBest(data, query);
    if (!best) { altTitlesCache.set(key, []); return []; }
    const raw: string[] = [
      best.title, best.title_english, best.title_japanese,
      ...(Array.isArray(best.titles) ? best.titles.map((t: any) => t?.title) : []),
      ...(Array.isArray(best.title_synonyms) ? best.title_synonyms : []),
    ].filter(Boolean);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const tt of raw) {
      const v = String(tt).trim();
      const k = v.toLowerCase();
      if (v && !seen.has(k)) { seen.add(k); out.push(v); }
    }
    altTitlesCache.set(key, out);
    return out;
  } catch {
    return [];
  }
}
