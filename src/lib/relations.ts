// Related-anime logic + AniList network layer, ported from the mobile app
// (lib/relations.ts + the relation sections of lib/animeInfo.ts). The pure
// selection/shaping logic stays unit-testable; the fetch + week-long cache
// live at the bottom. The title→AniList bridge reuses malInfo's
// fetchAniListIdForTitle/getAltTitles so the desktop doesn't re-port Jikan.
//
// Bugs this module was shaped by:
//   1) "No related shown" — the scraped title is often Arabic or romanised
//      differently than AniList (macrons, spacing). Fixes: diacritic-folding
//      normalisation, season-preserving query variants, slug-derived queries,
//      multi-candidate scoring with a confidence threshold.
//   2) "Duplicate — the current anime shows as its own next season" — resolving
//      the wrong season made Season 1's SEQUEL (= the page you're on) appear.
//      Fixes: season-accurate resolution + canonical de-dupe + self-exclusion.
//   3) "Missing some" — AniList relations are only ONE hop, so non-adjacent
//      seasons never appeared. Fix: collectFranchise() walks the
//      SEQUEL/PREQUEL chain to gather the whole franchise.

import { storage } from "./storage";
import { arFormat } from "./anilistLabels";
import { getAltTitles } from "./altTitles";
import { anilistPost, fetchAniListIdForTitle } from "./malInfo";

export interface RelatedAnimeEntry {
  anilistId: number;
  title: string;          // romaji preferred — what the source sites index by
  titleEnglish: string | null;
  image: string | null;
  relation: string;       // Arabic relation label ("تكملة", "قصة جانبية", …)
  format: string | null;  // Arabic format label ("مسلسل", "فيلم", "OVA", …)
}

/* ── AniList response shapes (the subset we read) ── */

export interface AniListTitle { romaji?: string | null; english?: string | null; native?: string | null }
export interface AniListNode {
  id: number;
  type?: string | null;
  format?: string | null;
  title?: AniListTitle | null;
  coverImage?: { large?: string | null } | null;
}
export interface AniListMedia {
  id: number;
  type?: string | null;
  format?: string | null;
  title?: AniListTitle | null;
  synonyms?: string[] | null;
  relations?: { edges?: { relationType?: string | null; node?: AniListNode | null }[] | null } | null;
}

/* ── Relation + format label maps ── */

// Only these relation types surface as watchable cards, in display order.
// ADAPTATION/SOURCE (manga/novel) and other non-anime relations are dropped.
export const RELATION_AR: Record<string, string> = {
  SEQUEL: "تكملة",
  PREQUEL: "ما قبلها",
  PARENT: "القصة الأصلية",
  SIDE_STORY: "قصة جانبية",
  SPIN_OFF: "عمل مشتق",
  ALTERNATIVE: "نسخة بديلة",
  SUMMARY: "ملخص",
  CHARACTER: "شخصيات مشتركة",
  OTHER: "ذات صلة",
};
const RELATION_ORDER = Object.keys(RELATION_AR);
const RELATION_LABEL_ORDER = RELATION_ORDER.map((k) => RELATION_AR[k]);

// Arabic format labels come from the shared anilistLabels map; kept exported
// under the mobile name so callers importing FORMAT_AR keep working.
export const FORMAT_AR: Record<string, string> = Object.fromEntries(
  ["TV", "TV_SHORT", "MOVIE", "SPECIAL", "OVA", "ONA", "MUSIC"].map((f) => [f, arFormat(f) || f]),
);

const MAX_RELATED = 30;

/* ── Format category (for resolving a related card to the RIGHT source page) ──
 * A related card carries its AniList format (Arabic label from FORMAT_AR). When
 * the card is tapped we search the source sites by TITLE — but an OVA / movie /
 * special usually shares the base title with the main TV series, so a pure title
 * match opens the wrong page (e.g. a 1-episode OVA card landing on the 12-episode
 * series). formatCat() folds any title / type / format string to a coarse bucket
 * so the resolver can prefer the result whose format actually matches the card. */
