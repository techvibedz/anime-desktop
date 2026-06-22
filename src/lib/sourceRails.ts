// Source-direct home rails — the "this season" + "movies" rails on the home
// screen, scraped straight from our own sources (anime4up season page,
// witanime movie listing) in ONE static GET each. Each card already carries its
// real source URL, so a tap opens the detail page directly with zero
// resolution, and the whole rail is one cheap GET cached on disk for 12h.
// Ported from the mobile app (lib/sourceRails.ts); AsyncStorage → storage shim.

import { storage } from "./storage";
import { fetchWitMoviesListing, fetchAnime4upSeasonListing } from "./scraper";

export type RailKind = "movies" | "season";

export interface RailItem {
  id: number;
  title: string;
  image: string | null;
  /** Real source anime URL — the card opens /anime/<href> directly. */
  href: string;
}

const PREFIX = "@source_rail_v1:";
const TTL = 12 * 60 * 60 * 1000; // 12h

function hashId(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function toItems(cards: { title: string; href: string; image: string | null }[]): RailItem[] {
  const out: RailItem[] = [];
  const seen = new Set<number>();
  for (const c of cards) {
    if (!c.href || !c.title) continue;
    const id = hashId(c.href);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, title: c.title, image: c.image, href: c.href });
  }
  return out;
}

async function fetchRailRaw(kind: RailKind): Promise<RailItem[]> {
  const cards = kind === "movies"
    ? await fetchWitMoviesListing()
    : await fetchAnime4upSeasonListing();
  return cards ? toItems(cards) : [];
}

type Cached = { ts: number; data: RailItem[] };
const inflight = new Map<RailKind, Promise<RailItem[]>>();

/** Fresh on-disk cache for a rail, or null when absent/stale. */
export async function readRailCache(kind: RailKind): Promise<RailItem[] | null> {
  try {
    const raw = await storage.getItem(PREFIX + kind);
    if (raw) {
      const p: Cached = JSON.parse(raw);
      if (Date.now() - p.ts < TTL && Array.isArray(p.data) && p.data.length > 0) return p.data;
    }
  } catch {}
  return null;
}

/**
 * The full source-direct list for a rail. Serves the 12h disk cache instantly
 * when fresh; otherwise does one static GET, caches it, and returns it. Returns
 * [] (never throws) when the source is unreachable so the rail just stays hidden.
 */
export async function getRail(kind: RailKind): Promise<RailItem[]> {
  const cached = await readRailCache(kind);
  if (cached) return cached;

  const pending = inflight.get(kind);
  if (pending) return pending;

  const promise = (async () => {
    try {
      const data = await fetchRailRaw(kind).catch(() => [] as RailItem[]);
      if (data.length > 0) {
        try { await storage.setItem(PREFIX + kind, JSON.stringify({ ts: Date.now(), data } as Cached)); } catch {}
      }
      return data;
    } finally {
      inflight.delete(kind);
    }
  })();
  inflight.set(kind, promise);
  return promise;
}
