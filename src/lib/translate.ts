// Lightweight English→Arabic translation for AniList-sourced text (the upcoming
// title detail page). AniList has no Arabic synopses, so to keep that screen
// fully Arabic we translate the English description on the fly via Google's
// keyless `gtx` endpoint, cache the result on disk + in memory (translations are
// stable), and fall back to the original text if the service is unreachable.
// Ported from the mobile app (lib/translate.ts); AsyncStorage → storage shim.

import { storage } from "./storage";

const CACHE_PREFIX = "@translate_ar_v1:";
const mem = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

// Already-Arabic text is returned untouched — no point round-tripping it.
function isMostlyArabic(s: string): boolean {
  const ar = s.match(/[؀-ۿ]/g);
  return !!ar && ar.length / s.length > 0.3;
}

async function gtxTranslate(text: string): Promise<string> {
  const url =
    `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ar&dt=t&q=${encodeURIComponent(text)}`;
  // Prefer the main process (net.fetch: no CORS, DoH-routed); fall back to the
  // renderer's fetch when the bridge is unavailable.
  let json: any = null;
  try {
    const viaMain = await window.pantoufa?.fetchJson?.({ url, headers: { Accept: "application/json" } });
    if (viaMain) json = JSON.parse(viaMain);
  } catch {}
  if (!json) {
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) return "";
      json = await res.json();
    } catch {
      return "";
    }
  }
  // Shape: [ [ [translatedSegment, originalSegment, …], … ], … ]
  if (!Array.isArray(json) || !Array.isArray(json[0])) return "";
  return json[0].map((seg: any) => (Array.isArray(seg) ? seg[0] : "")).join("");
}

/** Translate English text to Arabic (cached). Returns the original on failure. */
export async function translateToArabic(text: string): Promise<string> {
  const input = (text || "").trim();
  if (!input) return "";
  if (isMostlyArabic(input)) return input;

  const key = hash(input);
  const cachedMem = mem.get(key);
  if (cachedMem) return cachedMem;
  const pending = inflight.get(key);
  if (pending) return pending;

  const p = (async () => {
    try {
      const raw = await storage.getItem(CACHE_PREFIX + key);
      if (raw) { mem.set(key, raw); return raw; }
    } catch {}
    const out = await gtxTranslate(input).catch(() => "");
    const result = out || input; // graceful fallback to the source text
    if (out) {
      mem.set(key, result);
      try { await storage.setItem(CACHE_PREFIX + key, result); } catch {}
    }
    return result;
  })().finally(() => { inflight.delete(key); });

  inflight.set(key, p);
  return p;
}
