// Per-anime "completion" state — the data behind the anime-card badges and the
// profile's "completed anime" stat. Synced to Supabase so it's tied to the user
// account and shared across devices (mobile ↔ desktop).
//
// An anime is considered:
//   • caught up — the user has watched the LAST episode currently available in
//     the app (the highest episode number across all sources).
//   • finished  — caught up AND the series is no longer airing (its finale is
//     out), i.e. the user has watched the actual final episode.
//
// A record carries EVERY known source href + title for the anime (witanime /
// anime4up / anime3rb), so a poster card from ANY source rail can resolve the
// badge regardless of which source URL it was opened/recorded under.

//
// Ported from the mobile app (lib/completion.tsx) — same Supabase table and
// columns (incl. marked_completed + image), so both surfaces agree on badges,
// the completed shelf and hand-made "completed" marks.

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { storage as AsyncStorage } from "./storage";
import { normAnimeKey, animeTitleKey, getCompletedSets, subscribeHistory, getHistoryByAnime } from "./history";
import { matchingRecords, sameSource, isBlobRecord, buildCompletedList, type CompletedEntry } from "./completionMatch";
import { supabase, isSupabaseConfigured, getSessionUser } from "./supabase";
import { createRequestCache, withTimeout } from "./requestCache";

export type { CompletedEntry };

const KEY = "anime_completion_v2";

export interface AnimeCompletion {
  key: string;
  hrefs: string[];
  titles: string[];
  /** Highest episode number that was available when this was recorded. */
  lastEpNum: number;
  /** Watched the last available episode. */
  caughtUp: boolean;
  /** Caught up AND the series has finished airing (watched the real finale). */
  finished: boolean;
  /** The user marked it completed by hand (detail page). Overrides the
   *  history-derived state: caughtUp + finished stay true until unmarked. */
  marked?: boolean;
  /** Poster, for the completed shelf when history has none (marked anime). */
  image?: string;
  updatedAt: number;
}