export type FormatCat = "movie" | "ova" | "ona" | "special" | "music" | "tv" | "";
export function formatCat(s: string | null | undefined): FormatCat {
  const x = String(s || "").toLowerCase();
  if (!x) return "";
  if (/\bmovie\b|film|فيلم/.test(x)) return "movie";
  if (/\bova\b|أوفا|اوفا/.test(x)) return "ova";
  if (/\bona\b|أونا|اونا/.test(x)) return "ona";
  if (/special|حلقة خاصة|خاصة|خاص/.test(x)) return "special";
  if (/music|موسيق/.test(x)) return "music";
  if (/\btv\b|مسلسل|series/.test(x)) return "tv";
  return "";
}

/* ── Title normalisation + season parsing ── */

// Latin-only, lowercase, alphanumerics + spaces. Folds diacritics first so
// macron'd romaji ("Tōkyō", "Jūni") matches its plain spelling ("Tokyo",
// "Juni"), drops the Arabic block entirely (AniList is matched romaji-side),
// and collapses whitespace. Season words are KEPT here so the scorer sees
// them; canonTitle() strips them instead.
export function normLatin(s: string | null | undefined): string {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")  // strip combining diacritical marks
    .toLowerCase()
    .replace(/[\u0600-\u06ff]+/g, " ") // Arabic block
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// WitAnime prints season numerals with UNICODE roman characters ("Mushoku
// Tensei Ⅲ"), not ASCII "III", and AniList titles carry ASCII mid-title
// ("… III: …"). Fold Unicode romans to ASCII before any season/normalisation
// work so both spellings read identically. Mirrors lib/scraper/direct.ts.
const UNICODE_ROMAN: Record<string, string> = {
  "Ⅰ": "I", "Ⅱ": "II", "Ⅲ": "III", "Ⅳ": "IV", "Ⅴ": "V", "Ⅵ": "VI",
  "Ⅶ": "VII", "Ⅷ": "VIII", "Ⅸ": "IX", "Ⅹ": "X", "Ⅺ": "XI", "Ⅻ": "XII",
};
export function asciiRomans(s: string | null | undefined): string {
  return String(s || "").replace(/[\u2160-\u217f]/g, (ch) => UNICODE_ROMAN[ch] ?? ch);
}
// Roman-numeral season values. "I" is deliberately absent: season 1 is the
// default and a bare "I" is too collision-prone (English pronoun) to match.
const ROMAN_SEASON: Record<string, number> = {
  II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10,
};

// Detect an EXPLICIT season/part number from a title. Bare trailing numbers are
// deliberately NOT treated as seasons ("Jujutsu Kaisen 0", "86" must not be read
// as season 0 / 86) — only real markers count. Handles latin words, "2nd", "S2",
// arabic-indic digits and arabic ordinal words. Returns 0 when unspecified.
export function seasonNum(s: string | null | undefined): number {
  const folded = asciiRomans(s);
  let t = folded.toLowerCase();
  // arabic-indic digits → latin
  t = t.replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  const m =
    t.match(/(?:season|part|cour|الجزء|الموسم)\s*([0-9]+)/) ||
    t.match(/\b([0-9]+)(?:st|nd|rd|th)\s+season\b/) ||
    t.match(/\bs([0-9]+)\b/) ||
    t.match(/\bpart\s*([0-9]+)\b/);
  if (m) return parseInt(m[1], 10);
  const words: Record<string, number> = {
    first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6,
    الاول: 1, "الأول": 1, الثاني: 2, الثالث: 3, الرابع: 4, الخامس: 5, السادس: 6,
  };
  for (const k in words) if (t.indexOf(k) !== -1) return words[k];
  // Roman seasons may appear ANYWHERE, not just trailing: official markers
  // ("Mushoku Tensei III: Isekai Ittara Honki Dasu", "Shiguang Dailiren III")
  // and source slugs ("mushoku-tensei-iii-…"). Longest alternatives first so
  // "VIII" never degrades to "II" + leftover.
  const multi = t.match(/\b(viii|vii|vi|iv|ix|iii|ii)\b/);
  if (multi) return ROMAN_SEASON[multi[1].toUpperCase()];
  // Single V/X are deliberately NOT seasons here: they collide with real words
  // and title letters ("X-Men" → 10, "Mobile Suit V Gundam" → 5), and this
  // parser drives absolute decisions (MAL matching, AI context), not just
  // comparative source matching.
  return 0;
}

// Strip explicit SEASON markers so two spellings of the "same work, same
// season" collapse ("X 2nd Season" ≡ "X Season 2"). Format words (OVA / Movie /
// Special …) are deliberately KEPT — a "Show OVA" side story must stay distinct
// from the base "Show", or it would be wrongly excluded as the viewed anime.
function stripSeasonNoise(latin: string): string {
  return latin
    .replace(/\b([0-9]+)(?:st|nd|rd|th)\s+season\b/g, " ")
    .replace(/\b(season|part|cour)\s*[0-9]*\b/g, " ")
    .replace(/\bs[0-9]+\b/g, " ")
    .replace(/\b(first|second|third|fourth|fifth|sixth)\s+season\b/g, " ")
    .replace(/\b(i|ii|iii|iv|v|vi)\s*$/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// A canonical key that identifies "this exact work + season". "Jujutsu Kaisen
// 2nd Season" and "Jujutsu Kaisen Season 2" both → "jujutsu kaisen#2", while
// "Jujutsu Kaisen" → "jujutsu kaisen#0" stays distinct from its sequel.
export function canonTitle(title: string | null | undefined): string {
  const base = stripSeasonNoise(normLatin(title));
  return base + "#" + seasonNum(title);
}

function tokens(s: string): string[] {
  return s.split(" ").filter((w) => w.length > 1);
}

// Derive a romaji-ish title from a source URL slug. witanime/anime4up/anime3rb
// slugs are clean romaji ("/anime/tensei-shitara-slime-datta-ken-4th-season/")
// — far better AniList-matching material than an Arabic page title.
export function slugToTitle(href: string | null | undefined): string {
  if (!href) return "";
  try {
    const path = String(href).split(/[?#]/)[0].replace(/\/+$/, "");
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

/* ── Search-variant generation ── */

/** Split source-site bilingual titles into independently searchable aliases.
 * Witanime commonly emits "English title (Romaji title)"; AniList returns no
 * candidates for that combined string even though either half resolves. */
export function titleAliasParts(title: string | null | undefined): string[] {
  const raw = String(title || "").replace(/\s+/g, " ").trim();
  if (!raw) return [];
  const out: string[] = [];
  const add = (value: string) => {
    const clean = value.replace(/\s+/g, " ").trim();
    const key = clean.toLowerCase();
    if (clean.length > 1 && !out.some((item) => item.toLowerCase() === key)) out.push(clean);
  };
  const groups = Array.from(raw.matchAll(/[\(\[]([^\)\]]+)[\)\]]/g), (match) => match[1]);
  if (groups.length > 0) {
    add(raw.replace(/[\(\[][^\)\]]+[\)\]]/g, " "));
    for (const group of groups) add(group);
  }
  for (const part of raw.split(/\s+(?:\/|\||·)\s+/)) add(part);
  add(raw);
  return out;
}

// Ordered most-specific → least-specific. The season-preserving latin form
// comes FIRST so AniList resolves the correct season; cleaner fallbacks follow.
// When the title carries an Arabic season marker but a latin base (e.g.
// "Jujutsu Kaisen الموسم الثاني"), a "<base> Season N" variant is synthesised so
// the season still reaches AniList. An optional `slugTitle` (from the source
// URL) is folded in AFTER the title's own variants — it's the reliable romaji
// fallback for Arabic page titles the scrape couldn't romanise.
export function relSearchVariants(title: string, slugTitle?: string | null): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    const v = (s || "").replace(/\s+/g, " ").trim();
    if (v && v.length > 1 && out.indexOf(v) === -1) out.push(v);
  };
  const fromOne = (raw: string) => {
    const latin = normLatin(raw);
    const season = seasonNum(raw);
    const base = stripSeasonNoise(latin);
    add(latin);                                   // 1) as-is (keeps latin season)
    // 2) recover an Arabic-only season marker — but only when the latin base
    // does not already carry the marker itself (mid-title roman stays in the
    // base, so appending "Season N" would synthesize junk queries).
    if (season > 0 && base && seasonNum(base) === 0) add(`${base} Season ${season}`);
    add(base);                                    // 3) base / franchise
  };

  fromOne(title);
  if (slugTitle && normLatin(slugTitle) !== normLatin(title)) fromOne(slugTitle);
  return out;
}

// Merge variants across several known names of the same anime (scraped title +
// MAL romaji/English/synonyms) plus the source slug, most-specific first and
// de-duplicated. More spellings → more chances AniList's title search resolves
// the anime when one romanisation misses.
export function buildSearchQueries(titles: (string | null | undefined)[], slugTitle?: string | null): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (arr: string[]) => {
    for (const v of arr) if (!seen.has(v)) { seen.add(v); out.push(v); }
  };
  const list = titles
    .filter((t): t is string => !!t && t.trim().length > 0)
    .flatMap((title) => titleAliasParts(title));
  push(relSearchVariants(list[0] || "", slugTitle));
  for (let i = 1; i < list.length; i++) push(relSearchVariants(list[i]));
  return out;
}

