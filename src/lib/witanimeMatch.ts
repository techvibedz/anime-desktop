import { fuzzyScore, normFuzzy, sourceSearchQueries } from "./fuzzy";

type Card = { title: string; href: string };

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
  const wantedSeason = season(names[0]);
  const ranked = [...new Map(cards.map((card) => [card.href, card])).values()]
    .filter((card) => season(card.title) === wantedSeason)
    .map((card) => ({ ...card, score: Math.max(...names.map((name) => {
      const a = clean(name), b = clean(card.title);
      // Symmetric scoring prevents "Naruto" from matching "Boruto Naruto Next Generations".
      return Math.min(fuzzyScore(a, b), fuzzyScore(b, a));
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
): Promise<string | null> {
  if (!Number.isFinite(number) || number < 1) return null;
  let href = animeHref && /^https?:\/\/(?:[^/]+\.)?witanime\.[^/]+\/(?:anime|movie)\//i.test(animeHref)
    ? animeHref : null;
  if (!href && title) {
    const names = [title, ...[...title.matchAll(/[([]([^)\]]+)[)\]]/g)].map((m) => m[1])];
    const tried = new Set<string>();
    const cards: Card[] = [];
    const find = async (queries: string[]) => {
      const fresh = [...new Set(queries)].filter((q) => !tried.has(q));
      fresh.forEach((q) => tried.add(q));
      const results = await Promise.all(fresh.map((q) => search(q).catch(() => null)));
      cards.push(...results.flatMap((result) => result || []));
      return matchWitanimeTitle(names, cards, season);
    };
    href = await find(sourceSearchQueries(title, 4));
    if (!href) {
      const alt = await aliases(title).catch(() => []);
      names.push(...alt.filter((name) => !names.includes(name)).slice(0, 4));
      href = await find(names.slice(1).flatMap((name) => sourceSearchQueries(name, 2)));
    }
  }
  if (!href) return null;
  const html = await read(href).catch(() => null);
  return html ? witEpisodeLink(html, href, number) : null;
}
