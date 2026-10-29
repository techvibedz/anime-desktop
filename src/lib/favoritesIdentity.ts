/** Pure favorite-URL helpers kept separate from AsyncStorage/Supabase so the
 * identity rules can be regression-tested in Node. Source domains rotate, but
 * a favorite must keep matching the same anime path. */

/** Episode pages across our sources: /episode/<slug>[/<n>] (anime3rb,
 * anime4up), /watch/<slug>/<n>, and /watch/movie/<slug> (witanime). The
 * player's internal /watch/stream-* routes are not episodes. */
export function isEpisodeUrl(href: string): boolean {
  if (!href) return false;
  let path = href;
  try { path = new URL(href).pathname; } catch {}
  return /\/episode\//i.test(path) ||
    /\/watch\/(?!stream-)[^/]+\/\d+(?:\/|$)/i.test(path) ||
    /\/watch\/movie\/[^/]/i.test(path);
}

function encodeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return url.origin + url.pathname.split("/").map((segment, index) =>
      index === 0 ? segment : encodeURIComponent(decodeURIComponent(segment)),
    ).join("/");
  } catch {
    return raw;
  }
}

export function toAnimeUrl(href: string): string | null {
  if (!href) return null;
  if (isAnimeDetailUrl(href)) return href;
  let decoded = href;
  try { decoded = decodeURIComponent(href); } catch {}

  // Witanime movie watch pages (/watch/movie/<slug>[/<n>]) play /movie/<slug>.
  const watchMovie = decoded.match(/^(https?:\/\/[^/]+)\/watch\/movie\/([^/?#]+)(?:\/\d+)?(?=[/?#]|$)/i);
  if (watchMovie) return encodeUrl(`${watchMovie[1]}/movie/${watchMovie[2]}`);

  // Witanime episodes are /watch/<slug>/<n>; the anime page is /anime/<slug>.
  const watch = decoded.match(/^(https?:\/\/[^/]+)\/watch\/(?!stream-)([^/?#]+)\/\d+(?=[/?#]|$)/i);
  if (watch) return encodeUrl(`${watch[1]}/anime/${watch[2]}`);

  if (!decoded.includes("/episode/")) return href;
  let converted = decoded.replace(/-?الحلقة[-\s]*\d+[^/]*/, "").replace("/episode/", "/anime/");
  // anime4up slugs its episodes with the anime name ("/episode/انمي-<slug>-…")
  // while its anime pages are "/anime/<slug>" — no prefix.
  try {
    if (/anime4up/i.test(new URL(converted).hostname)) {
      converted = converted.replace(/\/anime\/(?:انمي|anime)-/i, "/anime/");
    }
  } catch {}
  if (converted !== decoded && converted.includes("/anime/")) return encodeUrl(converted);
  return null;
}

/** Detail pages we can favorite/open: /anime/<slug> (witanime, anime4up),
 * /movie/<slug> (witanime movies), anime3rb /titles/<slug>. Watch pages are
 * episodes, never detail pages. */
export function isAnimeDetailUrl(href: string): boolean {
  if (!href) return false;
  try {
    const url = new URL(href);
    const path = url.pathname;
    if (/\/episode\//i.test(path) || /\/watch\//i.test(path)) return false;
    return /\/anime\//i.test(path) || /\/movie\//i.test(path) ||
      (/anime3rb\.com$/i.test(url.hostname) && /\/titles\//i.test(path));
  } catch {
    if (/\/episode\//i.test(href) || /\/watch\//i.test(href)) return false;
    return /\/anime\//i.test(href) || /\/movie\//i.test(href) || /\/titles\//i.test(href);
  }
}

/** Stable favorite identity across encoding, trailing slashes, query strings,
 * www aliases, and rotating source TLD/subdomains. */
export function favoriteKey(href: string | null | undefined): string {
  if (!href) return "";
  const animeHref = isAnimeDetailUrl(href) ? href : toAnimeUrl(href);
  if (!animeHref) return "";
  try {
    const url = new URL(animeHref);
    const labels = url.hostname.toLowerCase().replace(/^www\./, "").split(".");
    const source = labels.length >= 2 ? labels[labels.length - 2] : labels[0];
    let path = url.pathname;
    try { path = decodeURIComponent(path); } catch {}
    return `${source}${path}`.replace(/\/+$/, "").toLowerCase();
  } catch {
    try { return decodeURIComponent(animeHref).split(/[?#]/)[0].replace(/\/+$/, "").toLowerCase(); }
    catch { return animeHref.split(/[?#]/)[0].replace(/\/+$/, "").toLowerCase(); }
  }
}