/* ── Candidate scoring + selection ── */

function bestTitleScore(want: string, media: AniListMedia): number {
  const wl = normLatin(want);
  if (!wl) return 0;
  const cands = [
    media.title?.romaji,
    media.title?.english,
    media.title?.native,
    ...(Array.isArray(media.synonyms) ? media.synonyms : []),
  ].filter(Boolean) as string[];
  let best = 0;
  const wt = tokens(wl);
  for (const c of cands) {
    const cl = normLatin(c);
    if (!cl) continue;
    let s = 0;
    if (cl === wl) s = 100;
    else if (cl.indexOf(wl) === 0 || wl.indexOf(cl) === 0) s = 82;
    else if (cl.indexOf(wl) >= 0 || wl.indexOf(cl) >= 0) s = 70;
    else {
      const ct = tokens(cl);
      if (wt.length && ct.length) {
        const set = new Set(ct);
        let shared = 0;
        for (const w of wt) if (set.has(w)) shared++;
        s = Math.round((shared / Math.min(wt.length, ct.length)) * 64);
      }
    }
    if (s > best) best = s;
  }
  return best;
}

// Score a candidate 0..~110: title similarity, plus a season match bonus /
// mismatch penalty so a "Season 2" query doesn't latch onto Season 1.
export function scoreMedia(media: AniListMedia, wantTitle: string): number {
  let score = bestTitleScore(wantTitle, media);
  if (score <= 0) return 0;
  const wantSeason = seasonNum(wantTitle);
  const gotSeason = seasonNum(media.title?.romaji || media.title?.english || "");
  if (wantSeason > 0 && gotSeason > 0) {
    if (wantSeason === gotSeason) score += 10;
    else score -= 25;
  } else if (wantSeason > 0 && gotSeason === 0) {
    score -= 6; // wanted a specific season, candidate has none
  }
  return score;
}

