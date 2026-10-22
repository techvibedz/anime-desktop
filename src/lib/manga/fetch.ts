// Manga network layer (desktop) — the mobile recipe on Electron primitives: a
// main-process GET first (net.fetch: no CORS, rides the DoH resolver), and when
// the page is missing or lacks the expected marker (Cloudflare challenge, bot
// wall), render the URL in a hidden scraper window — a real browser that
// solves CF challenges — and hand back the rendered HTML. Callers never care
// which path won.

import { EXTRACT_RENDERED_HTML } from "../scripts";

export function looksLikeCfChallenge(html: string): boolean {
  // Cloudflare also adds challenge-platform/jsd to valid pages; that is not a block.
  return /just a moment|cf-browser-verification|cf_chl_opt|id=["']cf-please-wait["']|Checking your browser|Attention Required/i.test(html);
}

// One in-flight browser render per URL — the hub and a prefetch can ask for
// the same page at the same moment; both wait on the same browser trip.
const renderInflight = new Map<string, Promise<string | null>>();

async function fetchViaBrowser(url: string, marker: string, rawText = false): Promise<string | null> {
  const key = `${rawText}|${marker}|${url}`;
  const existing = renderInflight.get(key);
  if (existing) return existing;
  const pending = (async () => {
    // A plain hidden Electron window clears the manga hosts' Cloudflare
    // challenge in ~4s even cold (and earns the cookie the reader's page
    // images need); the WebView2 scraper below is the fallback.
    try {
      const html = await window.pantoufa.cfRender?.({ url, marker, rawText, timeoutMs: 25_000 });
      if (typeof html === "string" && html.length > 0 && !looksLikeCfChallenge(html) && (!marker || html.includes(marker))) return html;
    } catch {
      // fall through to the WebView2 scraper
    }
    try {
      const result = (await window.pantoufa.scrape({
        url,
        injectAfter: EXTRACT_RENDERED_HTML(marker, rawText, 26_000),
        timeoutMs: 28_000,
      })) as { html?: string | null } | null;
      const html = result?.html;
      return typeof html === "string" && html.length > 0 && !looksLikeCfChallenge(html) && (!marker || html.includes(marker)) ? html : null;
    } catch {
      return null;
    }
  })().finally(() => renderInflight.delete(key));
  renderInflight.set(key, pending);
  return pending;
}

/**
 * Fetch a manga page as HTML. `marker` is a substring that must exist in a
 * VALID page (e.g. "wp-manga", "chapter/") — when the direct response is a
 * challenge/placeholder page that lacks it, the browser fallback runs.
 * With no marker, any non-empty direct response wins.
 */
export async function fetchMangaHtml(
  url: string,
  referer?: string,
  marker = "",
): Promise<string | null> {
  let direct: string | null = null;
  try {
    // Manga sites answer fast or not at all when Cloudflare is in the way;
    // fail into the browser quickly instead of burning a long retry ladder.
    direct = (await window.pantoufa.fetchHtml?.(url, referer, { attempts: 2, timeoutMs: 8000 })) ?? null;
  } catch {
    direct = null;
  }
  if (direct && !looksLikeCfChallenge(direct) && (!marker || direct.includes(marker))) return direct;
  return fetchViaBrowser(url, marker);
}

/** JSON endpoints use the same browser verification fallback as HTML pages. */
export async function fetchMangaJson<T>(url: string, referer?: string): Promise<T | null> {
  const text = await fetchMangaRawText(url, referer);
  if (text == null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Raw text variant of fetchMangaJson (search APIs that parse their own body). */
export async function fetchMangaRawText(url: string, referer?: string): Promise<string | null> {
  try {
    const text = await window.pantoufa.fetchJson?.({
      url,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "ar,en;q=0.9",
        ...(referer ? { Referer: referer } : {}),
      },
    });
    if (text && !looksLikeCfChallenge(text)) return text;
  } catch {
    // fall through to the browser
  }
  return fetchViaBrowser(url, "", true);
}

/** Main-process POST (no CORS) — 3asq's chapter list is only served to a POST. */
export async function postMangaText(url: string, headers: Record<string, string>): Promise<string | null> {
  try {
    return (await window.pantoufa.fetchJson?.({ url, method: "POST", headers, body: "" })) ?? null;
  } catch {
    return null;
  }
}
