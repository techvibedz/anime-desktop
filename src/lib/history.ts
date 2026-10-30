import { storage } from "./storage";
import { supabase, isSupabaseConfigured } from "./supabase";

const KEY = "watch_history";
const DISMISSED_KEY = "watch_history_dismissed_desktop";
const MAX_ITEMS = 200;

// Change notifier: the completion store re-reconciles badges whenever the
// history changes (mirrors mobile lib/history.ts subscribeHistory).
const historyListeners = new Set<() => void>();
export function subscribeHistory(cb: () => void): () => void {
  historyListeners.add(cb);
  return () => { historyListeners.delete(cb); };
}

async function writeHistory(list: WatchEntry[]): Promise<void> {
  await storage.setItem(KEY, JSON.stringify(list));
  for (const cb of historyListeners) {
    try { cb(); } catch {}
  }
}

export interface WatchEntry {
  episodeHref: string;
  episodeTitle: string;
  animeTitle: string;
  animeHref: string;
  image: string;
  positionMs: number;
  durationMs: number;
  updatedAt: number;
  url4up?: string;
  completed?: boolean;
  /** Episode number, when known — lets watched-state bridge across sources
   *  (the same episode has a different URL on witanime / anime4up / anime3rb). */
  epNum?: number;
}

function autoCompleted(e: WatchEntry): boolean {
  return e.durationMs > 0 && e.positionMs / e.durationMs >= 0.85;
}

async function pushToCloud(entry: WatchEntry) {
  if (!isSupabaseConfigured) return;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  // The dismissed flag lives in its own local set on desktop; include it in
  // the row so a dismissal also survives a local-storage wipe and reaches the
  // other device (mobile stores it in the same column).
  const dismissedSet = await getDismissedHrefs();
  const { error } = await supabase.from("watch_history").upsert({
    user_id: user.id,
    episode_href: entry.episodeHref,
    episode_title: entry.episodeTitle,
    anime_title: entry.animeTitle,
    anime_href: entry.animeHref,
    image: entry.image,
    position_ms: entry.positionMs,
    duration_ms: entry.durationMs,
    updated_at: new Date(entry.updatedAt).toISOString(),
    url4up: entry.url4up ?? null,
    completed: entry.completed ?? autoCompleted(entry),
    dismissed: dismissedSet.has(entry.episodeHref),
  }, { onConflict: "user_id,episode_href" });
  if (error) console.warn("[history] cloud sync failed:", error.message);
}

async function deleteFromCloud(episodeHref: string) {
  if (!isSupabaseConfigured) return;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  await supabase.from("watch_history").delete()
    .eq("user_id", user.id).eq("episode_href", episodeHref);
}

/**
 * Hydrate local cache from Supabase. MERGE, never replace: overwriting local
 * storage with the cloud copy meant one failed push (offline save, expired
 * session) wiped the user's progress and Continue Watching row on the next
 * Home mount. Local entries the cloud doesn't know about are kept; for shared
 * hrefs the newer updatedAt wins.
 */
export async function pullHistoryFromCloud() {
  if (!isSupabaseConfigured) return;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  const { data, error } = await supabase.from("watch_history")
    .select("*").eq("user_id", user.id)
    .order("updated_at", { ascending: false }).limit(MAX_ITEMS);
  if (error) { console.warn("[history] pull failed:", error.message); return; }
  if (!data) return;
  const remote: WatchEntry[] = data.map((row: any) => ({
    episodeHref: row.episode_href,
    episodeTitle: row.episode_title,
    animeTitle: row.anime_title,
    animeHref: row.anime_href,
    image: row.image || "",
    positionMs: row.position_ms,
    durationMs: row.duration_ms,
    updatedAt: new Date(row.updated_at).getTime(),
    url4up: row.url4up || undefined,
    completed: !!row.completed,
  }));
  // Dismissals live in their own set here (mobile keeps them on the row).
  // Reconcile with the cloud: dismissed rows add to the set, and a NEWER
  // un-dismissed row (re-watched on the other device) removes from it — so a
  // dismissal survives reinstalls without sticking forever.
  const local = await getHistory();
  const localByHref = new Map(local.map((e) => [e.episodeHref, e]));
  const dismissed = await getDismissedHrefs();
  let dismissedChanged = false;
  for (const row of data as any[]) {
    const href = row.episode_href as string;
    if (row.dismissed) {
      if (!dismissed.has(href)) { dismissed.add(href); dismissedChanged = true; }
    } else {
      const localEntry = localByHref.get(href);
      const remoteAt = row.updated_at ? new Date(row.updated_at).getTime() : 0;
      if (localEntry && remoteAt > localEntry.updatedAt && dismissed.delete(href)) dismissedChanged = true;
    }
  }
  if (dismissedChanged) await setDismissedHrefs(dismissed);
  const byHref = new Map<string, WatchEntry>();
  for (const entry of local) byHref.set(entry.episodeHref, entry);
  for (const row of remote) {
    const existing = byHref.get(row.episodeHref);
    if (!existing) {
      byHref.set(row.episodeHref, row);
    } else if (row.updatedAt > existing.updatedAt) {
      byHref.set(row.episodeHref, { ...existing, ...row, epNum: row.epNum ?? existing.epNum });
    }
  }
  const merged = [...byHref.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_ITEMS);
  await writeHistory(merged);
}