function uniq(arr: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of arr) {
    const s = (v || "").trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

// In-memory cache: every record/reconcile/notify used to re-read + re-parse the
// whole map from AsyncStorage (and the provider's refresh re-parsed it again on
// every change event). All writes go through saveCompletionMap.
let completionCache: Record<string, AnimeCompletion> | null = null;

/** Reset a blob record (see isBlobRecord) to its own identity — the page its
 *  key names — with a cleared state the next detail visit / feed reconcile
 *  recomputes from history. Its badge state mixed several anime, so it can't be
 *  trusted. Returns null when the record is fine. */
function repairBlob(rec: AnimeCompletion): AnimeCompletion | null {
  if (!isBlobRecord(rec, normAnimeKey, animeTitleKey)) return null;
  const own = normAnimeKey(rec.key);
  const hrefs = rec.hrefs.filter((h) => normAnimeKey(h) === own);
  const marked = !!rec.marked;
  return { key: rec.key, hrefs: hrefs.length ? hrefs : [rec.key], titles: [], lastEpNum: 0, caughtUp: marked, finished: marked, marked, image: rec.image, updatedAt: Date.now() };
}
let completionLoading: Promise<Record<string, AnimeCompletion>> | null = null;

export async function getCompletionMap(): Promise<Record<string, AnimeCompletion>> {
  if (completionCache) return completionCache;
  if (!completionLoading) completionLoading = (async () => {
    try {
      const raw = await AsyncStorage.getItem(KEY);
      const map: Record<string, AnimeCompletion> = raw ? JSON.parse(raw) : {};
      const repaired: AnimeCompletion[] = [];
      for (const rec of Object.values(map)) {
        const fixed = repairBlob(rec);
        if (fixed) { map[rec.key] = fixed; repaired.push(fixed); }
      }
      completionCache = map;
      if (repaired.length) {
        void saveCompletionMap(map);
        for (const rec of repaired) pushToCloud(rec).catch(() => {});
      }
    } catch {
      completionCache = {};
    }
    return completionCache!;
  })().finally(() => { completionLoading = null; });
  return completionLoading;
}

let completionWrites: Promise<void> = Promise.resolve();
async function saveCompletionMap(map: Record<string, AnimeCompletion>) {
  completionCache = map;
  const payload = JSON.stringify(map);
  completionWrites = completionWrites.then(async () => {
    // The storage shim already prunes re-fetchable caches on a quota error.
    try { await AsyncStorage.setItem(KEY, payload); }
    catch (error) { console.warn("[completion] local write failed:", error); }
  });
  await completionWrites;
}

// Lightweight change notifier so the provider re-loads after a record()/pull.
const listeners = new Set<() => void>();
function notify() {
  for (const l of listeners) {
    try { l(); } catch {}
  }
}

/** Drop this device's completion records (account switch / sign-out). */
export async function resetLocalCompletion(): Promise<void> {
  completionCache = {};
  recheckDone = false;
  await completionWrites.catch(() => {});
  await AsyncStorage.removeItem(KEY).catch(() => {});
  notify();
}

/** All completion records for this anime, by any source href or folded title. */
function matchCompletionRecords(
  map: Record<string, AnimeCompletion>,
  hrefs: (string | null | undefined)[],
  titles: (string | null | undefined)[],
): AnimeCompletion[] {
  const hrefKeys = new Set((hrefs || []).filter(Boolean).map((h) => normAnimeKey(h!)));
  const titleKeys = new Set((titles || []).filter(Boolean).map((t) => animeTitleKey(t!)));
  return matchingRecords(Object.values(map), hrefKeys, titleKeys, normAnimeKey, animeTitleKey);
}

/** Push one record to Supabase (fire-and-forget; logs on failure). */
async function pushToCloud(rec: AnimeCompletion) {
  if (!isSupabaseConfigured) return;
  const user = await getSessionUser();
  if (!user) return;
  const { error } = await supabase.from("anime_completion").upsert({
    user_id: user.id,
    anime_key: rec.key,
    hrefs: rec.hrefs,
    titles: rec.titles,
    last_ep_num: rec.lastEpNum,
    caught_up: rec.caughtUp || !!rec.marked,
    finished: rec.finished || !!rec.marked,
    marked_completed: !!rec.marked,
    image: rec.image ?? null,
    updated_at: new Date(rec.updatedAt).toISOString(),
  }, { onConflict: "user_id,anime_key" });
  if (error) console.warn("[completion] cloud sync failed:", error.message);
}

/**
 * Upsert the completion record for an anime. Keyed by the normalized primary
 * href (falling back to the title). All passed hrefs/titles are merged into the
 * record (union with any already stored) so cross-source cards keep matching.
 * Skipped when nothing meaningful changed so we don't churn storage / re-render.
 */
export async function recordAnimeCompletion(rec: {
  hrefs: (string | null | undefined)[];
  titles: (string | null | undefined)[];
  lastEpNum: number;
  caughtUp: boolean;
  finished?: boolean;
  /** History has an entry (watched or not) for the last episode. False = it
   *  aged out of the capped local history, which must not erase the badge. */
  lastTracked?: boolean;
}): Promise<void> {
  const hrefs = uniq(rec.hrefs);
  const titles = uniq(rec.titles);
  // ponytail: TLD-stable key. Records written under the old full-URL scheme keep
  // resolving via buildLookup (it re-indexes hrefs by normAnimeKey), so badges
  // still show; a stale old-key record may briefly co-exist until it's re-written.
  const map = await getCompletionMap();
  // Reuse any record this anime already has under ANOTHER source URL/title.
  // Keying purely off the incoming href used to mint a second record (witanime
  // vs anime4up, "III" vs "Ⅲ") with its own caughtUp state — a card resolving
  // the stale copy then showed no badge although the finale was watched.
  const matches = matchCompletionRecords(map, hrefs, titles);
  const anchor = normAnimeKey(hrefs[0] || "") || animeTitleKey(titles[0]);
  // This page's own record: the copy keyed by its href (any TLD, or the legacy
  // full-URL key), else the best existing copy, else a new one.
  const existing = matches.find((r) => normAnimeKey(r.key) === anchor) ??
    [...matches].sort((a, b) => b.lastEpNum - a.lastEpNum || b.updatedAt - a.updatedAt)[0];
  const key = existing?.key ?? anchor;
  if (!key) return;
  const prev = existing;
  // Local history keeps only the newest MAX_ITEMS episodes: an anime finished
  // months ago no longer shows its finale as watched, and re-recording false
  // over the good record made its badge vanish for good. Keep the durable mark
  // of any copy at this same episode count unless history explicitly knows the
  // finale (watched or unmarked).
  const durable = rec.lastTracked === false && !rec.caughtUp
    ? matches.find((r) => r.lastEpNum === rec.lastEpNum && r.caughtUp)
    : undefined;
  if (durable) rec = { ...rec, caughtUp: true, finished: rec.finished ?? durable.finished };
  // A hand-made "completed" mark wins over whatever history says.
  const marked = matches.some((r) => r.marked);
  if (marked) rec = { ...rec, caughtUp: true, finished: true };
  const state = {
    // The detail page is authoritative: it records the episode list the user
    // actually sees. Keeping a higher stored number (a feed item from another
    // source, a different numbering) made the badge impossible to ever earn —
    // reopening the page could never fix it. A real newer episode re-raises it
    // through the anchor-source feed reconcile.
    lastEpNum: rec.lastEpNum,
    caughtUp: rec.caughtUp,
    // ANY copy (witanime / anime4up / anime3rb) already confirmed finished at
    // this episode count keeps it — checking only the anchor copy downgraded
    // the confirmed sibling to "caught up" (Tokyo Revengers: Seiya Kessen-hen).
    finished: rec.caughtUp && (rec.finished ?? matches.some((r) => r.lastEpNum === rec.lastEpNum && r.finished)),
    marked,
  };
  const next: AnimeCompletion = {
    key,
    // Only THIS record's own hrefs/titles plus the page's. Unioning every
    // match's identity into every match snowballed one bad link into a blob of
    // unrelated anime (One Piece + Mushoku Tensei shared one badge state).
    // The page's href goes FIRST: hrefs[0] is the anchor source whose feed
    // items may move lastEpNum (reconcileCompletionFromEpisodes).
    hrefs: uniq([...hrefs, ...(existing?.hrefs || [])]),
    titles: uniq([...(existing?.titles || []), ...titles]),
    ...state,
    image: existing?.image,
    updatedAt: Date.now(),
  };
  const sameState = (r: AnimeCompletion) =>
    r.caughtUp === state.caughtUp && r.finished === state.finished && r.lastEpNum === state.lastEpNum && !!r.marked === marked;
  if (existing && matches.every(sameState) && existing.hrefs[0] === next.hrefs[0] &&
    existing.hrefs.length === next.hrefs.length && existing.titles.length === next.titles.length) {
    if (rec.finished === undefined && next.caughtUp && !next.finished)
      void confirmFinished(map, matches, titles[0] || next.titles[0], next.lastEpNum);
    return;
  }
  // Other copies of this anime (other source keys) take the state only.
  for (const match of matches) if (match.key !== key) map[match.key] = { ...match, ...state, updatedAt: next.updatedAt };
  map[key] = next;
  await saveCompletionMap(map);
  notify();
  const updated = [next, ...matches.filter((r) => r.key !== key).map((r) => map[r.key])];
  for (const changed of updated) pushToCloud(changed).catch(() => {});
  if (rec.finished === undefined && next.caughtUp && !next.finished)
    void confirmFinished(map, updated, titles[0] || next.titles[0], next.lastEpNum);
}

/**
 * The detail page's "I've finished this" toggle — for anime watched before the
 * app (or elsewhere), so they count as completed on the account. Marks EVERY
 * matching copy (same as the automatic state). Unmarking hands the anime back
 * to the history-derived state the page passes in.
 */
export async function setAnimeMarkedCompleted(opts: {
  hrefs: (string | null | undefined)[];
  titles: (string | null | undefined)[];
  image?: string | null;
  lastEpNum: number;
  marked: boolean;
  /** History-derived state, applied when unmarking. */
  caughtUp: boolean;
  lastTracked?: boolean;
}): Promise<void> {
  const hrefs = uniq(opts.hrefs);
  const titles = uniq(opts.titles);
  const key = normAnimeKey(hrefs[0] || "") || animeTitleKey(titles[0]);
  if (!key) return;
  const map = await getCompletionMap();
  let targets = matchCompletionRecords(map, hrefs, titles);
  if (targets.length === 0) {
    targets = [{ key, hrefs, titles, lastEpNum: opts.lastEpNum, caughtUp: false, finished: false, updatedAt: 0 }];
  }
  const now = Date.now();
  const changed: AnimeCompletion[] = [];
  for (const rec of targets) {
    const next: AnimeCompletion = {
      ...rec,
      lastEpNum: Math.max(rec.lastEpNum, opts.lastEpNum),
      marked: opts.marked,
      // Unmark clears the state; recordAnimeCompletion below recomputes it.
      caughtUp: opts.marked,
      finished: opts.marked,
      image: rec.image || opts.image || undefined,
      updatedAt: now,
    };
    map[rec.key] = next;
    changed.push(next);
  }
  await saveCompletionMap(map);
  notify();
  for (const rec of changed) pushToCloud(rec).catch(() => {});
  if (!opts.marked && opts.lastEpNum > 0) {
    await recordAnimeCompletion({ hrefs, titles, lastEpNum: opts.lastEpNum, caughtUp: opts.caughtUp, lastTracked: opts.lastTracked });
  }
}

/** Hydrate the local cache from Supabase (called after sign-in). */
export async function pullCompletionFromCloud(): Promise<void> {
  if (!isSupabaseConfigured) return;
  const user = await getSessionUser();
  if (!user) return;
  const { data, error } = await supabase.from("anime_completion")
    .select("*")
    .eq("user_id", user.id);
  if (error) { console.warn("[completion] pull failed:", error.message); return; }
  if (!data) return;
  const map = await getCompletionMap();
  for (const row of data as any[]) {
    let cloud: AnimeCompletion = {
      key: row.anime_key,
      hrefs: Array.isArray(row.hrefs) ? row.hrefs : [],
      titles: Array.isArray(row.titles) ? row.titles : [],
      lastEpNum: row.last_ep_num || 0,
      caughtUp: !!row.caught_up || !!row.marked_completed,
      finished: !!row.finished || !!row.marked_completed,
      marked: !!row.marked_completed,
      image: row.image || undefined,
      updatedAt: new Date(row.updated_at).getTime(),
    };
    const repaired = repairBlob(cloud);
    if (repaired) {
      // Never let a blob back in: a repaired local copy wins, else store the repair.
      if (map[cloud.key] && !isBlobRecord(map[cloud.key], normAnimeKey, animeTitleKey)) cloud = { ...map[cloud.key] };
      else cloud = repaired;
      map[cloud.key] = cloud;
      pushToCloud(cloud).catch(() => {});
      continue;
    }
    const local = map[cloud.key];
    // Newest write wins, but keep the union of known hrefs/titles either way.
    if (!local || (cloud.updatedAt >= local.updatedAt && cloud.lastEpNum >= local.lastEpNum)) {
      map[cloud.key] = {
        ...cloud,
        image: cloud.image || local?.image,
        hrefs: uniq([...(local?.hrefs || []), ...cloud.hrefs]),
        titles: uniq([...(local?.titles || []), ...cloud.titles]),
      };
    } else {
      map[cloud.key] = {
        ...local,
        hrefs: uniq([...local.hrefs, ...cloud.hrefs]),
        titles: uniq([...local.titles, ...cloud.titles]),
      };
    }
  }
  await saveCompletionMap(map);
  notify();
}

/**
 * Re-ask AniList about anime stuck at "caught up" but not "finished". The
 * finished check used to miss real finales (episode-0 count mismatch, "Ⅲ"
 * titles), and it only re-ran on a detail-page revisit — so those anime never
 * reached the profile's completed list. One pass per app session, sequential,
 * one request per anime (copies grouped).
 */
let recheckDone = false;
export async function recheckUnfinishedCompletions(): Promise<void> {
  if (recheckDone) return;
  recheckDone = true;
  const map = await getCompletionMap();
  const groups = new Map<string, AnimeCompletion[]>();
  for (const rec of Object.values(map)) {
    if (!rec.caughtUp || rec.finished || rec.lastEpNum <= 0) continue;
    const title = rec.titles[0];
    if (!title) continue;
    const id = `${animeTitleKey(title)}:${rec.lastEpNum}`;
    groups.set(id, [...(groups.get(id) || []), rec]);
  }
  // ponytail: cap per session; the rest are picked up next launch / on visit.
  for (const recs of [...groups.values()].slice(0, 20)) {
    await confirmFinished(map, recs, recs[0].titles[0], recs[0].lastEpNum);
  }
}

/** Count of anime whose final episode the user has watched (profile stat). */
export async function countCompletedAnime(): Promise<number> {
  const map = await getCompletionMap();
  return new Set(Object.values(map).filter((r) => r.finished)
    .map((r) => animeTitleKey(r.titles[0]) || normAnimeKey(r.hrefs[0]) || r.key)).size;
}

/** Anime whose finale the user watched (My List "completed" shelf), with
 *  posters from watch history, then the caller's extra sources (My List). */
export async function getCompletedAnime(
  extraPosters: readonly { title: string; href: string; image?: string | null }[] = [],
): Promise<CompletedEntry[]> {
  const [map, groups] = await Promise.all([getCompletionMap(), getHistoryByAnime().catch(() => [])]);
  const posters = [
    ...groups.map((g) => ({ title: g.animeTitle, href: g.animeHref, image: g.image })),
    ...extraPosters,
    ...Object.values(map).filter((r) => r.image).map((r) => ({ title: r.titles[0] || "", href: r.hrefs[0] || r.key, image: r.image })),
  ];
  return buildCompletedList(Object.values(map), posters, normAnimeKey, animeTitleKey);
}

/** Recompute home badges from available episodes and local history, even when
 * the episode number has not changed or the detail page was never opened. */
export async function reconcileCompletionFromEpisodes(
  items: { animeHref?: string | null; animeTitle?: string | null; epNum: number | null }[],
): Promise<void> {
  if (!items || items.length === 0) return;
  const [map, sets] = await Promise.all([getCompletionMap(), getCompletedSets()]);
  // Index once: reconciling N records must not scan all N for each item.
  const byHref = new Map<string, Set<string>>();
  const byTitle = new Map<string, Set<string>>();
  const index = (rec: AnimeCompletion) => {
    for (const [values, lookup, normalize] of [
      [rec.hrefs, byHref, normAnimeKey], [rec.titles, byTitle, animeTitleKey],
    ] as const) {
      for (const value of values) {
        const key = normalize(value);
        if (!key) continue;
        let keys = lookup.get(key);
        if (!keys) { keys = new Set(); lookup.set(key, keys); }
        keys.add(rec.key);
      }
    }
  };
  for (const rec of Object.values(map)) index(rec);

  // Highest episode number now available per matched record (by record key).
  const newestByKey = new Map<string, number>();
  let changed = false;
  for (const it of items) {
    if (it.epNum == null || it.epNum <= 0) continue;
    const keys = new Set([
      ...(byHref.get(normAnimeKey(it.animeHref || "")) || []),
      ...(byTitle.get(animeTitleKey(it.animeTitle)) || []),
    ]);
    let recs = [...keys].map((key) => map[key]);
    if (recs.length === 0) {
      const key = normAnimeKey(it.animeHref || "") || animeTitleKey(it.animeTitle);
      if (!key) continue;
      const rec = map[key] ?? { key, hrefs: uniq([it.animeHref]), titles: uniq([it.animeTitle]), lastEpNum: 0, caughtUp: false, finished: false, updatedAt: 0 };
      map[key] = rec;
      index(rec);
      recs = [rec];
    }
    const itemKey = normAnimeKey(it.animeHref || "");
    // Update EVERY copy, not just the first — duplicate records otherwise keep
    // a stale state, and a card resolving the stale copy never shows the badge.
    for (const rec of recs) {
      const hrefs = uniq([...rec.hrefs, it.animeHref]);
      const titles = uniq([...rec.titles, it.animeTitle]);
      if (hrefs.length !== rec.hrefs.length || titles.length !== rec.titles.length) {
        map[rec.key] = { ...rec, hrefs, titles };
        index(map[rec.key]);
        changed = true;
      }
      // Only a feed item from this copy's anchor source (hrefs[0] — the detail
      // page's own source) may move its episode number; another source's
      // numbering inflated lastEpNum past the list the detail page shows.
      if (!sameSource(itemKey, normAnimeKey(rec.hrefs[0] || ""))) continue;
      const cur = newestByKey.get(rec.key) || 0;
      if (it.epNum > cur) newestByKey.set(rec.key, it.epNum);
    }
  }
  if (newestByKey.size === 0) return;

  for (const [key, newest] of newestByKey) {
    const rec = map[key];
    if (!rec || rec.marked) continue;
    const latest = Math.max(newest, rec.lastEpNum);
    let watchedNewest = false;
    let tracked = false;
    for (const tt of rec.titles) {
      const tk = animeTitleKey(tt);
      if (!tk) continue;
      if (sets.knownNumbersByTitle.get(tk)?.has(latest)) tracked = true;
      const nums = sets.numbersByTitle.get(tk);
      if (nums && nums.has(latest)) { watchedNewest = true; break; }
    }
    // Keep a durable mark if its episode aged out of history. Clear it for
    // an explicit unmark or a newly available, unwatched episode.
    const caughtUp = watchedNewest || (!tracked && latest === rec.lastEpNum && rec.caughtUp);
    const finished = rec.finished && caughtUp && latest === rec.lastEpNum;
    if (rec.lastEpNum === latest && rec.caughtUp === caughtUp && rec.finished === finished) continue;
    map[key] = {
      ...rec,
      lastEpNum: latest,
      caughtUp,
      finished,
      updatedAt: Date.now(),
    };
    changed = true;
    if (rec.caughtUp || rec.finished || caughtUp) pushToCloud(map[key]).catch(() => {});
  }

  if (changed) {
    await saveCompletionMap(map);
    notify();
  }
}

/**
 * Mark an anime caught-up/finished the instant its LATEST episode is watched —
 * called from the player when an episode crosses the "completed" threshold, so
 * the badge updates without reopening the detail page.
 *
 * Every matching record is updated, not just the first: the same anime can have
 * one record per source URL (witanime vs anime4up), and leaving a copy behind
 * meant a card resolving to it showed no badge. When NO record exists and the
 * opener told us this is the last episode (`isLast` — the detail grid passes
 * nextEp="" for the finale), the player establishes the record itself so the
 * badge appears even though the detail page was never opened. Never downgrades.
 */
export async function recordEpisodeWatched(opts: {
  animeHref?: string | null;
  animeTitle?: string | null;
  epNum: number | null;
  /** The opener knew this was the last available episode. */
  isLast?: boolean;
}): Promise<void> {
  if (opts.epNum == null || opts.epNum <= 0) return;
  const map = await getCompletionMap();
  let matches = matchCompletionRecords(map, [opts.animeHref], [opts.animeTitle]);
  if (matches.length === 0) {
    if (!opts.isLast) return; // nothing to attach the completion to yet
    const key = normAnimeKey(opts.animeHref || "") || animeTitleKey(opts.animeTitle);
    if (!key) return;
    // `finished` stays false here — the detail page upgrades it with the
    // AniList airing check on its next visit; the badge shows as caught-up.
    const created: AnimeCompletion = {
      key,
      hrefs: uniq([opts.animeHref]),
      titles: uniq([opts.animeTitle]),
      lastEpNum: opts.epNum,
      caughtUp: false,
      finished: false,
      updatedAt: 0,
    };
    map[key] = created;
    matches = [created];
  }

  let changed = false;
  const marked: AnimeCompletion[] = [];
  for (const rec of matches) {
    if (opts.epNum < rec.lastEpNum) continue; // not the latest available episode
    if (rec.caughtUp && rec.finished && opts.epNum === rec.lastEpNum) continue;
    const next: AnimeCompletion = {
      ...rec,
      lastEpNum: Math.max(rec.lastEpNum, opts.epNum),
      caughtUp: true,
      finished: !!rec.marked || (rec.finished && opts.epNum === rec.lastEpNum),
      updatedAt: Date.now(),
    };
    if (next.caughtUp === rec.caughtUp && next.finished === rec.finished && next.lastEpNum === rec.lastEpNum) {
      marked.push(rec);
      continue;
    }
    map[next.key] = next;
    changed = true;
    marked.push(next);
    pushToCloud(next).catch(() => {});
  }
  if (changed) {
    await saveCompletionMap(map);
    notify();
  }
  if (!marked.length) return;
  await confirmFinished(map, marked, opts.animeTitle || matches[0].titles[0] || "", opts.epNum);
}

const finishedRequests = createRequestCache<boolean>(60_000);
async function confirmFinished(map: Record<string, AnimeCompletion>, marked: AnimeCompletion[], title: string, epNum: number) {
  // The network may only upgrade the exact snapshot that requested it. Local
  // unmarks and newer episodes invalidate it, even after leaving the detail page.
  try {
    const finished = await finishedRequests.run(`${animeTitleKey(title)}:${epNum}`, () =>
      withTimeout(import("./airing").then(({ fetchSeriesFinished }) => fetchSeriesFinished(title, epNum)), 6000, false));
    if (!finished) return;
    let upgraded = false;
    for (const rec of marked) {
      if (map[rec.key] !== rec || !rec.caughtUp || rec.lastEpNum !== epNum) continue;
      map[rec.key] = { ...rec, finished: true, updatedAt: Date.now() };
      upgraded = true;
      pushToCloud(map[rec.key]).catch(() => {});
    }
    if (upgraded) { await saveCompletionMap(map); notify(); }
  } catch {}
}

/* ── Lookup + context ───────────────────────────────── */

export interface CompletionLookup {
  byHref: Map<string, AnimeCompletion>;
  byTitle: Map<string, AnimeCompletion>;
  /** Resolve a card to its completion record by any of its source hrefs/titles. */
  get(opts: {
    hrefs?: (string | null | undefined)[];
    titles?: (string | null | undefined)[];
  }): AnimeCompletion | null;
}

export function buildLookup(map: Record<string, AnimeCompletion>): CompletionLookup {
  const byHref = new Map<string, AnimeCompletion>();
  const byTitle = new Map<string, AnimeCompletion>();
  // A record "owns" the page it was recorded from (its key / anchor hrefs[0]).
  // A card resolves its own page's record first: another source's copy that
  // merely lists this href (added by a title match) runs on that source's
  // numbering and must not override it.
  const byAnchor = new Map<string, AnimeCompletion>();
  // Index by the TLD-stable anime key + decoration-folded title so a badge
  // resolves regardless of which rotating witanime TLD (.life/.you) or which
  // source's decorated title a card carries vs. what was recorded.
  // Later entries win a slot: higher episode count first, then — at the same
  // count — a caught-up/finished copy over an unmarked duplicate (a stub or an
  // eviction artifact), then the newest write.
  const rank = (r: AnimeCompletion) => (r.finished ? 2 : r.caughtUp ? 1 : 0);
  for (const rec of Object.values(map).sort((a, b) => a.lastEpNum - b.lastEpNum || rank(a) - rank(b) || a.updatedAt - b.updatedAt)) {
    for (const h of rec.hrefs) { const key = normAnimeKey(h); if (key) byHref.set(key, rec); }
    for (const h of [rec.key, rec.hrefs[0]]) { const key = normAnimeKey(h || ""); if (key) byAnchor.set(key, rec); }
    for (const tt of rec.titles) { const key = animeTitleKey(tt); if (key) byTitle.set(key, rec); }
  }
  return {
    byHref,
    byTitle,
    get({ hrefs, titles }) {
      for (const h of hrefs || []) {
        if (h) { const r = byAnchor.get(normAnimeKey(h)); if (r) return r; }
      }
      for (const h of hrefs || []) {
        if (h) { const r = byHref.get(normAnimeKey(h)); if (r) return r; }
      }
      for (const tt of titles || []) {
        if (tt) { const r = byTitle.get(animeTitleKey(tt)); if (r) return r; }
      }
      return null;
    },
  };
}

const EMPTY = buildLookup({});
const CompletionContext = createContext<CompletionLookup>(EMPTY);

export function CompletionProvider({ children }: { children: ReactNode }) {
  const [lookup, setLookup] = useState<CompletionLookup>(EMPTY);
  const refresh = useCallback(() => {
    getCompletionMap().then((m) => setLookup(buildLookup(m))).catch(() => {});
  }, []);
  useEffect(() => {
    refresh();
    listeners.add(refresh);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const reconcile = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      void getCompletionMap().then((map) => reconcileCompletionFromEpisodes(Object.values(map).map((rec) => ({
        animeHref: rec.hrefs[0], animeTitle: rec.titles[0], epNum: rec.lastEpNum,
      })))).catch(() => {});
    };
    // The initial reconcile re-parses the whole completion map and history on
    // the JS thread; defer it out of the launch window (refresh() above already
    // built the badges — this only corrects caught-up state). An earlier
    // history change reconciles right away instead.
    timer = setTimeout(reconcile, 3500);
    // Playback saves progress every 10s; coalesce those writes instead of
    // re-parsing the map + history on each one.
    const unsubscribe = subscribeHistory(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(reconcile, 1500);
    });
    return () => { if (timer) clearTimeout(timer); listeners.delete(refresh); unsubscribe(); };
  }, [refresh]);
  return <CompletionContext.Provider value={lookup}>{children}</CompletionContext.Provider>;
}

export function useCompletionLookup(): CompletionLookup {
  return useContext(CompletionContext);
}

/** Resolve the completion record for a card by its source hrefs/titles. */
export function useAnimeCompletion(
  hrefs?: (string | null | undefined)[],
  titles?: (string | null | undefined)[],
): AnimeCompletion | null {
  return useCompletionLookup().get({ hrefs, titles });
}