// Pick the highest-scoring candidate that clears the confidence threshold.
// Returns null when nothing matches well enough (so we don't show a random
// anime's relations).
export function pickBestMedia(
  medias: AniListMedia[] | null | undefined,
  wantTitle: string,
  minScore = 50,
): AniListMedia | null {
  if (!Array.isArray(medias)) return null;
  let best: AniListMedia | null = null;
  let bestScore = -Infinity;
  for (const m of medias) {
    if (!m || (m.type && m.type !== "ANIME")) continue;
    const s = scoreMedia(m, wantTitle);
    if (s > bestScore) { bestScore = s; best = m; }
  }
  return bestScore >= minScore ? best : null;
}

/* ── Source-resolution scoring (shared by the Related tab + rec rail) ──
 * Resolving a card to a source page is the step that opens the actual wrong
 * anime, so the season penalty is HARSHER here than in scoreMedia above:
 * a "Season N" card must not settle for the base series when the site simply
 * doesn't carry that season — better to report "not found" than open Season 1. */

// Score how well a search result's title matches the wanted title. Latin-
// folded equality/containment first, then token overlap, plus the harsh season
// match bonus / mismatch penalty described above.
export function scoreRelatedMatch(want: string, got: string): number {
  const w = normLatin(want);
  const g = normLatin(got);
  if (!w || !g) return 0;
  let s: number;
  if (g === w) s = 100;
  else if (g.startsWith(w) || w.startsWith(g)) s = 82;
  else if (g.includes(w) || w.includes(g)) s = 70;
  else {
    const wt = w.split(" ").filter((x) => x.length > 1);
    const gt = new Set(g.split(" ").filter((x) => x.length > 1));
    let shared = 0;
    for (const x of wt) if (gt.has(x)) shared++;
    s = wt.length ? Math.round((shared / wt.length) * 64) : 0;
  }
  const ws = seasonNum(want);
  const gs = relatedSeasonNum(got, ws);
  if (ws > 0 && gs > 0) s += ws === gs ? 10 : -25;
  else if (ws > 0 && gs === 0) s -= 14;
  return s;
}