async function getDismissedHrefs(): Promise<Set<string>> {
  const raw = await storage.getItem(DISMISSED_KEY);
  if (!raw) return new Set();
  try {
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

async function setDismissedHrefs(hrefs: Set<string>): Promise<void> {
  await storage.setItem(DISMISSED_KEY, JSON.stringify([...hrefs]));
}

export async function getHistory(): Promise<WatchEntry[]> {
  const raw = await storage.getItem(KEY);
  return raw ? JSON.parse(raw) : [];
}

export async function saveProgress(entry: Omit<WatchEntry, "updatedAt">) {
  const list = await getHistory();
  const idx = list.findIndex((e) => e.episodeHref === entry.episodeHref);
  const prev = idx >= 0 ? list[idx] : null;
  const merged: WatchEntry = {
    ...entry,
    // Preserve any existing image if the caller didn't supply one
    image: entry.image || prev?.image || "",
    updatedAt: Date.now(),
    completed: entry.completed ?? (prev?.completed ?? false),
  };
  if (merged.completed !== true && autoCompleted(merged)) merged.completed = true;
  if (idx >= 0) {
    list[idx] = merged;
  } else {
    list.unshift(merged);
    if (list.length > MAX_ITEMS) list.length = MAX_ITEMS;
  }
  list.sort((a, b) => b.updatedAt - a.updatedAt);
  await writeHistory(list);
  const dismissed = await getDismissedHrefs();
  if (dismissed.delete(entry.episodeHref)) await setDismissedHrefs(dismissed);
  pushToCloud(merged).catch(() => {});
}

/**
 * One entry per anime for the "Continue Watching" row — the most recently
 * watched episode of each series, so the user resumes where they stopped
 * instead of seeing every episode they've watched. Mirrors the mobile app so
 * both surfaces render the same list off the shared cloud history.
 */
export async function getContinueWatching(): Promise<WatchEntry[]> {
  const list = await getHistory();
  const dismissed = await getDismissedHrefs();
  // One card per anime (newest-first). A dismissed card must hide the WHOLE
  // anime: the previous episode of the same series would otherwise immediately
  // take its place and the X button would look broken. A VISIBLE entry always
  // beats a dismissed one, so re-watching brings the card straight back.
  const bestPerAnime = new Map<string, WatchEntry>();
  for (const e of list) {
    const key = e.animeHref || e.animeTitle;
    if (dismissed.has(e.episodeHref)) {
      if (!bestPerAnime.has(key)) bestPerAnime.set(key, e);
      continue;
    }
    const current = bestPerAnime.get(key);
    if (!current || dismissed.has(current.episodeHref) || e.updatedAt > current.updatedAt) {
      bestPerAnime.set(key, e);
    }
  }
  const out: WatchEntry[] = [];
  for (const e of bestPerAnime.values()) {
    if (dismissed.has(e.episodeHref)) continue;
    out.push(e);
  }
  return out;
}

export async function getProgress(episodeHref: string): Promise<WatchEntry | null> {
  const list = await getHistory();
  return list.find((e) => e.episodeHref === episodeHref) ?? null;
}

export async function removeFromHistory(episodeHref: string) {
  const list = await getHistory();
  await writeHistory(list.filter((e) => e.episodeHref !== episodeHref));
  deleteFromCloud(episodeHref).catch(() => {});
}

export async function dismissFromContinue(episodeHref: string) {
  const dismissed = await getDismissedHrefs();
  // The row groups by anime — dismissing a single episode would just reveal
  // the previous one, so hide every entry of this series (progress is kept).
  const list = await getHistory();
  const target = list.find((e) => e.episodeHref === episodeHref);
  if (target) {
    const key = target.animeHref || target.animeTitle;
    for (const entry of list) {
      if ((entry.animeHref || entry.animeTitle) === key) dismissed.add(entry.episodeHref);
    }
  } else {
    dismissed.add(episodeHref);
  }
  await setDismissedHrefs(dismissed);
}

export function formatProgress(entry: WatchEntry): string {
  const pct = entry.durationMs > 0 ? Math.round((entry.positionMs / entry.durationMs) * 100) : 0;
  return `${pct}%`;
}

export function progressPercent(entry: WatchEntry): number {
  return entry.durationMs > 0 ? Math.min(entry.positionMs / entry.durationMs, 1) : 0;
}

export function isCompleted(entry: WatchEntry | null | undefined): boolean {
  if (!entry) return false;
  if (entry.completed === true) return true;
  return autoCompleted(entry);
}

export async function getWatchedHrefsForAnime(animeHref: string): Promise<Set<string>> {
  const list = await getHistory();
  const set = new Set<string>();
  for (const e of list) {
    if (e.animeHref === animeHref && isCompleted(e)) set.add(e.episodeHref);
  }
  return set;
}

/** Normalize an episode URL so encoding / trailing-slash / case differences
 *  between sources don't defeat equality checks. */
export function normHref(u: string | null | undefined): string {
  if (!u) return "";
  try { return decodeURIComponent(u).replace(/\/+$/, "").toLowerCase(); }
  catch { return u.replace(/\/+$/, "").toLowerCase(); }
}

// Stabilize a per-anime key across witanime's rotating TLD (.life/.you/...).
// Collapses the host to its second-level label (drop the TLD) + path, so the
// SAME anime keyed while the app resolved a different TLD folds to one identity.
// Used by completion badges so a record stored under witanime.life still matches
// a lookup resolved under witanime.you. Mirrors mobile lib/history.ts.
export function normAnimeKey(k: string): string {
  if (!k) return "";
  try {
    const u = new URL(k);
    const host = u.hostname.replace(/^www\./, "");
    const labels = host.split(".");
    const sld = labels.length >= 2 ? labels[labels.length - 2] : host;
    return (sld + u.pathname).replace(/\/+$/, "").toLowerCase();
  } catch {
    return k.trim().toLowerCase();
  }
}

// Source/SEO decoration words dropped from a title key so a decorated title
// (anime3rb stores "أنمي … مترجم") keys identically to the clean name another
// source stores. Matched as whole tokens before any Unicode folding.
const TITLE_DECORATION = new Set([
  "أنمي", "انمي", "انيمي", "مترجم", "مترجمة", "مدبلج", "مدبلجة", "مشاهدة",
  "تحميل", "اون", "أون", "أونلاين", "لاين", "بجودة", "عالية", "حلقات",
  "الحلقات", "جميع", "عرب", "anime3rb", "anime4up", "witanime",
]);

/**
 * Normalize an anime title into a cross-source key. The same anime carries an
 * identical romaji name on witanime / anime4up / anime3rb, so a normalized title
 * + episode number lets a "watched" flag set in one source light up in the
 * others — the episode URLs themselves differ per source and can't be compared.
 */
// Memo cache — animeTitleKey runs NFKD + regex tokenization, wasteful when
// called repeatedly for the SAME titles (the episode grid asks once per card).
const titleKeyCache = new Map<string, string>();

export function animeTitleKey(s: string | null | undefined): string {
  const raw = s || "";
  const cached = titleKeyCache.get(raw);
  if (cached !== undefined) return cached;
  const key = raw
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ]+/g, " ")
    .trim()
    .split(" ")
    .filter((tok) => tok && !TITLE_DECORATION.has(tok))
    // Joined WITHOUT a separator so a title stored with punctuation
    // ("Re:Zero") keys identically to the same name without it ("Rezero").
    .join("")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "");
  if (titleKeyCache.size > 2000) titleKeyCache.clear();
  titleKeyCache.set(raw, key);
  return key;
}

