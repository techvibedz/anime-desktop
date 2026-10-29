// Dependency-free record matching for the completion store. Kept out of
// completion.tsx (which imports React/AsyncStorage/supabase) so it can be unit
// tested, same as historyMerge.ts.

export interface CompletionLike {
  hrefs: string[];
  titles: string[];
}

/**
 * Every record matching ANY of the given normalized href/title keys.
 *
 * Completion records are keyed per source URL, so one anime can legitimately
 * end up with several records (witanime vs anime4up vs a title fallback). All
 * writers must update EVERY match, not just the first: a card resolving to a
 * stale copy otherwise shows no badge even though the finale was watched.
 *
 * Keys must already be normalized by the caller (normAnimeKey / animeTitleKey).
 */
export function matchingRecords<T extends CompletionLike>(
  records: readonly T[],
  hrefKeys: ReadonlySet<string>,
  titleKeys: ReadonlySet<string>,
  normalizeHref: (value: string) => string = (value) => value,
  normalizeTitle: (value: string) => string = (value) => value,
): T[] {
  const out: T[] = [];
  for (const rec of records) {
    const hrefHit = hrefKeys.size > 0 && rec.hrefs.some((h) => hrefKeys.has(normalizeHref(h)));
    const titleHit = titleKeys.size > 0 && rec.titles.some((t) => titleKeys.has(normalizeTitle(t)));
    if (hrefHit || titleHit) out.push(rec);
  }
  return out;
}

/**
 * Whether two normalized anime keys ("witanime/anime/x") come from the same
 * source. Episode numbers are only comparable within ONE source: anime4up runs
 * ahead of / numbers differently from the list the detail page shows, so a feed
 * item from another source must not raise a record's lastEpNum — that inflated
 * number made the finale-watched badge impossible to ever show. Unknown → true.
 */
export function sameSource(a: string, b: string): boolean {
  const sa = a.split("/")[0];
  const sb = b.split("/")[0];
  return !sa || !sb || sa === sb;
}

/**
 * A record whose hrefs/titles span several DIFFERENT anime — the residue of the
 * old "union every match into every match" write, which snowballed one bad
 * link into a blob (One Piece + Mushoku Tensei sharing one badge state). A real
 * record has one page per source (witanime / anime4up / anime3rb, TLDs fold
 * away) and a couple of title spellings; measured max on real data: 3 / 2.
 */
export function isBlobRecord(
  rec: CompletionLike,
  normalizeHref: (value: string) => string,
  normalizeTitle: (value: string) => string,
): boolean {
  const slugs = new Set(rec.hrefs.map((h) => normalizeHref(h).split("/").pop() || "").filter(Boolean));
  const titles = new Set(rec.titles.map(normalizeTitle).filter(Boolean));
  return slugs.size >= 5 || titles.size >= 4;
}

export interface CompletedEntry {
  key: string;
  title: string;
  href: string;
  image: string | null;
  updatedAt: number;
}

/**
 * My List "completed" shelf: one entry per anime whose finale was watched,
 * newest first. Completion records carry no artwork, so each one borrows the
 * title/href/poster of the first poster source (watch history, then My List)
 * matching any of its href/title keys. Dedupe uses the same identity as the
 * profile's completed count (title key, then href key) so the two always agree.
 */
export function buildCompletedList(
  records: readonly (CompletionLike & { key: string; finished: boolean; updatedAt: number })[],
  posters: readonly { title: string; href: string; image?: string | null }[],
  normalizeHref: (value: string) => string,
  normalizeTitle: (value: string) => string,
): CompletedEntry[] {
  const out: CompletedEntry[] = [];
  const seen = new Set<string>();
  const finished = records.filter((r) => r.finished).sort((a, b) => b.updatedAt - a.updatedAt);
  for (const rec of finished) {
    const id = normalizeTitle(rec.titles[0] || "") || normalizeHref(rec.hrefs[0] || "") || rec.key;
    if (seen.has(id)) continue;
    seen.add(id);
    const hrefKeys = new Set(rec.hrefs.map(normalizeHref).filter(Boolean));
    const titleKeys = new Set(rec.titles.map(normalizeTitle).filter(Boolean));
    const matches = (p: { title: string; href: string }) => {
      const t = normalizeTitle(p.title || "");
      return hrefKeys.has(normalizeHref(p.href || "")) || (!!t && titleKeys.has(t));
    };
    // Some history rows carry no image; a later source (the record's own
    // poster, My List) that has one must win over an empty first match.
    const poster = posters.find((p) => matches(p) && p.image) ?? posters.find(matches);
    out.push({
      key: id,
      title: poster?.title || rec.titles[0] || rec.key,
      href: poster?.href || rec.hrefs[0] || rec.key,
      image: poster?.image || null,
      updatedAt: rec.updatedAt,
    });
  }
  return out;
}