// Season number for a source result title. Besides the explicit markers
// seasonNum() reads, source sites often number seasons with a bare trailing
// digit ("Shiguang Dailiren 3") — but only trust that when we're LOOKING for a
// later season, or "Jujutsu Kaisen 0" would read as season 0.
export function relatedSeasonNum(title: string, expectedSeason = 0): number {
  const explicit = seasonNum(title);
  if (explicit > 0) return explicit;
  if (expectedSeason <= 0) return 0;
  const trailing = normLatin(title).match(/\b([2-9][0-9]?)$/);
  return trailing ? parseInt(trailing[1], 10) : 0;
}

// Synthetic search variants for a later-season title: sources sometimes index
// "Show 3" and sometimes "Show Season 3"; query both.
export function relatedNumberedSeasonVariants(title: string): string[] {
  const season = seasonNum(title);
  if (season <= 0) return [];
  const base = stripSeasonNoise(normLatin(title));
  // Base already carries the marker (mid-title roman) → appending it again
  // would only synthesize junk like "… iii isekai … Season 3".
  if (!base || seasonNum(base) > 0) return [];
  return [`${base} ${season}`, `${base} Season ${season}`];
}

/* ── AniList entry → source search queries ── */

export interface AniListLookupEntry {
  title: string;
  titleEnglish?: string | null;
  /** Extra known names (MAL alt-titles), fetched lazily from Jikan. */
  lookupTitles?: string[];
}

/** Every name an AniList entry is known by: romaji, English, optional MAL
 *  alt-titles, plus each title's numbered-season variants (deduped,
 *  case-insensitively). Used for scoring against source search results. */
export function aniListLookupTitles(entry: AniListLookupEntry): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (title: string | null | undefined) => {
    const v = (title || "").trim();
    const k = v.toLowerCase();
    if (v && !seen.has(k)) { seen.add(k); out.push(v); }
  };
  add(entry.title);
  add(entry.titleEnglish);
  for (const title of entry.lookupTitles || []) add(title);
  for (const title of out.slice()) {
    for (const variant of relatedNumberedSeasonVariants(title)) add(variant);
  }
  return out;
}

/**
 * Split lookup titles into search waves, in tap-priority order:
 *   • primary   — names AniList already gave us (no Jikan wait; covers the
 *     vast majority of cards).
 *   • alternate — MAL alt-titles, paid ONLY when the primary wave missed
 *     (Jikan is rate-limited and used to sit on the critical path).
 * Both waves are capped so one tap can't flood the sources with a dozen
 * overlapping searches.
 */
