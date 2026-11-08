// Pure filler/canon logic (no React Native imports — unit-tested under tsx).
//
// Data comes from animefillerlist.com (the reference list fans use; numbering
// is absolute across a show, matching how the Arabic sources number long
// shows) with MyAnimeList's per-episode filler/recap flags (via Jikan) as a
// fallback for shows the list doesn't cover.

export type EpKind = "canon" | "mixed" | "filler" | "anime_canon" | "recap";

export interface FillerData {
  /** animefillerlist slug or "mal:<id>". */
  show: string;
  source: "afl" | "jikan";
  /** Episode number → kind. Episodes missing from the map are canon. */
  kinds: Record<number, EpKind>;
}

/** Skippable = adds nothing to the story. Mixed episodes are kept (they carry canon). */
export function isSkippable(kind: EpKind | undefined): boolean {
  return kind === "filler" || kind === "recap";
}

/** "1-6, 8, 10-13" → [1,2,3,4,5,6,8,10,11,12,13]. Ignores junk; caps runaway ranges. */
export function parseRanges(text: string): number[] {
  const out: number[] = [];
  for (const part of text.split(/[,،]/)) {
    const m = part.trim().match(/^(\d{1,4})(?:\s*[-–]\s*(\d{1,4}))?$/);
    if (!m) continue;
    const a = parseInt(m[1], 10);
    const b = m[2] ? parseInt(m[2], 10) : a;
    if (!(a > 0) || b < a || b - a > 3000) continue;
    for (let n = a; n <= b; n++) out.push(n);
  }
  return out;
}

const AFL_CLASS: Record<string, EpKind> = {
  manga_canon: "canon",
  "mixed_canon/filler": "mixed",
  filler: "filler",
  anime_canon: "anime_canon",
};

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"');
}

/** Parse an animefillerlist show page's category summary into episode kinds. */
export function parseAflShowPage(html: string): Record<number, EpKind> {
  const kinds: Record<number, EpKind> = {};
  const re = /<div class="([a-z_/]+)">\s*<span class="Label">[^<]*<\/span>\s*<span class="Episodes">([\s\S]*?)<\/span>\s*<\/div>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const kind = AFL_CLASS[m[1]];
    if (!kind) continue;
    for (const n of parseRanges(stripTags(m[2]))) {
      // Filler wins over a canon listing if a page lists an episode twice.
      if (kind === "canon" && kinds[n]) continue;
      kinds[n] = kind;
    }
  }
  return kinds;
}

export interface AflShow {
  slug: string;
  /** Normalized primary names: the full label and the part before "(". */
  names: string[];
  /** Normalized alternate name inside "(…)" — matched only as a last resort. */
  alts: string[];
}

/** Fold a title for exact-match comparison across spellings. */
export function normShowName(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[’'`]/g, "")
    // Romanization variants: Shippuuden/Shippuden, Boku no/Bokuno, ou/o.
    .replace(/uu/g, "u")
    .replace(/ou/g, "o")
    .replace(/oo/g, "o")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/^the /, "")
    .replace(/\b(tv|the animation|anime)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseAflShowList(html: string): AflShow[] {
  const out: AflShow[] = [];
  const seen = new Set<string>();
  const re = /<a href="\/shows\/([^"#?]+)">([^<]+)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const slug = m[1];
    if (seen.has(slug)) continue;
    seen.add(slug);
    const label = stripTags(m[2]).trim();
    const names = new Set<string>();
    const alts = new Set<string>();
    names.add(normShowName(label));
    const paren = label.match(/^(.*?)\s*\((.+)\)\s*$/);
    if (paren) {
      names.add(normShowName(paren[1]));
      alts.add(normShowName(paren[2]));
    }
    names.delete("");
    alts.delete("");
    out.push({ slug, names: [...names], alts: [...alts].filter((a) => !names.has(a)) });
  }
  return out;
}

/**
 * Exact (normalized) title match only. Fuzzy matching here is dangerous:
 * "Naruto" must never pick up "Naruto Shippuden"'s filler list.
 */
export function matchAflShow(list: AflShow[], titles: (string | null | undefined)[]): string | null {
  const wanted = new Set(titles.filter((t): t is string => !!t).map(normShowName).filter((t) => t.length >= 2));
  if (!wanted.size) return null;
  // Primary names first: "One Pace (One Piece)" must never beat "One Piece".
  const primary = list.filter((show) => show.names.some((n) => wanted.has(n)));
  if (primary.length) {
    // Several labels can fold together ("One Piece" / "The One Piece"): the
    // one whose slug spells the title exactly is the canonical show.
    return (primary.find((show) => wanted.has(normShowName(show.slug.replace(/-/g, " ")))) ?? primary[0]).slug;
  }
  for (const show of list) {
    if (show.alts.some((n) => wanted.has(n))) return show.slug;
  }
  return null;
}

/** Jikan /anime/{id}/episodes pages → kinds (only filler/recap flags matter). */
export function kindsFromJikan(pages: unknown[]): Record<number, EpKind> {
  const kinds: Record<number, EpKind> = {};
  for (const page of pages) {
    const data = (page as { data?: unknown })?.data;
    if (!Array.isArray(data)) continue;
    for (const ep of data as Record<string, unknown>[]) {
      const n = typeof ep.mal_id === "number" ? ep.mal_id : NaN;
      if (!(n > 0)) continue;
      if (ep.filler === true) kinds[n] = "filler";
      else if (ep.recap === true) kinds[n] = "recap";
    }
  }
  return kinds;
}

export interface FillerSummary {
  fillerCount: number;
  mixedCount: number;
  /** Skippable episode numbers among the available ones, ascending. */
  skippable: number[];
}

/** Summary restricted to the episodes the user can actually see/play. */
export function summarizeFiller(kinds: Record<number, EpKind>, available: number[]): FillerSummary {
  let fillerCount = 0;
  let mixedCount = 0;
  const skippable: number[] = [];
  for (const n of [...new Set(available)].sort((a, b) => a - b)) {
    const k = kinds[n];
    if (isSkippable(k)) {
      fillerCount++;
      skippable.push(n);
    } else if (k === "mixed") mixedCount++;
  }
  return { fillerCount, mixedCount, skippable };
}

/** Next episode after `from` that is not skippable, among `available` (or any number when omitted). */
export function nextCanonEpisode(
  kinds: Record<number, EpKind>,
  from: number,
  available?: number[],
): number | null {
  if (available) {
    const sorted = [...new Set(available)].filter((n) => n > from).sort((a, b) => a - b);
    return sorted.find((n) => !isSkippable(kinds[n])) ?? null;
  }
  for (let n = from + 1; n < from + 3000; n++) {
    if (!isSkippable(kinds[n])) return n;
  }
  return null;
}

/** Hours saved by skipping `count` episodes of ~`minutesPerEp` minutes. */
export function hoursSaved(count: number, minutesPerEp = 23): number {
  return Math.round((count * minutesPerEp) / 6) / 10;
}
