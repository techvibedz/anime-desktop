// Live-poster repair for saved records (favorites / history / downloads).
//
// witanime rotates TLDs and retired its WordPress uploads, so an artwork URL a
// record still carries (witanime.life/wp-content/…, witanime.you/…) now 301s to
// the site HOMEPAGE. The <img> never fires onload, which is the "the images
// keep loading" bug: the card shimmers forever. The record still has its page
// URL, and every source ships the poster in the page HTML (the CDN poster path
// or og:image), so re-resolve it with one static GET — cached, so a repaired
// poster costs nothing after the first time.

import { useCallback, useEffect, useState } from "react";
import { storage } from "./storage";

const CACHE_KEY = "@poster_fix_v1";
const POSITIVE_TTL = 30 * 24 * 60 * 60 * 1000;
const NEGATIVE_TTL = 6 * 60 * 60 * 1000;

// Poster URL shapes, newest source first. All are hotlink-safe absolute URLs.
const POSTER_RES: RegExp[] = [
  /https?:\/\/images\.witanime\.site\/posters\/[\w.-]+\.(?:jpe?g|png|webp)/i,
  /https?:\/\/[^/"'\s>]*anime4up[^/"'\s>]*\/wp-content\/uploads\/[^"'\s>]+?\.(?:jpe?g|png|webp)/i,
  /https?:\/\/images\.anime3rb\.com\/[^"'\s>]+?\.(?:jpe?g|png|webp)/i,
];
const OG_RE = /<meta[^>]+(?:property|name)=["']og:image["'][^>]*?content=["']([^"']+)["']/i;
const OG_REV_RE = /<meta[^>]+content=["']([^"']+)["'][^>]*?(?:property|name)=["']og:image["']/i;

/** A URL on a retired witanime host (or its dead wp-content uploads). */
export function isRetiredPoster(url: string | null | undefined): boolean {
  const value = String(url || "").trim();
  if (!value) return true;
  if (/^https?:\/\/[^/]*images\.witanime\./i.test(value)) return false;
  return /^https?:\/\/[^/]*witanime\./i.test(value);
}

/** First real poster URL in a page's HTML (CDN path, else og:image). */
export function posterFromHtml(html: string): string | null {
  const body = String(html || "");
  for (const re of POSTER_RES) {
    const hit = body.match(re)?.[0];
    if (hit) return hit.replace(/&amp;/g, "&");
  }
  const og = (body.match(OG_RE)?.[1] || body.match(OG_REV_RE)?.[1] || "").trim();
  if (og && !/og-default|favicon|logo|placeholder/i.test(og)) return og.replace(/&amp;/g, "&");
  return null;
}

/** The live page for a saved href — hosts rotate, paths are stable. */
export function canonicalPageUrl(raw: string | null | undefined): string | null {
  const value = String(raw || "").trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.protocol = "https:";
    if (/(^|\.)witanime\./i.test(url.hostname) && !/\.site$/i.test(url.hostname)) url.host = "witanime.site";
    else if (/anime4up/i.test(url.hostname)) url.host = "w1.anime4up.rest";
    else if (/anime3rb/i.test(url.hostname)) url.host = "anime3rb.com";
    return url.toString();
  } catch {
    return null;
  }
}

function refererFor(pageUrl: string): string {
  try { return `${new URL(pageUrl).origin}/`; } catch { return "https://witanime.site/"; }
}

type CacheEntry = { url: string; ts: number };
let cache: Map<string, CacheEntry> | null = null;

async function loadCache(): Promise<Map<string, CacheEntry>> {
  if (cache) return cache;
  cache = new Map();
  try {
    const raw = await storage.getItem(CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object") {
      for (const [key, value] of Object.entries(parsed as Record<string, CacheEntry>)) {
        if (value && typeof value.url === "string" && typeof value.ts === "number") cache.set(key, value);
      }
    }
  } catch {}
  return cache;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const entries = Object.fromEntries(Array.from(cache?.entries() || []).slice(-200));
    void storage.setItem(CACHE_KEY, JSON.stringify(entries));
  }, 1500);
}

const inFlight = new Map<string, Promise<string | null>>();

/**
 * Resolve the live poster for a record's page URL. Cached (memory +
 * localStorage): one request per page, then free for the next 30 days.
 */
export function repairPoster(pageUrlHint: string | null | undefined): Promise<string | null> {
  const pageUrl = canonicalPageUrl(pageUrlHint);
  if (!pageUrl) return Promise.resolve(null);
  const pending = inFlight.get(pageUrl);
  if (pending) return pending;

  const run = (async () => {
    const store = await loadCache();
    const hit = store.get(pageUrl);
    if (hit) {
      const ttl = hit.url ? POSITIVE_TTL : NEGATIVE_TTL;
      if (Date.now() - hit.ts < ttl) return hit.url || null;
    }
    const html = await window.pantoufa.fetchHtml?.(pageUrl, refererFor(pageUrl), { attempts: 1, timeoutMs: 9000 }).catch(() => null);
    const poster = html ? posterFromHtml(html) : null;
    store.set(pageUrl, { url: poster || "", ts: Date.now() });
    scheduleSave();
    return poster;
  })().finally(() => { inFlight.delete(pageUrl); });

  inFlight.set(pageUrl, run);
  return run;
}

/**
 * Poster for a saved record. Starts from the stored URL; when that host is
 * retired (or the image fails) it re-resolves once from the record's page.
 * Callers show a shimmer while `repairing` and a static placeholder when
 * `failed`, so a dead poster can never look like it is still loading.
 */
export function usePosterImage(
  src: string | null | undefined,
  pageUrl: string | null | undefined,
): { src?: string; repairing: boolean; failed: boolean; onError: (event?: { currentTarget?: { currentSrc?: string } }) => void } {
  const stale = isRetiredPoster(src);
  const [state, setState] = useState<{ url: string; done: boolean }>(() => ({
    url: stale ? "" : String(src || "").trim(),
    done: !stale,
  }));

  // `current` is the URL that just failed (from the <img>, so it can't be a
  // stale closure). A repair that yields the same URL would loop forever, so
  // it is treated as a failure instead.
  const repair = useCallback((current: string) => {
    setState({ url: "", done: false });
    return repairPoster(pageUrl)
      .then((fixed) => setState(fixed && fixed !== current ? { url: fixed, done: true } : { url: "", done: true }))
      .catch(() => setState({ url: "", done: true }));
  }, [pageUrl]);

  useEffect(() => {
    if (stale) { void repair(""); return; }
    setState({ url: String(src || "").trim(), done: true });
  }, [src, stale, repair]);

  return {
    src: state.url || undefined,
    repairing: !state.url && !state.done,
    failed: !state.url && state.done,
    onError: (event) => {
      const failedUrl = String(event?.currentTarget?.currentSrc || state.url || "");
      void repair(failedUrl);
    },
  };
}