export function aniListLookupWaves(
  entry: AniListLookupEntry,
  altTitles: readonly string[],
  caps: { primary?: number; alternate?: number } = {},
): { primary: string[]; alternate: string[] } {
  const primary = aniListLookupTitles(entry).slice(0, caps.primary ?? 5);
  const primaryKeys = new Set(primary.map((q) => q.toLowerCase()));
  const alternate = aniListLookupTitles({ ...entry, lookupTitles: [...altTitles] })
    .filter((q) => !primaryKeys.has(q.toLowerCase()))
    .slice(0, caps.alternate ?? 3);
  return { primary, alternate };
}

/** Names a source result is known by: the displayed title AND its URL slug.
 *  anime3rb lists Arabic titles under Latin slugs, and a slug is often cleaner
 *  than a decorated scrape title — so matching tries both. Deduped. */
export function sourceCandidateNames(result: { title: string; href: string }): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const add = (name: string | null | undefined) => {
    const v = (name || "").trim();
    const k = v.toLowerCase();
    if (v && !seen.has(k)) { seen.add(k); names.push(v); }
  };
  add(result.title);
  add(slugToTitle(result.href));
  return names;
}

/** Best match of a source result against every name an AniList entry is known
 *  by — across the result's own title AND slug. Returns the score plus the
 *  candidate-side name that produced it (kept for cross-verification). */
export function scoreEntryAgainstNames(
  entry: AniListLookupEntry,
  candidateNames: readonly string[],
): { score: number; matchName: string } {
  const titles = aniListLookupTitles(entry);
  let best = 0;
  let matchName = "";
  for (const name of candidateNames) {
    for (const title of titles) {
      const s = scoreRelatedMatch(title, name);
      if (s > best) { best = s; matchName = name; }
    }
  }
  return { score: best, matchName };
}

/* ── Relation shaping ── */

interface Accum {
  results: RelatedAnimeEntry[];
  seenIds: Set<number>;
  seenCanon: Set<string>;
  selfCanons: Set<string>;
}

function makeAccum(viewedTitle: string, root?: AniListMedia | null): Accum {
  const selfCanons = new Set<string>([canonTitle(viewedTitle)]);
  if (root?.title?.romaji) selfCanons.add(canonTitle(root.title.romaji));
  if (root?.title?.english) selfCanons.add(canonTitle(root.title.english));
  return { results: [], seenIds: new Set(), seenCanon: new Set(), selfCanons };
}

// Process one media's relation edges: add each new, known ANIME relation as a
// card (skipping self + duplicates), and return the SEQUEL/PREQUEL neighbours to
// keep walking. `dir` constrains the chain so we don't bounce back through the
// root: 'root' follows both directions, 'seq'/'pre' follow only forward/back.
function ingestEdges(acc: Accum, media: AniListMedia, dir: "root" | "seq" | "pre"): { id: number; dir: "seq" | "pre" }[] {
  const chain: { id: number; dir: "seq" | "pre" }[] = [];
  const edges = media.relations?.edges;
  if (!Array.isArray(edges)) return chain;
  for (const e of edges) {
    const n = e?.node;
    if (!n || n.type !== "ANIME" || n.id == null) continue;
    const relType = e?.relationType || "";
    const relation = RELATION_AR[relType];
    const display = n.title?.romaji || n.title?.english || null;
    if (relation && display) {
      const canon = canonTitle(display);
      if (!acc.seenIds.has(n.id) && !acc.selfCanons.has(canon) && !acc.seenCanon.has(canon)) {
        acc.seenIds.add(n.id);
        acc.seenCanon.add(canon);
        acc.results.push({
          anilistId: n.id,
          title: display,
          titleEnglish: n.title?.english || null,
          image: n.coverImage?.large || null,
          relation,
          format: n.format ? FORMAT_AR[n.format] || n.format : null,
        });
      }
    }
    if (relType === "SEQUEL" && (dir === "root" || dir === "seq")) chain.push({ id: n.id, dir: "seq" });
    else if (relType === "PREQUEL" && (dir === "root" || dir === "pre")) chain.push({ id: n.id, dir: "pre" });
  }
  return chain;
}

