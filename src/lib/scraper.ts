// Thin wrapper around window.pantoufa.scrape (preload-exposed IPC).
// Mirrors the mobile app's lib/scraper/index.ts so the higher-level
// lib/api.ts can be ported almost verbatim.

import {
  EXTRACT_HOME_WIT,
  EXTRACT_HOME_4UP,
  EXTRACT_EPISODES_WIT,
  EXTRACT_EPISODES_4UP,
  EXTRACT_SEARCH,
  EXTRACT_RECENT,
  EXTRACT_LISTING,
  EXTRACT_TITLE_MATCH,
  EXTRACT_VIDEO_SERVERS,
  EXTRACT_VIDEO_URL,
  VIDEO_HOOK_INSTALL,
} from "./scripts";

const WIT_BASE = "https://witanime.you";
const UP4_BASE = "https://w1.anime4up.rest";
const ALL_ANIME_PATH = encodeURIComponent("قائمة-الانمي");

function enqueue<T>(job: {
  url: string;
  injectBefore?: string;
  injectAfter: string;
  timeoutMs: number;
  isVideoJob?: boolean;
}): Promise<T> {
  return window.pantoufa.scrape(job) as Promise<T>;
}

export type RawAnime = {
  title: string; href: string; image: string | null;
  type: string | null; status: string | null; description: string | null;
  isNew: boolean; rating: string | null;
};
export type RawFeatured = {
  title: string; href: string; image: string | null;
  description: string | null; genres: string[];
};
export type RawEpisodeCard = {
  title: string; href: string; image: string | null;
  animeTitle: string; animeHref: string; isNew: boolean;
};

export async function scrapeWitanimeHome() {
  return enqueue<{ featured: RawFeatured[]; animes: RawAnime[]; episodes: RawEpisodeCard[] }>({
    url: `${WIT_BASE}/`, injectAfter: EXTRACT_HOME_WIT, timeoutMs: 35000,
  });
}

export async function scrapeAnime4upHome() {
  return enqueue<{ animes: Pick<RawAnime, "title" | "href" | "image" | "type">[] }>({
    url: `${UP4_BASE}/home8/`, injectAfter: EXTRACT_HOME_4UP, timeoutMs: 35000,
  });
}

export type RawDetail = {
  title: string; poster: string; synopsis: string; genres: string[];
  episodes: { title: string; number: number; type: string; screenshot: string; href: string | null }[];
  /** Direct anime4up link discovered on the wit page (when present). */
  up4Url?: string | null;
};

export async function scrapeEpisodesPage(animeUrl: string) {
  const is4up = /anime4up/i.test(animeUrl);
  return enqueue<RawDetail>({
    url: animeUrl,
    injectAfter: is4up ? EXTRACT_EPISODES_4UP : EXTRACT_EPISODES_WIT,
    timeoutMs: 35000,
  });
}

export async function scrapeSearch(query: string) {
  const url = `${WIT_BASE}/?s=${encodeURIComponent(query)}&search_param=animes`;
  return enqueue<{ results: { title: string; href: string; image: string | null; type: string | null; status: string | null; synopsis: string | null }[] }>({
    url, injectAfter: EXTRACT_SEARCH, timeoutMs: 25000,
  });
}

export async function scrapeRecent(page = 1) {
  const url = `${WIT_BASE}/episode/page/${page}/`;
  return enqueue<{ episodes: RawEpisodeCard[] }>({
    url, injectAfter: EXTRACT_RECENT, timeoutMs: 30000,
  });
}

export async function scrapeGenre(arabicSlug: string, page = 1) {
  const url = page === 1
    ? `${WIT_BASE}/anime-genre/${arabicSlug}/`
    : `${WIT_BASE}/anime-genre/${arabicSlug}/page/${page}/`;
  return enqueue<{ items: { title: string; href: string; image: string | null; type: string | null; status: string | null; synopsis: null }[] }>({
    url, injectAfter: EXTRACT_LISTING, timeoutMs: 30000,
  });
}

export async function scrapeAllAnime(page = 1) {
  const url = page === 1
    ? `${WIT_BASE}/${ALL_ANIME_PATH}/`
    : `${WIT_BASE}/${ALL_ANIME_PATH}/page/${page}/`;
  return enqueue<{ items: { title: string; href: string; image: string | null; type: string | null; status: string | null; synopsis: null }[] }>({
    url, injectAfter: EXTRACT_LISTING, timeoutMs: 30000,
  });
}

export async function findCrossSourceUrl(
  title: string,
  primarySource: "witanime" | "anime4up",
): Promise<string | null> {
  if (!title) return null;
  const wantTarget = primarySource === "witanime" ? "anime4up" : "witanime";
  const base = wantTarget === "anime4up" ? UP4_BASE : WIT_BASE;
  const searchUrl = `${base}/?search_param=animes&s=${encodeURIComponent(title)}`;
  try {
    const r = await enqueue<{ url: string | null; score: number }>({
      url: searchUrl, injectAfter: EXTRACT_TITLE_MATCH(title), timeoutMs: 25000,
    });
    return r.url;
  } catch {
    return null;
  }
}

export type RawServer = { id: string; name: string; iframeUrl: string; provider: string };

export async function scrapeVideoServers(episodeUrl: string) {
  return enqueue<{ servers: RawServer[]; episodeTitle: string; animeTitle: string }>({
    url: episodeUrl, injectAfter: EXTRACT_VIDEO_SERVERS, timeoutMs: 25000,
  });
}

export async function extractVideoUrl(embedUrl: string) {
  return enqueue<{ url: string } | null>({
    url: embedUrl,
    // Install the fetch/XHR hooks BEFORE any page script runs — so the
    // URL the player asks for is captured even if the embed page later
    // redirects through an ad gate that would otherwise swap the
    // document and lose the hook.
    injectBefore: VIDEO_HOOK_INSTALL,
    injectAfter: EXTRACT_VIDEO_URL,
    timeoutMs: 35000,
    isVideoJob: true,
  });
}
