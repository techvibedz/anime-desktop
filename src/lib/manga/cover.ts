// Cover resolution upgrades for the manga sources.
//
// Every rule below was verified live against the real CDNs (HTTP 200 +
// strictly larger pixel dimensions measured with sharp). Anything that could
// not be proven is intentionally left unchanged — a 404 cover is worse than a
// small one.
//
// Evidence (probed 2026-10-04, `img.mangawy.org` hash c6a86896… and 7 more):
//   /covers/<hash>-thumb-sm.webp  160x240   <- home cards
//   /covers/<hash>-cover-md.webp  320x480   <- featured hero
//   /covers/<hash>-cover-lg.webp  640x960   <- largest size token
//   (-cover-sm/-cover-xl/-cover-full/-cover/-md/-lg/-xl all 404)
//   The bare /covers/<hash>.webp is the uploaded original (measured
//   460x644..715x1000). It is kept as-is: for the few uploads bigger than
//   640x960 it is the true maximum, and nothing here should ever downgrade.
//
// Evidence (same probe):
//   3asq.online  Baki-Rahen-175x238.jpg      175x238  -> Baki-Rahen.jpg       1326x2048
//   3asq.online  v1-1-110x150.jpg            110x150  -> v1-1.jpg             1304x2048
//   io.mangalik.net  I-Tried…-110x150.jpg    110x150  -> I-Tried….jpg          450x611
//   io.mangalik.net  …_26388-175x238.webp    175x238  -> …_26388.webp          439x571
//   Both are WordPress (Madara): the original is the same URL with the last
//   `-<w>x<h>` before the extension removed. A filename that merely *contains*
//   a size-looking segment (`…-210x286-1-110x150.jpg`) strips to
//   `…-210x286-1.jpg` (210x286, verified 200) because only the trailing token
//   is a generated size.
//
// Azora (storage.azorafly.com): no size suffixes exist, `?w=` `?width=`
// `?size=` `?quality=100` `?format=webp` all return byte-identical responses
// (960x1392), `-lg`/`/large/` variants 404. The one `public/upload` URL that
// did exist has no matching siblings (404), so no rule is codified —
// azora covers pass through unchanged at their native resolution.

const WP_THUMB_SUFFIX = /-\d+x\d+(?=\.(?:jpe?g|png|webp|gif|avif)$)/i;
const MANGY_COVER = /^(\/covers\/[0-9a-f]+)(?:-(?:thumb-sm|cover-sm|cover-md|cover-lg))\.webp$/i;

/** WordPress/Madara hosts where stripping a trailing `-WxH` is proven safe. */
function isWordPressHost(host: string): boolean {
  return (
    host === "3asq.online" ||
    host.endsWith(".3asq.online") ||
    host === "mangalik.net" ||
    host.endsWith(".mangalik.net") ||
    host === "lekmanga.site" ||
    host.endsWith(".lekmanga.site") ||
    host === "hijala.com"
  );
}

function withPath(parsed: URL, pathname: string): string {
  return `${parsed.protocol}//${parsed.host}${pathname}${parsed.search}${parsed.hash}`;
}

/**
 * Rewrite a chapter-page image URL to the full-size original when the URL
 * carries a WordPress-generated `-WxH` thumbnail token on a host where
 * stripping is proven safe (same rule as covers). Reader pages are usually
 * already full-size, so this is a no-op there; when a source does serve a
 * resized page, the reader falls back to the original URL if the upgrade 404s.
 */
export function upgradeMangaPage(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (!isWordPressHost(parsed.hostname)) return url;
  const stripped = parsed.pathname.replace(WP_THUMB_SUFFIX, "");
  return stripped === parsed.pathname ? url : withPath(parsed, stripped);
}

/**
 * Rewrite a manga cover URL to the highest-quality variant proven to exist.
 * Returns null for null/undefined; returns the URL unchanged for unknown
 * hosts, already-optimal URLs, and malformed input (never throws).
 */
export function upgradeMangaCover(url: string | null | undefined): string | null {
  if (!url) return url ?? null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return url;

  if (parsed.hostname === "img.mangawy.org" || parsed.hostname === "mangawy.org") {
    const match = MANGY_COVER.exec(parsed.pathname);
    return match ? withPath(parsed, `${match[1]}-cover-lg.webp`) : url;
  }

  if (isWordPressHost(parsed.hostname)) {
    const stripped = parsed.pathname.replace(WP_THUMB_SUFFIX, "");
    return stripped === parsed.pathname ? url : withPath(parsed, stripped);
  }

  // Azora and every other host: no proven larger variant.
  return url;
}

// Covers are upgraded to the full originals (up to 6.5 MB, 1326x2048), so they
// are re-served at display size through Jetpack Photon where the host allows it
// (verified for 3asq / mangalik / lekmanga — mobile lib/img parity). Photon
// fetches from the origin itself, so it also sidesteps hotlink checks.
const PHOTON_OK = /(^|\.)(3asq\.online|mangalik\.net|lekmanga\.site|hijala\.com)$/i;
const BUCKETS = [180, 240, 320, 420, 560, 800];

export function mangaPosterUrl(src: string | null | undefined, cssWidth: number): string | undefined {
  if (!src) return undefined;
  let u: URL;
  try { u = new URL(src); } catch { return src; }
  if (!PHOTON_OK.test(u.hostname)) return src;
  const px = Math.ceil(cssWidth * Math.min(window.devicePixelRatio || 1, 2));
  const w = BUCKETS.find((b) => b >= px) ?? 800;
  return `https://i0.wp.com/${u.hostname}${u.pathname}?w=${w}&quality=75&strip=all&ssl=1`;
}