function sortAccum(acc: Accum): RelatedAnimeEntry[] {
  // Stable sort by relation priority (sequels/prequels first); within a group
  // discovery order (roughly chronological) is preserved.
  acc.results.sort((a, b) => RELATION_LABEL_ORDER.indexOf(a.relation) - RELATION_LABEL_ORDER.indexOf(b.relation));
  return acc.results.slice(0, MAX_RELATED);
}

// One-hop relations from a resolved media (no graph walk). Excludes the anime
// being viewed and de-dupes by id + canonical title.
export function buildRelations(media: AniListMedia | null, viewedTitle: string): RelatedAnimeEntry[] {
  if (!media?.relations?.edges) return [];
  const acc = makeAccum(viewedTitle, media);
  ingestEdges(acc, media, "root");
  return sortAccum(acc);
}

export interface FranchiseOpts { maxFetch?: number; maxNodes?: number }

// Walk the SEQUEL/PREQUEL chain from `root` to gather the WHOLE franchise (not
// just adjacent seasons), plus each visited entry's side stories / movies /
// spin-offs. `fetchById` returns a media (with its relations) for an AniList id;
// `maxFetch` bounds the extra network calls. Side stories and spin-offs are
// collected but NOT traversed, so the walk stays within one franchise.
export async function collectFranchise(
  root: AniListMedia | null,
  viewedTitle: string,
  fetchById: (id: number) => Promise<AniListMedia | null>,
  opts: FranchiseOpts = {},
): Promise<RelatedAnimeEntry[]> {
  if (!root) return [];
  const maxFetch = opts.maxFetch ?? 8;
  const maxNodes = opts.maxNodes ?? MAX_RELATED;

  const acc = makeAccum(viewedTitle, root);
  const visited = new Set<number>([root.id]);
  let queue = ingestEdges(acc, root, "root").filter((c) => !visited.has(c.id));
  queue.forEach((c) => visited.add(c.id));

  let fetches = 0;
  while (queue.length && fetches < maxFetch && acc.results.length < maxNodes) {
    const cur = queue.shift()!;
    fetches++;
    const media = await fetchById(cur.id).catch(() => null);
    if (!media) continue;
    const next = ingestEdges(acc, media, cur.dir).filter((c) => !visited.has(c.id));
    next.forEach((c) => visited.add(c.id));
    queue = queue.concat(next);
  }
  return sortAccum(acc);
}

/* ── GraphQL queries ── */

const MEDIA_FIELDS = `id type format title{romaji english native} synonyms relations{edges{relationType node{id type format title{romaji english} coverImage{large}}}}`;
export const RELATIONS_PAGE_QUERY = `query($search:String){Page(perPage:8){media(search:$search,type:ANIME){${MEDIA_FIELDS}}}}`;
export const RELATIONS_BY_ID_QUERY = `query($id:Int){Media(id:$id,type:ANIME){${MEDIA_FIELDS}}}`;
// Exact cross-reference: look up an AniList media by its MyAnimeList id. The
// desktop app resolves titles via Jikan alt-titles, so this bridges to AniList's
// richer relation graph WITHOUT any fuzzy title matching.
export const RELATIONS_BY_MAL_QUERY = `query($idMal:Int){Media(idMal:$idMal,type:ANIME){${MEDIA_FIELDS}}}`;

// Community "similar anime" recommendations, ranked by AniList's own upvote
// counts. Powers the home "مقترح لك" rail; parsed by parseRecommendations().
export const RECOMMENDATIONS_QUERY = `query($id:Int){Media(id:$id,type:ANIME){id recommendations(sort:RATING_DESC,perPage:12){nodes{rating mediaRecommendation{id type format seasonYear title{romaji english} coverImage{large}}}}}}`;

