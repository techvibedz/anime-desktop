import { storage } from "./storage";
import { supabase, isSupabaseConfigured } from "./supabase";

const KEY = "watch_history";
const DISMISSED_KEY = "watch_history_dismissed_desktop";
const MAX_ITEMS = 200;

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

export async function pullHistoryFromCloud() {
  if (!isSupabaseConfigured) return;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  const { data, error } = await supabase.from("watch_history")
    .select("*").eq("user_id", user.id)
    .order("updated_at", { ascending: false }).limit(MAX_ITEMS);
  if (error) { console.warn("[history] pull failed:", error.message); return; }
  if (!data) return;
  const local: WatchEntry[] = data.map((row: any) => ({
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
  await storage.setItem(KEY, JSON.stringify(local));
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
  await storage.setItem(KEY, JSON.stringify(list));
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
  // list is already sorted newest-first; keep the first seen per anime.
  const seen = new Set<string>();
  const out: WatchEntry[] = [];
  for (const e of list) {
    const key = e.animeHref || e.animeTitle;
    if (seen.has(key)) continue;
    seen.add(key);
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
  await storage.setItem(KEY, JSON.stringify(list.filter((e) => e.episodeHref !== episodeHref)));
  deleteFromCloud(episodeHref).catch(() => {});
}

export async function dismissFromContinue(episodeHref: string) {
  const dismissed = await getDismissedHrefs();
  dismissed.add(episodeHref);
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
    .join(" ")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
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
      d.match(/\/episode\/[^/]+\/(\d+)/i) ||
      d.match(/\bepisode\s*(\d+)/i);
    return m ? parseInt(m[1], 10) : null;
  };
  return fromStr(e.episodeHref) ?? fromStr(e.episodeTitle);
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
}

export async function getCompletedSets(): Promise<CompletedSets> {
  const list = await getHistory();
  const hrefs = new Set<string>();
  const numbersByTitle = new Map<string, Set<number>>();
  for (const e of list) {
    if (!isCompleted(e)) continue;
    hrefs.add(normHref(e.episodeHref));
    const n = deriveEpNum(e);
    const tk = animeTitleKey(e.animeTitle);
    if (n != null && tk) {
      let set = numbersByTitle.get(tk);
      if (!set) { set = new Set<number>(); numbersByTitle.set(tk, set); }
      set.add(n);
    }
  }
  return { hrefs, numbersByTitle };
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
    await storage.setItem(KEY, JSON.stringify(list));
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
  await storage.setItem(KEY, JSON.stringify(list));
  pushToCloud(newEntry).catch(() => {});
  return true;
}
