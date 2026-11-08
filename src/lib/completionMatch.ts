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
  // Every identity key (anchor pages, primary title, the poster shown) already
  // on the shelf. One anime has a record per source/legacy key; matching ANY
  // of these keeps it to one card instead of one per copy.
  const seen = new Set<string>();
  const finished = records.filter((r) => r.finished).sort((a, b) => b.updatedAt - a.updatedAt);
  for (const rec of finished) {
    const anchors = anchorKeys(rec, normalizeHref);
    const primary = primaryTitleKey(rec, normalizeTitle);
    const id = primary || anchors[0] || rec.key;
    const strong = (p: { title: string; href: string }) =>
      anchors.includes(normalizeHref(p.href || "")) || (!!primary && normalizeTitle(p.title || "") === primary);
    const hrefKeys = new Set(rec.hrefs.map(normalizeHref).filter(Boolean));
    const titleKeys = new Set(rec.titles.map(normalizeTitle).filter(Boolean));
    const weak = (p: { title: string; href: string }) => {
      const t = normalizeTitle(p.title || "");
      // A hint may only lend a poster whose title agrees with this record.
      return (hrefKeys.has(normalizeHref(p.href || "")) && (!primary || t === primary)) || (!!t && titleKeys.has(t) && t === primary);
    };
    // Some history rows carry no image; a later source (the record's own
    // poster, My List) that has one must win over an empty first match.
    const poster = posters.find((p) => strong(p) && p.image) ?? posters.find(strong) ??
      posters.find((p) => weak(p) && p.image) ?? posters.find(weak);
    const keys = [id, ...anchors, primary,
      poster ? normalizeHref(poster.href || "") : "", poster ? normalizeTitle(poster.title || "") : ""].filter(Boolean);
    if (keys.some((k) => seen.has(k))) continue;
    for (const k of keys) seen.add(k);
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

/* ── Identity: anchors + primary title ─────────────────────────────────────
 * A record OWNS only its anchor page (its key / hrefs[0]) and its primary
 * title (titles[0]). Its other hrefs/titles are hints and may be polluted:
 * real data (2026-11-08) had «Mushoku Tensei III» and «One Piece: Heroines»
 * carrying One Piece's links, so every One Piece write copied One Piece's
 * state into them (false "completed" badges) and AniList's "Mushoku finished"
 * answer was copied back onto every One Piece copy (3× One Piece in the
 * completed shelf, although it is still airing). */

export function anchorKeys(rec: { key: string; hrefs: string[] }, normalizeHref: (v: string) => string): string[] {
  return [...new Set([normalizeHref(rec.key || ""), normalizeHref(rec.hrefs[0] || "")].filter(Boolean))];
}

export function primaryTitleKey(rec: { titles: string[] }, normalizeTitle: (v: string) => string): string {
  return normalizeTitle(rec.titles[0] || "");
}

/** Whether a record could be the anime named by these title keys. */
export function titleCompatible(
  rec: { titles: string[] },
  titleKeys: ReadonlySet<string>,
  normalizeTitle: (v: string) => string,
): boolean {
  if (titleKeys.size === 0 || !primaryTitleKey(rec, normalizeTitle)) return true;
  return rec.titles.some((t) => titleKeys.has(normalizeTitle(t)));
}

/**
 * Records that ARE this anime: the page's own record (anchor = ownHrefKey),
 * a record anchored on another of the page's hrefs whose titles agree, or a
 * record whose primary title is one of the page's titles. A record that merely
 * lists one of the hrefs as a secondary hint never matches.
 */
export function strictMatchingRecords<T extends CompletionLike & { key: string }>(
  records: readonly T[],
  ownHrefKey: string,
  hrefKeys: ReadonlySet<string>,
  titleKeys: ReadonlySet<string>,
  normalizeHref: (value: string) => string,
  normalizeTitle: (value: string) => string,
): T[] {
  const out: T[] = [];
  for (const rec of records) {
    const anchors = anchorKeys(rec, normalizeHref);
    const primary = primaryTitleKey(rec, normalizeTitle);
    if (
      (ownHrefKey && anchors.includes(ownHrefKey)) ||
      (anchors.some((a) => hrefKeys.has(a)) && titleCompatible(rec, titleKeys, normalizeTitle)) ||
      (!!primary && titleKeys.has(primary))
    ) out.push(rec);
  }
  return out;
}

export interface Decontamination {
  /** Record key → its cleaned hrefs/titles (only records that changed). */
  cleaned: Map<string, { hrefs: string[]; titles: string[]; foreignOwners: string[] }>;
}

/**
 * Find hrefs inside a record that are ANOTHER anime's anchor page — an owner
 * whose primary title differs and that doesn't list this record's primary
 * title either — and the titles that came with them. Pure; the caller decides
 * how to reset state.
 */
export function findContamination<T extends CompletionLike & { key: string }>(
  records: readonly T[],
  normalizeHref: (value: string) => string,
  normalizeTitle: (value: string) => string,
): Decontamination {
  const owners = new Map<string, T[]>();
  for (const rec of records) {
    for (const a of anchorKeys(rec, normalizeHref)) {
      const list = owners.get(a);
      if (list) list.push(rec);
      else owners.set(a, [rec]);
    }
  }
  const cleaned: Decontamination["cleaned"] = new Map();
  for (const rec of records) {
    const primary = primaryTitleKey(rec, normalizeTitle);
    if (!primary) continue;
    const own = new Set(anchorKeys(rec, normalizeHref));
    const foreignOwners = new Map<string, T>();
    const keptHrefs: string[] = [];
    rec.hrefs.forEach((h, i) => {
      const k = normalizeHref(h);
      if (i === 0 || !k || own.has(k)) { keptHrefs.push(h); return; }
      const others = (owners.get(k) || []).filter((o) => o.key !== rec.key);
      const foreign = others.length > 0 && others.every((o) => {
        const p = primaryTitleKey(o, normalizeTitle);
        return !!p && p !== primary && !o.titles.some((t) => normalizeTitle(t) === primary);
      });
      if (foreign) for (const o of others) foreignOwners.set(o.key, o);
      else keptHrefs.push(h);
    });
    if (foreignOwners.size === 0) continue;
    const foreignTitles = new Set([...foreignOwners.values()].map((o) => primaryTitleKey(o, normalizeTitle)));
    const keptTitles = rec.titles.filter((t, i) => i === 0 || !foreignTitles.has(normalizeTitle(t)) || normalizeTitle(t) === primary);
    cleaned.set(rec.key, { hrefs: keptHrefs, titles: keptTitles, foreignOwners: [...foreignOwners.keys()] });
  }
  return { cleaned };
}
