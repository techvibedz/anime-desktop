import { fuzzyScore, normFuzzy, sourceSearchQueries } from "./fuzzy";

type Card = { title: string; href: string };

// Latin/Arabic letter runs, used to split a mixed-script title apart. Source
// titles are frequently "vernacular + original" ("ون بيس One Piece",
// "قاتل الشياطين Kimetsu no Yaiba") while the site indexes only ONE of the two
// spellings. Scoring the whole mixed string against the indexed title caps the
// similarity far below the accept threshold ("ون بيس One Piece" vs "One Piece"
// scores 0.615), so those episodes never discovered the Witanime copy. Scoring
// each language half on its own lets the half the site uses match at 1.0.
const ARABIC_RUN = /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff]+/g;
const LATIN_RUN = /[A-Za-z]+/g;

/** Every spelling worth scoring for a title: the title itself, its parenthesised
 * alternative names, and the Arabic-only / Latin-only halves of mixed titles. */
export function witTitleVariants(names: readonly string[]): string[] {
  const out: string[] = [];
  const add = (value: string) => {
    const trimmed = String(value || "").replace(/\s+/g, " ").trim();
    if (trimmed && !out.some((item) => item.toLowerCase() === trimmed.toLowerCase())) out.push(trimmed);
  };
  for (const name of names) {
    if (!name) continue;
    add(name);
    for (const match of String(name).matchAll(/[([]([^)\]]+)[)\]]/g)) add(match[1]);
    const arabic = (name.match(ARABIC_RUN) || []).join(" ").trim();
    const latin = (name.match(LATIN_RUN) || []).join(" ").trim();
    if (arabic && latin) {
      add(arabic);
      add(latin);
    }
  }
  return out;
}

/** Season numbers any of the known spellings asks for. Scoring a card requires
 * its season to be one of these, so a season-2 page can never answer a season-1
 * lookup (episode numbering restarts) while an alias spelling the season
 * differently still resolves. */
function witWantedSeasons(names: readonly string[], season: (title: string) => number): Set<number> {
  const wanted = new Set<number>();
  for (const name of names) if (name) wanted.add(season(name));
  if (wanted.size === 0) wanted.add(1);
  return wanted;
}

// Score complete names, never the shortened query sent to the site's search.
export function matchWitanimeTitle(
  names: string[], cards: Card[], season: (title: string) => number,
): string | null {
  const clean = (name: string) => normFuzzy(name
    .replace(/\b\d+(?:st|nd|rd|th)\s+(?:season|part|cour)\b/gi, " ")
    .replace(/\b(?:season|part|cour)\s*\d+\b/gi, " ")
    .replace(/\b(?:VIII|VII|VI|IV|IX|III|II)\b/gi, " ")
    .replace(/(?:الموسم|الجزء)\s*[٠-٩\d]+/g, " ")
    .replace(/\b(?:مترجم|مدبلج|انمي|أنمي)\b/g, " "));
  const variants = witTitleVariants(names.map((name) => clean(name)));
  if (variants.length === 0) return null;
  const wantedSeasons = witWantedSeasons(names, season);
  const ranked = [...new Map(cards.map((card) => [card.href, card])).values()]
    .filter((card) => wantedSeasons.has(season(card.title)))
    .map((card) => ({ ...card, score: Math.max(...variants.map((name) => {
      const b = clean(card.title);
      // Symmetric scoring prevents "Naruto" from matching "Boruto Naruto Next
      // Generations"; the variant list is what lets a mixed-script title match.
      return Math.min(fuzzyScore(name, b), fuzzyScore(b, name));
    })) }))
    .sort((a, b) => b.score - a.score);
  if (!ranked[0] || ranked[0].score < 0.8) return null;
  if (ranked[1] && ranked[0].score - ranked[1].score < 0.06) return null;
  return ranked[0].href;
}

export function witEpisodeLink(html: string, animeUrl: string, number: number): string | null {
  const base = new URL(animeUrl);
  const slug = base.pathname.split("/").filter(Boolean).pop();
  for (const match of html.matchAll(/href=["']([^"']+)["']/gi)) {
    try {
      const url = new URL(match[1].replace(/&amp;/g, "&"), base);
      if (url.origin !== base.origin) continue;
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] !== "watch") continue;
      if (parts[1] === slug && Number(parts[2]) === number) return url.toString();
      if (number === 1 && base.pathname.startsWith("/movie/") && parts[1] === "movie" && parts[2] === slug) return url.toString();
    } catch {}
  }
  return null;
}

export async function resolveWitanimeEpisode(
  title: string, number: number, animeHref: string | null | undefined,
  search: (query: string) => Promise<Card[] | null>,
  aliases: (title: string) => Promise<string[]>,
  season: (title: string) => number,
  read: (url: string) => Promise<string | null>,
  // Fired only when the anime page came from a search (not from a known/cached
  // URL), so callers can remember the result and skip /search next time.
  onResolved?: (animeHref: string) => void,
): Promise<string | null> {
  if (!Number.isFinite(number) || number < 1) return null;
  const given = animeHref && /^https?:\/\/(?:[^/]+\.)?witanime\.[^/]+\/(?:anime|movie)\//i.test(animeHref)
    ? animeHref : null;
  let href = given;
  if (!href && title) {
    const names = [title, ...[...title.matchAll(/[([]([^)\]]+)[)\]]/g)].map((m) => m[1])];
    const tried = new Set<string>();
    const cards: Card[] = [];
    // The site rate-limits /search hard: a parallel burst of four queries comes
    // back HTTP 429 and the whole lookup used to die there (no Witanime servers
    // for that episode). Query one at a time and stop as soon as a confident
    // match lands — usually the very first query, so this is also fewer GETs.
    const find = async (queries: string[]) => {
      for (const query of [...new Set(queries)]) {
        if (!query || tried.has(query)) continue;
        tried.add(query);
        const results = await search(query).catch(() => null);
        if (results?.length) cards.push(...results);
        const match = matchWitanimeTitle(names, cards, season);
        if (match) return match;
      }
      return null;
    };
    href = await find(sourceSearchQueries(title, 4));
    if (!href) {
      const alt = await aliases(title).catch(() => []);
      names.push(...alt.filter((name) => !names.includes(name)).slice(0, 4));
      href = await find(names.slice(1).flatMap((name) => sourceSearchQueries(name, 2)));
    }
  }
  if (!href) return null;
  if (!given) onResolved?.(href);
  const html = await read(href).catch(() => null);
  return html ? witEpisodeLink(html, href, number) : null;
}
