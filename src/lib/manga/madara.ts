// Shared WP-Manga (Madara) query builder — 3asq.online and mangalik.net expose
// the same search route: `/?s=<q>&post_type=wp-manga` with optional `genre[]`,
// `status[]` and `m_orderby` params, paginated via `/page/N/`. Verified live on
// 3asq (2026-10): an empty `s` returns the full catalog, and status/genre/order
// params all filter server-side. That is what powers "search by filter only".

import type { MangaFilterOptions } from "./types";

const STATUS_SLUGS: Record<string, string> = {
  مستمر: "on-going",
  مكتمل: "end",
  معلق: "on-hold",
};

const SORT_SLUGS: Record<string, string> = {
  latest: "latest",
  title: "alphabet",
};

/** Path (including query string) of a Madara search/listing page. `typeGenre`
 * is the source's own genre-taxonomy slug for the type filter (mangalik exposes
 * مانجا/مانهوا/مانها as genre values; 3asq has no such taxonomy, so it simply
 * omits it). When both a genre and a type are present the site's `op=1` (AND)
 * keeps them conjunctive instead of widening to OR. */
export function madaraSearchPath(
  query: string,
  genreSlugs: string[],
  options: MangaFilterOptions | undefined,
  page: number,
  typeGenre?: string,
): string {
  const params = [`s=${encodeURIComponent(query)}`, "post_type=wp-manga"];
  for (const slug of genreSlugs) params.push(`genre%5B%5D=${encodeURIComponent(slug)}`);
  if (typeGenre) {
    params.push(`genre%5B%5D=${encodeURIComponent(typeGenre)}`);
    params.push("op=1");
  }
  const status = options?.status ? STATUS_SLUGS[options.status] : undefined;
  if (status) params.push(`status%5B%5D=${status}`);
  const order = options?.sort ? SORT_SLUGS[options.sort] : undefined;
  if (order) params.push(`m_orderby=${order}`);
  const qs = params.join("&");
  return page > 1 ? `/page/${page}/?${qs}` : `/?${qs}`;
}
