// Anime → manga bridge: find the bridged work in the Arabic manga sources.
//
// Pure planning + scoring (tested under tsx). The source search engines are
// exact-ish phrase matchers: "Demon Slayer: Kimetsu no Yaiba" returns nothing
// on 3asq while "Kimetsu no Yaiba" finds it, "HUNTER×HUNTER" finds nothing
// while "Hunter x Hunter" does, and the AI payload is sometimes missing its
// manga titles entirely. So the lookup searches many spellings (full titles,
// colon halves, bare key words — what a human would type), and every returned
// card is scored against ALL known names of the work, not just the query that
// returned it.

import { strictTitleScore } from "./manga/aggregate";
import { normFuzzy, wordSearchFallbacks } from "./fuzzy";
import type { BridgePayload } from "./mangaBridgeCore";

/** Minimum score a card needs to count as the bridged work. */
export const BRIDGE_MATCH_MIN = 0.86;
/** Score that ends the search early (an exact title showed up). */
export const BRIDGE_MATCH_EXACT = 0.98;

/** A name of the work and how much a match against it is worth. */
export interface BridgeName {
  title: string;
  weight: number;
}

const ARABIC = /[؀-ۿ]/;

/** Words too common to search on their own. */
const WEAK_WORDS = new Set([
  "kara", "wo", "after", "with", "from", "into", "item", "world", "life", "another",
  "isekai", "story", "monogatari", "shinhenshuuban", "henshuu", "edition", "final",
]);
const LATIN_ONLY = /^[\x20-\x7E]+$/;

/** Season / cut / edition decorations the anime title carries but the manga doesn't. */
const ANIME_DECOR =
  /\b(season|part|cour)\s*\d+\b|\b\d+(st|nd|rd|th)\s+(season|part|cour)\b|\b(final|new)\s+season\b|\bshin\s+henshuu[\s-]*ban\b|\b(the\s+)?movie\b|\(tv\)|\btv\b|\b(ii|iii|iv|v|vi)\s*$|الموسم\s*\S+|الجزء\s*\S+/gi;

/** Sources tag alternate cuts — strip them to compare the base work. */
const CARD_DECOR =
  /\s*[([（【][^)\]）】]*[)\]）】]\s*|\s+[–—-]\s+(digital\s+)?colou?r(ed)?\b.*$|\s+(full\s+)?colou?r(ed)?(\s+edition)?\s*$|\s+(digital\s+)?colored\s*$/gi;

