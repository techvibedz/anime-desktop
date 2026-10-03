// New-episode notifications (in-app center + OS notification while the app runs).
//
// Ported from the mobile app (lib/notifications.ts). Every time a sync runs we
// diff the "recently updated" episodes feed against either ALL anime or just the
// user's saved list (controlled by the notification-scope setting) and record a
// notification whenever a new episode drops. The bell surfaces an unread badge
// and the /notifications screen lists them.
//
// Mobile delegates the OS banner to the server (Expo Push). Desktop has no
// server push, so the newest created item also fires a local OS notification via
// window.pantoufa.notify (guarded — the IPC is added in parallel).
//
// Flood guard: the seen-episode set is seeded silently on the first sync and
// whenever the scope changes, so switching to "all" (or first launch) never
// dumps the entire current backlog on the user — only episodes that appear
// AFTER that point notify.

import { fetchRecent } from "./api";
import { reconcileCompletionFromEpisodes } from "./completion";
import { getFavorites, toAnimeUrl, type FavoriteAnime } from "./favorites";
import { normAnimeKey } from "./history";
import { getNotificationScope, getNotificationsEnabled, getDailyAnimeNotif } from "./settings";
import { supabase, isSupabaseConfigured } from "./supabase";
import { storage } from "./storage";
import { shouldRunEpisodeNotifier } from "./notificationQueue";
import { localDayKey, orderDailyPool, pickOfTheDay } from "./dailyPick";
import { fetchSeasonAnime, currentSeason } from "./seasons";
import { t } from "./i18n";

const LIST_KEY = "@notifications_v1";
// v3: dedup keys switched to the TLD-normalized anime key (see normAnimeKey).
const SEEN_KEYS_KEY = "@notif_seen_keys_v3"; // { scope, keys: string[] } — dedup of notified episodes
const QUEUE_SEEN_KEY = "@queue_seen_v2"; // scope-independent keys already reported to the server
const DAILY_DAY_KEY = "@daily_notif_day"; // last local day the daily reminder was shown
const MAX_STORED = 60;
const MAX_SEEN_KEYS = 1000; // cap the dedup set (recent feed ages old keys out anyway)

// The feed is shared/global and the server cron is the backstop, so one report
// per device per window is plenty.
const REPORT_THROTTLE_MS = 10 * 60 * 1000; // 10 min
let lastReportAt = 0;

// Throttle the feed re-scrape so frequent sync triggers don't hammer it;
// `force` bypasses it for the initial mount.
const SYNC_THROTTLE_MS = 5 * 60 * 1000; // 5 min
let lastSyncAt = 0;

const SYNC_INTERVAL_MS = 5 * 60 * 1000; // background sync cadence while the app runs

export interface AppNotification {
  /** Stable id: `${animeKey}#${episodeNumber}` so the same episode never duplicates. */
  id: string;
  animeTitle: string;
  animeHref: string;
  episodeTitle: string;
  episodeHref: string;
  episodeNumber: number | null;
  image: string;
  createdAt: number;
  read: boolean;
}

/* ── Episode number parsing (Arabic + Western numerals) ── */

function extractEpisodeNumber(title: string): number | null {
  if (!title) return null;
  // Arabic-indic numerals after الحلقة
  const arMatch = title.match(/الحلقة[\s\-_]*([٠-٩]+)/);
  if (arMatch) {
    let num = "";
    for (const ch of arMatch[1]) num += String(ch.codePointAt(0)! - 0x0660);
    return parseInt(num, 10) || null;
  }
  const enMatch =
    title.match(/(?:الحلقة|حلقة)\s*(\d+)/) ||
    title.match(/(?:Episode|E(?:p(?:isode)?)?[.\s]*)\s*(\d+)/i);
  if (enMatch) return parseInt(enMatch[1], 10) || null;
  return null;
}

/* ── Title normalization for fuzzy favorite ↔ episode matching ── */

