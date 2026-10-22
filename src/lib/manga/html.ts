// Tiny HTML helpers shared by the manga source adapters. Sources are plain
// server-rendered HTML (WP-Manga, custom PHP/Next apps), so a regex-level
// toolkit is enough — no DOM parser dependency (OTA can't add native modules,
// and a JS parser would be the only heavy dep in the manga section).

/** Decode the HTML entities the Arabic manga sites actually emit. Numeric
 * entities are decoded before named ones, and `&amp;` last, so a literal
 * "&amp;#8211;" decodes once to "&#8211;" and not through to "–". */
export function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => codePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => codePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;|&lsquo;|&rsquo;/gi, "'")
    .replace(/&ldquo;|&rdquo;/gi, '"')
    .replace(/&ndash;/gi, "–")
    .replace(/&mdash;/gi, "—")
    .replace(/&hellip;/gi, "…")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function codePoint(value: number): string {
  return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : "";
}

/** Strip tags and collapse whitespace — for synopsis/title text. */
export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/** First capture group of the first match, or null. */
export function firstMatch(html: string, pattern: RegExp): string | null {
  const m = pattern.exec(html);
  return m ? (m[1] ?? null) : null;
}

/** Attribute value from a single tag string ("src", "data-src", "href", …). */
export function attr(tag: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag);
  return m ? decodeEntities(m[1]) : null;
}

/** Lazy chapter images: never select a data-URI placeholder over a real URL. */
export function chapterImageUrl(tag: string, base: string): string | null {
  for (const name of ["data-src", "data-lazy-src", "data-original", "src"]) {
    const raw = attr(tag, name)?.trim();
    if (!raw || /^(?:data|blob|javascript):/i.test(raw)) continue;
    const url = absoluteUrl(raw, base);
    if (url && /^https?:/i.test(url)) return url;
  }
  const candidates = (attr(tag, "data-srcset") || attr(tag, "srcset") || "")
    .split(",").map((item) => item.trim().split(/\s+/))
    .sort((a, b) => Number.parseFloat(b[1] || "0") - Number.parseFloat(a[1] || "0"));
  const url = absoluteUrl(candidates[0]?.[0], base);
  return url && /^https?:/i.test(url) ? url : null;
}

/** Make a possibly-relative URL absolute against a page URL. */
export function absoluteUrl(href: string | null | undefined, base: string): string | null {
  if (!href) return null;
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}