/** Fold the punctuation that breaks phrase search ("×" → " x ", "卍" → " "). */
export function cleanBridgeTitle(s: string): string {
  return String(s || "")
    .replace(/[×✕✖]/g, " x ")
    .replace(/[卍☆★♪†・]/g, " ")
    .replace(/[’`]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function stripAnimeDecor(s: string): string {
  return cleanBridgeTitle(s.replace(ANIME_DECOR, " ").replace(/[:\-–—\s]+$/g, ""));
}

export function stripCardDecor(s: string): string {
  return cleanBridgeTitle(s.replace(CARD_DECOR, " "));
}

/** "Demon Slayer: Kimetsu no Yaiba" → ["Demon Slayer", "Kimetsu no Yaiba"].
 * "Re:Zero kara…" stays whole (a short head is part of the name). */
export function titleHalves(s: string): string[] {
  const m = /^(.+?)\s*(?::|\s[–—-]\s)\s*(.+)$/.exec(s);
  if (!m) return [];
  const out: string[] = [];
  for (const part of [m[1], m[2]]) {
    const key = normFuzzy(part).replace(/\s/g, "");
    if (key.length >= 5) out.push(part.trim());
  }
  return out;
}

/**
 * Every name the work goes by, weighted: payload titles and synonyms at full
 * weight (Arabic synonyms included — some sources title works in Arabic),
 * the season-stripped anime title at full weight, colon halves slightly lower
 * so "Solo Leveling: Ragnarok" never beats a real "Solo Leveling: Ragnarok"
 * card with plain "Solo Leveling".
 */
export function bridgeNames(payload: BridgePayload, animeTitle: string, extra: string[] = []): BridgeName[] {
  const out: BridgeName[] = [];
  const add = (raw: string | null | undefined, weight: number) => {
    const title = cleanBridgeTitle(raw || "");
    if (!title || title.length > 140) return;
    const key = normFuzzy(title);
    if (!key) return;
    const existing = out.find((n) => normFuzzy(n.title) === key);
    if (existing) existing.weight = Math.max(existing.weight, weight);
    else out.push({ title, weight });
  };
  const usable = (s: string) => LATIN_ONLY.test(s) || ARABIC.test(s);
  const primary = [payload.mangaTitleEnglish, payload.mangaTitle, ...extra];
  for (const t of primary) add(t, 1);
  for (const syn of payload.mangaSynonyms ?? []) if (usable(syn)) add(syn, 1);
  const anime = stripAnimeDecor(animeTitle);
  add(anime, 1);
  for (const t of [...primary, anime]) {
    if (!t) continue;
    const stripped = stripAnimeDecor(t);
    if (stripped !== cleanBridgeTitle(t)) add(stripped, 0.97);
    for (const half of titleHalves(cleanBridgeTitle(t))) add(half, 0.93);
  }
  return out;
}

/**
 * Search plan, in two waves. Wave 1: the full names (what the AI said).
 * Wave 2: colon halves and single key words — the short queries a person
 * types into the search box, which phrase-matching sources DO answer.
 */
export function bridgeQueryPlan(names: BridgeName[]): { first: string[]; second: string[] } {
  const seen = new Set<string>();
  const take = (q: string, into: string[]) => {
    const key = normFuzzy(q);
    if (!key || key.length < 3 || seen.has(key)) return;
    seen.add(key);
    into.push(q);
  };
  const first: string[] = [];
  const second: string[] = [];
  for (const n of names) if (n.weight >= 1 && LATIN_ONLY.test(n.title)) take(n.title, first);
  for (const n of names) if (n.weight >= 1 && ARABIC.test(n.title)) take(n.title, first);
  for (const n of names) if (n.weight < 1) take(n.title, second);
  // Key words of the main (Latin) names: "kimetsu", "hunter", "mushoku".
  for (const n of names.filter((x) => x.weight >= 1 && LATIN_ONLY.test(x.title)).slice(0, 3)) {
    // The most distinctive words first (longest), never bare numbers or
    // romaji particles that match half the catalog.
    const words = wordSearchFallbacks(n.title, 8)
      .filter((w) => w.length >= 4 && !/^\d+$/.test(w) && !WEAK_WORDS.has(w))
      .sort((a, b) => b.length - a.length)
      .slice(0, 2);
    for (const w of words) take(w, second);
  }
  // Normalized spelling of the main names ("re zero kara…").
  for (const n of names.filter((x) => x.weight >= 1).slice(0, 2)) take(normFuzzy(n.title), second);
  return { first: first.slice(0, 6), second: second.slice(0, 7) };
}

function compactKey(s: string): string {
  return normFuzzy(cleanBridgeTitle(s)).replace(/\b(the|of|a|an|no|wa|ga)\b/g, "").replace(/\s+/g, "");
}

/** How well a source card's title matches any name of the bridged work (0..1). */
export function bridgeCardScore(names: BridgeName[], cardTitle: string): number {
  const raw = cleanBridgeTitle(cardTitle);
  if (!raw) return 0;
  const base = stripCardDecor(raw);
  const cardCompact = compactKey(raw);
  const baseCompact = compactKey(base);
  let best = 0;
  for (const { title, weight } of names) {
    let s = strictTitleScore(title, raw);
    // "Ao Ashi" vs "Aoashi", "Blue Lock" vs "Bluelock".
    const nc = compactKey(title);
    if (nc && nc.length >= 4 && nc === cardCompact) s = Math.max(s, 0.97);
    // Alternate cuts ("– colored", "(Team Argo)") are the same work, but the
    // plain card must win when both exist.
    if (base && base !== raw) {
      let b = strictTitleScore(title, base);
      if (nc && nc.length >= 4 && nc === baseCompact) b = Math.max(b, 0.97);
      s = Math.max(s, b * 0.9);
    }
    best = Math.max(best, s * weight);
  }
  return best;
}

export interface RankedCard<T> {
  card: T;
  score: number;
}

/** Rank cards (best first) — ties prefer the card whose chapter list is larger. */
export function rankBridgeCards<T extends { title: string; latest?: string | null }>(
  names: BridgeName[],
  cards: T[],
): RankedCard<T>[] {
  const latest = (c: T) => {
    const n = parseFloat(String(c.latest ?? "").replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[^\d.]/g, ""));
    return Number.isFinite(n) ? n : 0;
  };
  return cards
    .map((card) => ({ card, score: bridgeCardScore(names, card.title) }))
    .filter((r) => r.score >= BRIDGE_MATCH_MIN)
    .sort((a, b) => b.score - a.score || latest(b.card) - latest(a.card));
}
