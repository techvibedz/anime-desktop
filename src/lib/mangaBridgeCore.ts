// Pure anime → manga bridge logic (no RN imports — unit-tested under tsx).
//
// The edge function stores, per anime season, where it sits in its source
// material (AniList-grounded AI answer). Users can correct it: one vote per
// user per anime, and a community answer overrides the AI once enough
// people agree on a different chapter.

export type BridgeSource = "manga" | "light_novel" | "web_novel" | "original" | "game" | "other";

export interface BridgePayload {
  source: BridgeSource;
  anilistAnimeId?: number | null;
  anilistMangaId?: number | null;
  mangaTitle?: string;
  mangaTitleEnglish?: string;
  mangaTitleNative?: string;
  mangaSynonyms?: string[];
  mangaFormat?: string | null;
  mangaChapters?: number | null;
  mangaVolumes?: number | null;
  mangaStatus?: string | null;
  airing?: boolean;
  startChapter?: number | null;
  endChapter?: number | null;
  endVolume?: number | null;
  confidence?: "high" | "medium" | "low";
  note?: string;
}

export interface BridgeVote {
  ch: number;
  n: number;
}

export interface BridgeView {
  /** Last chapter the anime adapts, or null when unknown. */
  endChapter: number | null;
  /** First chapter to read after the anime. */
  continueChapter: number | null;
  endVolume: number | null;
  /** Where the chapter number came from. */
  basis: "ai" | "community" | "none";
  /** Distinct users agreeing with the shown chapter (community votes). */
  agree: number;
  /** True when the number is shaky (AI low confidence, no community backing). */
  uncertain: boolean;
  /** The anime adapted the whole (finished) manga — nothing left to continue. */
  coversAll: boolean;
}

/** Votes needed before the community overrides a confident AI answer. */
export const COMMUNITY_OVERRIDE_VOTES = 3;

export function continueFrom(end: number | null): number | null {
  if (end == null || !(end > 0)) return null;
  return Number.isInteger(end) ? end + 1 : Math.ceil(end);
}

export function resolveBridgeView(payload: BridgePayload | null, votes: BridgeVote[]): BridgeView {
  const ai = payload?.endChapter ?? null;
  const confidence = payload?.confidence ?? "low";
  const sorted = [...votes].filter((v) => v.ch > 0 && v.n > 0).sort((a, b) => b.n - a.n || b.ch - a.ch);
  const top = sorted[0];
  const aiAgree = ai == null ? 0 : sorted.find((v) => v.ch === ai)?.n ?? 0;

  let end: number | null = ai;
  let basis: BridgeView["basis"] = ai == null ? "none" : "ai";
  let agree = aiAgree;

  if (top && top.ch !== ai) {
    const beatsAi =
      ai == null ? top.n >= 1 :
      confidence === "low" ? top.n >= 2 && top.n > aiAgree :
      top.n >= COMMUNITY_OVERRIDE_VOTES && top.n > aiAgree;
    if (beatsAi) {
      end = top.ch;
      basis = "community";
      agree = top.n;
    }
  }
  if (basis === "ai" && aiAgree > 0) basis = aiAgree >= 2 ? "community" : "ai";

  const uncertain = end == null || (basis === "ai" && confidence === "low") || (basis === "community" && agree < 2 && ai == null);
  const total = payload?.mangaChapters ?? null;
  const coversAll = end != null && total != null && total > 0 && payload?.mangaStatus === "FINISHED" && end >= total;
  return {
    endChapter: end,
    continueChapter: coversAll ? null : continueFrom(end),
    coversAll,
    endVolume: payload?.endVolume ?? null,
    basis,
    agree,
    uncertain,
  };
}

/** Should the detail page show the bridge card at all? */
export function bridgeIsShowable(payload: BridgePayload | null): boolean {
  if (!payload) return false;
  return payload.source === "manga" || payload.source === "light_novel" || payload.source === "web_novel";
}

/** Candidate titles to look the manga up by in the Arabic manga sources. */
export function bridgeSearchTitles(payload: BridgePayload, animeTitle: string): string[] {
  const out: string[] = [];
  const push = (s?: string | null) => {
    const v = (s || "").trim();
    if (v && v.length <= 120 && !out.some((o) => o.toLowerCase() === v.toLowerCase())) out.push(v);
  };
  push(payload.mangaTitleEnglish);
  push(payload.mangaTitle);
  for (const syn of payload.mangaSynonyms ?? []) if (/^[\x20-\x7E]+$/.test(syn)) push(syn);
  // The anime's own title is usually the manga's title too (minus season tags).
  push(animeTitle.replace(/\b(season|part|cour)\s*\d+\b|\b\d+(st|nd|rd|th)\s+season\b|الموسم\s*\S+/gi, "").trim());
  return out.slice(0, 6);
}

/**
 * Pick the chapter to open: exactly `want` when present, else the first
 * chapter after it (sources skip numbers), else null.
 */
export function pickChapter<T extends { number: string }>(chapters: T[], want: number): T | null {
  let best: T | null = null;
  let bestN = Infinity;
  for (const ch of chapters) {
    const n = parseFloat(String(ch.number).replace(/[^\d.]/g, ""));
    if (!Number.isFinite(n)) continue;
    if (n === want) return ch;
    if (n > want && n < bestN) {
      best = ch;
      bestN = n;
    }
  }
  return best && bestN - want <= 3 ? best : null;
}
