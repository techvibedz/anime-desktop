// AniList GraphQL API — free, no auth needed.
// Used to fetch accurate related anime (sequels, prequels, etc.) and
// map them back to witanime pages via search.

const ANILIST_API = "https://graphql.anilist.co";

function gqlRequest<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  return fetch(ANILIST_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables }),
  })
    .then((r) => r.json())
    .then((r) => {
      if (r.errors?.length) throw new Error(r.errors[0].message);
      return r.data as T;
    });
}

export function cleanTitle(title: string): string {
  return title
    // Remove parenthetical tags: (Sub), (Dub), (2024), etc.
    .replace(/[\(\[][^\)\]]*[\)\]]/g, "")
    // Remove Arabic season/part markers
    .replace(/\b(الموسم|الجزء|موسم|جزء)\s*\d+\b/g, "")
    // Remove "Season N", "Part N", "Cour N"
    .replace(/\b(season|part|cour|s)\s*\d+\b/gi, "")
    // Remove sequel numbers: "2nd Season", "3rd Season", etc.
    .replace(/\b(\d+(?:st|nd|rd|th))\s*(season|part|cour)\b/gi, "")
    // Remove standalone numbers at end: "Attack on Titan 3" → "Attack on Titan"
    .replace(/\s+\d+(?:st|nd|rd|th)?\s*$/, "")
    // Remove trailing "TV", "OVA", "Movie" tags
    .replace(/\b(TV|OVA|ONA|Movie|Special)\b/gi, "")
    // Collapse whitespace
    .replace(/\s+/g, " ")
    .trim();
}

interface SearchResult {
  id: number;
  title: { romaji: string; english: string | null; native: string | null };
  coverImage: { medium: string };
}

export async function searchAnilist(
  title: string
): Promise<{ id: number; title: string; image: string } | null> {
  const clean = cleanTitle(title);
  if (clean.length < 2) return null;

  const query = `
    query($search: String) {
      Page(page: 1, perPage: 3) {
        media(search: $search, type: ANIME) {
          id
          title { romaji english native }
          coverImage { medium }
        }
      }
    }
  `;

  try {
    const data = await gqlRequest<{ Page: { media: SearchResult[] } }>(query, { search: clean });
    const candidates = data.Page.media;
    if (!candidates.length) return null;

    // Pick best match: prefer exact title match, then English, then Romaji
    const cleanLower = clean.toLowerCase();
    for (const m of candidates) {
      const titles = [
        m.title.romaji,
        m.title.english,
        m.title.native,
      ].filter(Boolean) as string[];
      for (const t of titles) {
        if (t.toLowerCase() === cleanLower) {
          return { id: m.id, title: cleanTitle(t), image: m.coverImage.medium };
        }
      }
    }

    // Fallback: first result
    const first = candidates[0];
    return {
      id: first.id,
      title: cleanTitle(first.title.english || first.title.romaji),
      image: first.coverImage.medium,
    };
  } catch (e) {
    console.warn("[anilist] search failed:", e);
    return null;
  }
}

interface RelationEdge {
  relationType: string;   // "SEQUEL", "PREQUEL", "SIDE_STORY", "ADAPTATION", etc.
  node: {
    id: number;
    title: { romaji: string; english: string | null };
    coverImage: { medium: string };
    format: string;        // "TV", "MOVIE", "OVA", etc.
  };
}

export interface RelatedEntry {
  title: string;
  relationType: string;   // e.g. "SEQUEL", "PREQUEL", "SIDE_STORY"
  format: string;         // "TV", "MOVIE", "OVA", etc.
  image: string;
  anilistId: number;
}

function relationLabel(type: string): string {
  const labels: Record<string, string> = {
    SEQUEL: "الجزء التالي",
    PREQUEL: "الجزء السابق",
    SIDE_STORY: "قصة جانبية",
    ADAPTATION: "اقتباس",
    ALTERNATIVE: "نسخة بديلة",
    SUMMARY: "ملخص",
    SPIN_OFF: "قصة فرعية",
    PARENT: "العمل الأصلي",
    CHARACTER: "مرتبط بالشخصيات",
    OTHER: "مرتبط",
  };
  return labels[type] || type.replace(/_/g, " ").toLowerCase();
}

export async function getRelations(
  anilistId: number
): Promise<RelatedEntry[]> {
  const query = `
    query($id: Int) {
      Media(id: $id) {
        relations {
          edges {
            relationType
            node {
              id
              title { romaji english }
              coverImage { medium }
              format
            }
          }
        }
      }
    }
  `;

  try {
    const data = await gqlRequest<{
      Media: { relations: { edges: RelationEdge[] } };
    }>(query, { id: anilistId });

    const edges = data.Media.relations.edges;
    // Filter to meaningful types, exclude duplicates, sorted by priority
    const priority: Record<string, number> = {
      SEQUEL: 0, PREQUEL: 1, SIDE_STORY: 2, SPIN_OFF: 3,
      ALTERNATIVE: 4, ADAPTATION: 5, PARENT: 6, SUMMARY: 7,
    };

    const seen = new Set<number>();
    const results: RelatedEntry[] = [];

    for (const { relationType, node } of edges) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);

      results.push({
        title: node.title.english || node.title.romaji,
        relationType: relationLabel(relationType),
        format: node.format,
        image: node.coverImage.medium,
        anilistId: node.id,
      });
    }

    results.sort(
      (a, b) => (priority[a.relationType] ?? 99) - (priority[b.relationType] ?? 99)
    );
    return results;
  } catch (e) {
    console.warn("[anilist] relations failed:", e);
    return [];
  }
}

// Cache witanime search results so we don't hit the scraper for every relation.
const witSearchCache = new Map<string, string | null>();

export async function findOnWitanime(title: string): Promise<string | null> {
  const key = title.toLowerCase().trim();
  const hit = witSearchCache.get(key);
  if (hit !== undefined) return hit;

  // Search witanime via their search endpoint
  const searchUrl = `https://witanime.you/?s=${encodeURIComponent(title)}&search_param=animes`;
  try {
    const resp = await fetch(searchUrl);
    const html = await resp.text();

    // Extract first anime-card-container link
    const match = html.match(
      /<div[^>]*class="[^"]*anime-card-container[^"]*"[^>]*>[\s\S]*?<a[^>]*href="(\/anime\/[^"]+)"/
    );
    if (match) {
      const result = `https://witanime.you${match[1]}`;
      witSearchCache.set(key, result);
      return result;
    }

    witSearchCache.set(key, null);
    return null;
  } catch {
    witSearchCache.set(key, null);
    return null;
  }
}