/* ── Network: resolve + cache relations (mobile lib/animeInfo.ts section) ── */

const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
const REL_CACHE_PREFIX = "@anime_relations_v8:";
const relMem = new Map<string, RelatedAnimeEntry[]>();
const relInflight = new Map<string, Promise<RelatedAnimeEntry[]>>();

// Fetch a single AniList media (with its relations) by id — the step that lets
// collectFranchise() walk the SEQUEL/PREQUEL chain past adjacent seasons.
async function fetchMediaById(id: number): Promise<AniListMedia | null> {
  const json = await anilistPost(RELATIONS_BY_ID_QUERY, { id });
  return (json?.data?.Media as AniListMedia) || null;
}

async function fetchRelationsByQueries(
  variants: string[],
  viewedTitle: string,
): Promise<RelatedAnimeEntry[]> {
  for (const query of variants) {
    const json = await anilistPost(RELATIONS_PAGE_QUERY, { search: query });
    const medias: AniListMedia[] | undefined = json?.data?.Page?.media;
    if (!Array.isArray(medias) || medias.length === 0) continue;
    const best = pickBestMedia(medias, query);
    if (!best) continue;
    const out = await collectFranchise(best, viewedTitle, fetchMediaById);
    if (out.length > 0) return out;
  }
  return [];
}

async function doFetchRelations(title: string, href?: string | null): Promise<RelatedAnimeEntry[]> {
  const slugTitle = slugToTitle(href);

  // 1) Direct AniList title search, seeded by the scraped title and the source
  //    slug (a trustworthy romaji anchor for Arabic page titles).
  const direct = await fetchRelationsByQueries(buildSearchQueries([title], slugTitle), title);
  if (direct.length > 0) return direct;

  // 2) Title → AniList-id bridge (week-cached in malInfo). More reliable than
  //    fuzzy title search for decorated titles; the slug still gates confidence
  //    so a generically named anime can't wedge the whole tab onto a different
  //    franchise.
  const anilistId = await fetchAniListIdForTitle(title).catch(() => null);
  if (anilistId != null) {
    const media = await fetchMediaById(anilistId);
    if (media && (!slugTitle || scoreMedia(media, slugTitle) >= 50)) {
      const out = await collectFranchise(media, title, fetchMediaById);
      if (out.length > 0) return out;
    }
  }

  // 3) Jikan alt-titles bridge (Arabic / decorated titles AniList's Latin-only
  //    search can't resolve), then a final AniList search over those names.
  const alt = await getAltTitles(title).catch(() => [] as string[]);
  return fetchRelationsByQueries(buildSearchQueries(alt, slugTitle), title);
}

/** Related anime (sequels, prequels, side stories, spin-offs …) for a title.
 * `href` (the source URL) sharpens title detection via its romaji slug.
 * Resolved via AniList and cached for a week. Empty array on any miss. */
export async function fetchAnimeRelations(title: string, href?: string | null): Promise<RelatedAnimeEntry[]> {
  if (!title || !title.trim()) return [];
  const slug = slugToTitle(href).toLowerCase();
  const key = `${title.toLowerCase().trim()}|${slug}`;
  const cached = relMem.get(key);
  if (cached) return cached;
  const pending = relInflight.get(key);
  if (pending) return pending;

  const p = (async (): Promise<RelatedAnimeEntry[]> => {
    try {
      const raw = await storage.getItem(REL_CACHE_PREFIX + key);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Date.now() - parsed.ts < CACHE_TTL) {
          relMem.set(key, parsed.data);
          return parsed.data as RelatedAnimeEntry[];
        }
      }
    } catch {}
    try {
      const data = await doFetchRelations(title, href);
      if (data.length > 0) {
        relMem.set(key, data);
        try {
          await storage.setItem(REL_CACHE_PREFIX + key, JSON.stringify({ ts: Date.now(), data }));
        } catch {}
      }
      return data;
    } catch {
      return [];
    } finally {
      relInflight.delete(key);
    }
  })();
  relInflight.set(key, p);
  return p;
}