function norm(s: string): string {
  return (s || "")
    .toLowerCase()
    // keep latin letters/digits and Arabic block, drop everything else
    .replace(/[^a-z0-9؀-ۿ\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* ── Storage helpers ── */

async function readList(): Promise<AppNotification[]> {
  try {
    const raw = await storage.getItem(LIST_KEY);
    return raw ? (JSON.parse(raw) as AppNotification[]) : [];
  } catch {
    return [];
  }
}

// Lightweight change notifier so the bell / notifications page re-reads after
// a sync or a mark/clear action.
const listeners = new Set<() => void>();
export function subscribeNotifications(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function emitChanged() {
  for (const l of listeners) {
    try { l(); } catch {}
  }
}

async function writeList(list: AppNotification[]) {
  try {
    await storage.setItem(LIST_KEY, JSON.stringify(list.slice(0, MAX_STORED)));
  } catch {}
  emitChanged();
}

interface SeenState {
  scope: string | null; // which scope the set was last seeded under
  keys: Set<string>;
}

async function readSeenKeys(): Promise<SeenState> {
  try {
    const raw = await storage.getItem(SEEN_KEYS_KEY);
    if (!raw) return { scope: null, keys: new Set() };
    const parsed = JSON.parse(raw) as { scope: string | null; keys: string[] };
    return { scope: parsed.scope ?? null, keys: new Set(parsed.keys || []) };
  } catch {
    return { scope: null, keys: new Set() };
  }
}

async function writeSeenKeys(scope: string, keys: Set<string>) {
  try {
    // Keep only the most-recently-added keys (Set preserves insertion order).
    const arr = [...keys];
    const trimmed = arr.length > MAX_SEEN_KEYS ? arr.slice(arr.length - MAX_SEEN_KEYS) : arr;
    await storage.setItem(SEEN_KEYS_KEY, JSON.stringify({ scope, keys: trimmed }));
  } catch {}
}

/* ── Public API ── */

export async function getNotifications(): Promise<AppNotification[]> {
  const list = await readList();
  return list.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getUnreadCount(): Promise<number> {
  const list = await readList();
  return list.filter((n) => !n.read).length;
}

export async function markAllRead() {
  const list = await readList();
  if (list.every((n) => n.read)) return;
  await writeList(list.map((n) => ({ ...n, read: true })));
}

export async function markRead(id: string) {
  const list = await readList();
  const next = list.map((n) => (n.id === id ? { ...n, read: true } : n));
  await writeList(next);
}

export async function clearNotifications() {
  await writeList([]);
}

type RawEpisode = { title: string; href: string; image: string; animeTitle: string; animeHref: string };

/** Resolve a stable per-anime key for an episode (anime URL, else normalized title). */
function animeKeyFor(ep: RawEpisode): string {
  const url = ep.animeHref?.includes("/anime/") ? ep.animeHref : toAnimeUrl(ep.animeHref || ep.href);
  return normAnimeKey(url || norm(ep.animeTitle) || ep.href);
}

/** Resolve the /anime/ URL for an episode (best effort). */
function animeUrlFor(ep: RawEpisode): string {
  return ep.animeHref?.includes("/anime/")
    ? ep.animeHref
    : (toAnimeUrl(ep.animeHref || ep.href) || ep.animeHref || "");
}

/** Pull the latest feed batch (newest first). */
async function fetchRecentFeed(): Promise<RawEpisode[]> {
  try {
    const result = await fetchRecent(1);
    return result.success ? result.data.episodes : [];
  } catch { return []; }
}

/** Fire the local OS notification for the newest created episode (best effort). */
async function notifyOs(newest: AppNotification) {
  try {
    if (!(await getNotificationsEnabled())) return;
    const title = t.notifNewEpisodeTitle;
    const body = newest.episodeNumber != null
      ? t.notifNewEpisode(newest.animeTitle, newest.episodeNumber)
      : t.notifNewEpisodeNoNum(newest.animeTitle);
    void window.pantoufa?.notify?.({
      title,
      body,
      data: { href: newest.episodeHref, episode: newest.episodeNumber },
    })?.catch(() => {});
  } catch {}
}

/**
 * Diff the latest "recently updated" episodes against either all anime or the
 * user's saved list (per the notification-scope setting) and append a
 * notification for each genuinely new episode.
 *
 * The seen-episode set is seeded silently on first run and on any scope change,
 * so the current backlog never floods the user — only episodes appearing after
 * that point notify.
 *
 * Returns the number of NEW notifications created (0 on any failure).
 */
export async function syncEpisodeNotifications(opts?: { force?: boolean }): Promise<number> {
  try {
    if (!opts?.force && Date.now() - lastSyncAt < SYNC_THROTTLE_MS) return 0;
    lastSyncAt = Date.now();
    const scope = await getNotificationScope();

    // Fetched before the scope handling so the completion reconcile below ALWAYS
    // runs — it's scope-independent and must update badges even when
    // notifications are mylist-scoped with an empty list.
    const episodes = await fetchRecentFeed();
    if (episodes.length === 0) return 0;

    // Clear stale "caught up"/"finished" badges the instant a new episode drops.
    reconcileCompletionFromEpisodes(
      episodes.map((ep) => ({
        animeHref: animeUrlFor(ep),
        animeTitle: ep.animeTitle,
        epNum: extractEpisodeNumber(ep.title),
      })),
    ).catch(() => {});

    // When scoped to the user's list, build favorite indexes up front; bail if
    // the list is empty (nothing to match against).
    let byTitle: Map<string, FavoriteAnime> | null = null;
    let byHref: Map<string, FavoriteAnime> | null = null;
    if (scope === "mylist") {
      const favorites = await getFavorites();
      if (favorites.length === 0) return 0;
      byTitle = new Map();
      byHref = new Map();
      for (const f of favorites) {
        const nt = norm(f.title);
        if (nt) byTitle.set(nt, f);
        byHref.set(f.href, f);
      }
    }

    // Build the candidate set for this scope, deduped by `${animeKey}#${epNum}`.
    const candidates = new Map<string, AppNotification>();
    for (const ep of episodes) {
      const epNum = extractEpisodeNumber(ep.title);
      if (epNum == null) continue;

      let animeTitle = ep.animeTitle;
      let animeHref = ep.animeHref?.includes("/anime/") ? ep.animeHref : (toAnimeUrl(ep.animeHref || ep.href) || ep.animeHref || "");
      let image = ep.image || "";

      if (scope === "mylist") {
        const epAnimeUrl = ep.animeHref?.includes("/anime/") ? ep.animeHref : toAnimeUrl(ep.animeHref || ep.href);
        const fav = (epAnimeUrl && byHref!.get(epAnimeUrl)) || byTitle!.get(norm(ep.animeTitle));
        if (!fav) continue; // not in the user's list → skip
        animeTitle = fav.title;
        animeHref = fav.href;
        image = ep.image || fav.image || "";
      }

      const key = `${animeKeyFor(ep)}#${epNum}`;
      if (candidates.has(key)) continue;
      candidates.set(key, {
        id: key,
        animeTitle,
        animeHref,
        episodeTitle: ep.title,
        episodeHref: ep.href,
        episodeNumber: epNum,
        image,
        createdAt: Date.now(),
        read: false,
      });
    }
    if (candidates.size === 0) return 0;

    const state = await readSeenKeys();

    // First run, or the scope changed since last sync → seed silently.
    if (state.scope !== scope) {
      const merged = new Set(state.keys);
      for (const k of candidates.keys()) merged.add(k);
      await writeSeenKeys(scope, merged);
      return 0;
    }

    const list = await readList();
    const existingIds = new Set(list.map((n) => n.id));
    const seenSet = state.keys;
    const created: AppNotification[] = [];

    for (const [key, notif] of candidates) {
      if (seenSet.has(key)) continue;
      seenSet.add(key);
      if (existingIds.has(key)) continue;
      existingIds.add(key);
      created.push(notif);
    }

    await writeSeenKeys(scope, seenSet);

    if (created.length > 0) {
      // Candidates are built feed-order (newest published first); one OS banner
      // for the newest only, so an away-return backlog can't spam multiple.
      void notifyOs(created[0]);
      // Newest first in the stored list.
      created.sort((a, b) => (b.episodeNumber ?? 0) - (a.episodeNumber ?? 0));
      await writeList([...created, ...list]);
    }
    return created.length;
  } catch {
    return 0;
  }
}

/* ── Server report: newly-available episodes → closed-app push for mobile ── */

async function readQueueSeen(): Promise<Set<string>> {
  try {
    const raw = await storage.getItem(QUEUE_SEEN_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as { keys: string[] };
    return new Set(parsed.keys || []);
  } catch {
    return new Set();
  }
}

async function writeQueueSeen(keys: Set<string>) {
  try {
    const arr = [...keys];
    const trimmed = arr.length > MAX_SEEN_KEYS ? arr.slice(arr.length - MAX_SEEN_KEYS) : arr;
    await storage.setItem(QUEUE_SEEN_KEY, JSON.stringify({ keys: trimmed }));
  } catch {}
}

interface QueueRow {
  episode_key: string;
  anime_key: string;
  anime_title: string;
  anime_href: string;
  episode_title: string;
  episode_href: string;
  episode_number: number;
  image: string;
}

/**
 * Report newly-available episodes to the shared server queue so the
 * episode-notifier Edge Function can fan them out to mobile devices. Desktop
 * doesn't receive push, but a signed-in desktop user still keeps the shared
 * feed warm for everyone. Idempotent; seeded silently on first run.
 *
 * Returns the number of NEW episodes uploaded (0 on any failure / no-op).
 */
export async function reportRecentEpisodes(opts?: { force?: boolean }): Promise<number> {
  try {
    if (!isSupabaseConfigured) return 0;
    if (!opts?.force && Date.now() - lastReportAt < REPORT_THROTTLE_MS) return 0;
    // Mark immediately (optimistic) so two near-simultaneous triggers don't both scrape.
    lastReportAt = Date.now();
    // Only signed-in users can write the shared feed (RLS); skip otherwise.
    const { data: auth } = await supabase.auth.getSession();
    // Signed out → don't burn the throttle; let the next attempt try again.
    if (!auth?.session?.user?.id) { lastReportAt = 0; return 0; }

    const episodes = await fetchRecentFeed();
    if (episodes.length === 0) return 0;

    // All candidates (no scope filter), deduped by `${animeKey}#${epNum}`.
    const candidates = new Map<string, QueueRow>();
    for (const ep of episodes) {
      const epNum = extractEpisodeNumber(ep.title);
      if (epNum == null) continue;
      const animeKey = animeKeyFor(ep);
      const key = `${animeKey}#${epNum}`;
      if (candidates.has(key)) continue;
      candidates.set(key, {
        episode_key: key,
        anime_key: animeKey,
        anime_title: ep.animeTitle || "",
        anime_href: animeUrlFor(ep),
        episode_title: ep.title || "",
        episode_href: ep.href || "",
        episode_number: epNum,
        image: ep.image || "",
      });
    }
    if (candidates.size === 0) return 0;

    const seen = await readQueueSeen();
    const firstRun = seen.size === 0;

    // Collect genuinely-new episodes; on the first run record the whole backlog
    // into `seen` so we never flood.
    const fresh: QueueRow[] = [];
    for (const [key, row] of candidates) {
      if (seen.has(key)) continue;
      seen.add(key);
      if (!firstRun) fresh.push(row);
    }

    // Eager population: always include the single newest episode so a
    // freshly-seeded device still keeps the shared queue warm. The queue PK and
    // the server's per-user dedup make this idempotent.
    const newest = candidates.values().next().value as QueueRow | undefined;
    if (newest && !fresh.some((r) => r.episode_key === newest.episode_key)) {
      fresh.unshift(newest);
    }

    if (fresh.length === 0) return 0;

    // Idempotent upload (ON CONFLICT DO NOTHING keeps the first-seen row/time).
    const { data: inserted, error } = await supabase
      .from("episode_queue")
      .upsert(fresh, { onConflict: "episode_key", ignoreDuplicates: true })
      .select("episode_key");
    // On failure, don't persist the seen-set so we retry these next time.
    if (error) return 0;

    await writeQueueSeen(seen);
    const rows = (inserted ?? []) as unknown[];
    if (!shouldRunEpisodeNotifier(rows)) return 0;

    // Nudge the notifier for near-instant delivery (the cron is the backstop).
    try {
      await supabase.functions.invoke("episode-notifier", { body: {} });
    } catch {}
    return rows.length;
  } catch {
    return 0;
  }
}

/* ── Daily "أنمي اليوم" reminder ─────────────────────────────────────────── */

/**
 * Desktop counterpart of the mobile 7-day @20:00 schedule: during each sync,
 * once local time passes 20:00 and the reminder wasn't shown today, pick the
 * same daily anime as the home card and fire one local notification. Best
 * effort; the day key is persisted before notifying so a failure doesn't retry
 * all evening.
 */
export async function maybeDailyAnimeReminder(): Promise<void> {
  try {
    if (!(await getDailyAnimeNotif())) return;
    if (!(await getNotificationsEnabled())) return;
    const now = new Date();
    if (now.getHours() < 20) return;
    const today = localDayKey(now);
    if ((await storage.getItem(DAILY_DAY_KEY)) === today) return;

    const { season, year } = currentSeason(now);
    const list = orderDailyPool(await fetchSeasonAnime(season, year));
    const pick = pickOfTheDay(list, today);
    if (!pick) return;

    await storage.setItem(DAILY_DAY_KEY, today);
    void window.pantoufa?.notify?.({
      title: t.dailyNotifTitle,
      body: t.dailyNotifBody(pick.title),
      data: { href: pick.sourceHref ?? "", episode: null },
    })?.catch(() => {});
  } catch {}
}

/* ── Background sync lifecycle ──────────────────────────────────────────── */

let syncTimer: ReturnType<typeof setInterval> | null = null;
let syncUserId: string | undefined;

/**
 * Start periodic episode sync/report + daily reminder. Call on app start.
 * Restarts when the effective user changes. A `force` pass runs immediately.
 */
export function startNotificationSync(userId?: string): void {
  if (syncTimer && syncUserId === userId) return;
  stopNotificationSync();
  syncUserId = userId;
  void syncEpisodeNotifications({ force: true });
  void reportRecentEpisodes({ force: true });
  void maybeDailyAnimeReminder();
  syncTimer = setInterval(() => {
    void syncEpisodeNotifications();
    void reportRecentEpisodes();
    void maybeDailyAnimeReminder();
  }, SYNC_INTERVAL_MS);
}

export function stopNotificationSync(): void {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
  syncUserId = undefined;
}