/** Pull an episode number out of a history entry — the stored epNum when
 *  present, else parsed from the episode URL or title. */
function deriveEpNum(e: WatchEntry): number | null {
  if (typeof e.epNum === "number" && e.epNum > 0) return e.epNum;
  const fromStr = (s?: string): number | null => {
    if (!s) return null;
    let d = s;
    try { d = decodeURIComponent(s); } catch {}
    const m =
      d.match(/الحلقة[\s\-_]*(\d+)/) ||
      d.match(/\/(?:episode|watch)\/[^/]+\/(\d+)(?:\/|$)/i) ||
      d.match(/\bepisode\s*(\d+)/i);
    return m ? parseInt(m[1], 10) : null;
  };
  return fromStr(e.episodeHref) ?? fromStr(e.episodeTitle);
}

/** One row per anime across the whole history (For You seeding). */
export interface AnimeHistoryGroup {
  key: string;
  animeTitle: string;
  animeHref: string;
  image: string;
  last: WatchEntry;
  updatedAt: number;
  /** Distinct episodes stored for the anime (across sources). */
  episodes: number;
  /** Distinct episodes completed. */
  watched: number;
  lastEpNum: number | null;
}

/**
 * Group raw history into one row per anime, newest activity first. Keys by
 * normalized title (the same anime recurs under different animeHref values)
 * and falls back to the normalized anime href. Mirrors mobile lib/history.ts.
 */
export function groupHistoryByAnime(list: readonly WatchEntry[]): AnimeHistoryGroup[] {
  const titleByHrefKey = new Map<string, string>();
  for (const entry of list) {
    const tk = animeTitleKey(entry.animeTitle);
    const hk = normAnimeKey(entry.animeHref);
    if (tk && hk && !titleByHrefKey.has(hk)) titleByHrefKey.set(hk, tk);
  }
  const groups = new Map<string, { entries: WatchEntry[]; last: WatchEntry }>();
  for (const entry of list) {
    const hk = normAnimeKey(entry.animeHref);
    const key = animeTitleKey(entry.animeTitle) || titleByHrefKey.get(hk) || hk || entry.animeHref || entry.animeTitle;
    if (!key) continue;
    const g = groups.get(key);
    if (g) {
      g.entries.push(entry);
      if ((entry.updatedAt || 0) > (g.last.updatedAt || 0)) g.last = entry;
    } else {
      groups.set(key, { entries: [entry], last: entry });
    }
  }
  const out: AnimeHistoryGroup[] = [];
  for (const [key, g] of groups) {
    const epKeys = new Set<string>();
    const watchedKeys = new Set<string>();
    let image = "";
    let animeHref = "";
    for (const e of g.entries) {
      const n = deriveEpNum(e);
      const ek = n != null ? `n${n}` : normHref(e.episodeHref);
      if (ek) epKeys.add(ek);
      if (ek && isCompleted(e)) watchedKeys.add(ek);
      if (!image && e.image) image = e.image;
      if (!animeHref && e.animeHref?.includes("/anime/")) animeHref = e.animeHref;
    }
    if (!animeHref) animeHref = g.entries.find((e) => e.animeHref)?.animeHref || "";
    out.push({
      key,
      animeTitle: g.last.animeTitle || g.entries.find((e) => e.animeTitle)?.animeTitle || "",
      animeHref,
      image,
      last: g.last,
      updatedAt: g.last.updatedAt || 0,
      episodes: epKeys.size,
      watched: watchedKeys.size,
      lastEpNum: deriveEpNum(g.last),
    });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getHistoryByAnime(): Promise<AnimeHistoryGroup[]> {
  return groupHistoryByAnime(await getHistory());
}

/**
 * Completed-episode index for the detail page. Carries BOTH per-href matches
 * (same source) and per-anime (normalized title) completed episode numbers,
 * which bridges sources: watching episode 5 of "Naruto" on witanime marks it
 * watched when the same anime is opened from anime4up/anime3rb too.
 */
export interface CompletedSets {
  hrefs: Set<string>;
  numbersByTitle: Map<string, Set<number>>;
  /** Episode numbers per title for EVERY history entry (watched or not) — tells
   *  "explicitly unwatched" apart from "aged out of the capped history". */
  knownNumbersByTitle: Map<string, Set<number>>;
  /** Normalized hrefs of every history entry (watched or not). */
  knownHrefs: Set<string>;
}

export async function getCompletedSets(): Promise<CompletedSets> {
  const list = await getHistory();
  const hrefs = new Set<string>();
  const numbersByTitle = new Map<string, Set<number>>();
  const knownNumbersByTitle = new Map<string, Set<number>>();
  const knownHrefs = new Set<string>();
  for (const e of list) {
    knownHrefs.add(normHref(e.episodeHref));
    const n = deriveEpNum(e);
    const tk = animeTitleKey(e.animeTitle);
    if (tk && n != null) {
      let known = knownNumbersByTitle.get(tk);
      if (!known) { known = new Set(); knownNumbersByTitle.set(tk, known); }
      known.add(n);
    }
    if (!isCompleted(e)) continue;
    hrefs.add(normHref(e.episodeHref));
    if (n != null && tk) {
      let set = numbersByTitle.get(tk);
      if (!set) { set = new Set<number>(); numbersByTitle.set(tk, set); }
      set.add(n);
    }
  }
  return { hrefs, numbersByTitle, knownNumbersByTitle, knownHrefs };
}

/** True if history has ANY entry (watched or not) for this episode. False
 *  means the capped local history simply does not know it — an old finale
 *  aged out and must not read as unwatched. */
export function isEpisodeTracked(
  sets: CompletedSets,
  opts: { hrefs: (string | null | undefined)[]; epNum?: number | null; animeTitle?: string | null },
): boolean {
  if (opts.hrefs.some((h) => h && sets.knownHrefs.has(normHref(h)))) return true;
  return opts.epNum != null && !!opts.animeTitle &&
    !!sets.knownNumbersByTitle.get(animeTitleKey(opts.animeTitle))?.has(opts.epNum);
}

/** True if an episode is watched by EITHER a same-source href match OR a
 *  cross-source (anime title + episode number) match. */
export function isEpisodeWatched(
  sets: CompletedSets,
  opts: { hrefs: (string | null | undefined)[]; epNum?: number | null; animeTitle?: string | null },
): boolean {
  if (opts.hrefs.some((h) => h && sets.hrefs.has(normHref(h)))) return true;
  if (opts.epNum != null && opts.animeTitle) {
    const set = sets.numbersByTitle.get(animeTitleKey(opts.animeTitle));
    if (set && set.has(opts.epNum)) return true;
  }
  return false;
}

export async function toggleWatched(
  episodeHref: string,
  meta: { episodeTitle: string; animeTitle: string; animeHref: string; image?: string; url4up?: string; epNum?: number | null },
): Promise<boolean> {
  const list = await getHistory();
  const idx = list.findIndex((e) => e.episodeHref === episodeHref);
  if (idx >= 0) {
    const cur = list[idx];
    const next: WatchEntry = {
      ...cur,
      completed: !isCompleted(cur),
      epNum: cur.epNum ?? (meta.epNum ?? undefined),
      updatedAt: Date.now(),
    };
    list[idx] = next;
    await writeHistory(list);
    pushToCloud(next).catch(() => {});
    return next.completed === true;
  }
  const newEntry: WatchEntry = {
    episodeHref,
    episodeTitle: meta.episodeTitle,
    animeTitle: meta.animeTitle,
    animeHref: meta.animeHref,
    image: meta.image || "",
    positionMs: 0,
    durationMs: 0,
    url4up: meta.url4up,
    epNum: meta.epNum ?? undefined,
    completed: true,
    updatedAt: Date.now(),
  };
  list.unshift(newEntry);
  if (list.length > MAX_ITEMS) list.length = MAX_ITEMS;
  await writeHistory(list);
  pushToCloud(newEntry).catch(() => {});
  return true;
}

/** Drop this device's watch history (account switch / sign-out). */
export async function resetLocalHistory(): Promise<void> {
  await storage.removeItem(KEY).catch(() => {});
  await storage.removeItem(DISMISSED_KEY).catch(() => {});
  for (const cb of historyListeners) {
    try { cb(); } catch {}
  }
}
