// Persistent app-usage tracking — last time each user opened the app and how
// much time they've spent inside it. Powers the admin "all users" screen.
// Complements lib/presence.ts, which only knows who's online *right now*
// (ephemeral); this module accumulates durable totals in Supabase.
//
// How time is counted: a "session" begins when the window is foregrounded and
// ends when it's hidden/blurred. While foregrounded we accrue wall-clock
// seconds and flush them to the `usage_stats` table — on a 5min heartbeat (so
// a hard-kill loses at most five minutes) and again on background. All writes
// go through the record_usage() RPC, which can only ever touch the caller's
// own row.
//
// ponytail: was 60s on mobile, which alone was ~500 API-log lines/day; 5min is
// plenty for an admin usage screen.

import type { User } from "@supabase/supabase-js";
import { supabase, isSupabaseConfigured } from "./supabase";
import { APP_VERSION } from "./appVersion";
import {
  mapAdminHistoryRow,
  mergeWatchSummaries,
  type AdminHistoryRow,
  type AdminWatchEntry,
  type WatchSummaryRow,
} from "./adminHistory";

const FLUSH_INTERVAL_MS = 300_000;

let sessionUser: User | null = null;
// Timestamp (ms) from which unflushed foreground seconds have been accruing.
// null = no foreground session currently accruing.
let accrualStart: number | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let lifecycleAttached = false;

function metaOf(user: User): { email: string; name: string; avatar: string | null } {
  const meta = user.user_metadata ?? {};
  const name =
    meta.full_name || meta.name || (user.email ? user.email.split("@")[0] : "User");
  const avatar = meta.avatar_url || meta.picture || null;
  return { email: user.email ?? "", name, avatar };
}

/** Today's date in the device's LOCAL timezone as "YYYY-MM-DD". */
function localDay(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

async function call(seconds: number, newSession: boolean): Promise<void> {
  if (!isSupabaseConfigured || !sessionUser) return;
  const { email, name, avatar } = metaOf(sessionUser);
  try {
    await supabase.rpc("record_usage", {
      p_seconds: seconds,
      p_email: email,
      p_name: name,
      p_avatar: avatar,
      p_new_session: newSession,
      p_local_day: localDay(),
      p_version: APP_VERSION,
    });
  } catch {
    // Network/auth hiccups are non-fatal — usage stats are best-effort.
  }
}

/** Push the seconds accrued since the last flush, then reset the accrual point. */
export async function flushUsage(): Promise<void> {
  const start = accrualStart;
  if (start == null) return;
  const now = Date.now();
  accrualStart = now;
  const elapsed = Math.floor((now - start) / 1000);
  if (elapsed > 0) await call(elapsed, false);
}

/** Foreground = window visible AND focused (RN AppState "active" equivalent). */
function isForeground(): boolean {
  if (typeof document === "undefined") return true;
  return !document.hidden && document.hasFocus();
}

/** Start accruing again after a background pause and mark a new session. */
async function resumeSession(): Promise<void> {
  if (!sessionUser || accrualStart != null) return;
  accrualStart = Date.now();
  if (!flushTimer) {
    flushTimer = setInterval(() => {
      void flushUsage();
    }, FLUSH_INTERVAL_MS);
  }
  await call(0, true);
}

/** Flush accrued seconds and stop the heartbeat; the session stays resumable. */
async function pauseSession(): Promise<void> {
  const start = accrualStart;
  if (start == null) return;
  accrualStart = null;
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  const elapsed = Math.floor((Date.now() - start) / 1000);
  if (elapsed > 0) await call(elapsed, false);
}

function onLifecycle(): void {
  if (!sessionUser) return;
  if (isForeground()) void resumeSession();
  else void pauseSession();
}

function attachLifecycle(): void {
  if (lifecycleAttached || typeof document === "undefined") return;
  document.addEventListener("visibilitychange", onLifecycle);
  window.addEventListener("focus", onLifecycle);
  window.addEventListener("blur", onLifecycle);
  lifecycleAttached = true;
}

function detachLifecycle(): void {
  if (!lifecycleAttached || typeof document === "undefined") return;
  document.removeEventListener("visibilitychange", onLifecycle);
  window.removeEventListener("focus", onLifecycle);
  window.removeEventListener("blur", onLifecycle);
  lifecycleAttached = false;
}

/**
 * Begin (or resume) counting usage for this user. Idempotent while a session is
 * already running for the same user — repeated foreground events won't double
 * the session counter. Marks a new session + refreshes last_seen on a fresh
 * foreground start.
 */
export async function startUsageSession(user: User): Promise<void> {
  if (sessionUser && sessionUser.id === user.id) {
    if (isForeground() && accrualStart == null) await resumeSession();
    return;
  }
  await endUsageSession();
  sessionUser = user;
  attachLifecycle();
  if (isForeground()) await resumeSession();
}

/** End the current session: flush any pending seconds and stop the heartbeat. */
export async function endUsageSession(): Promise<void> {
  await flushUsage();
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  accrualStart = null;
  sessionUser = null;
  detachLifecycle();
}

export interface UsageRow {
  userId: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  /** Cumulative seconds spent in the app, across all sessions. */
  totalSeconds: number;
  /** Number of foreground sessions. */
  sessions: number;
  /** ISO time the user was first tracked (null = never opened the new build). */
  firstSeenAt: string | null;
  /** ISO time the app was last opened (falls back to last sign-in / sign-up). */
  lastSeenAt: string;
  /** ISO time the account was created. */
  createdAt: string | null;
  /** Installed app version, or null if not yet reported. */
  version: string | null;
  /** Distinct episode history rows synchronized by this user. */
  episodesStarted: number;
  /** Episodes completed automatically or marked watched manually. */
  episodesCompleted: number;
}

/**
 * Admin-only: fetch EVERY registered user (from auth.users), most-recently-
 * active first, with their usage stats (zeroed for users who haven't opened the
 * new build yet). Goes through the admin_list_users() RPC, which enforces
 * the admin email — non-admin callers get an exception, surfaced here as [].
 */
export async function fetchAllUsage(): Promise<UsageRow[]> {
  if (!isSupabaseConfigured) return [];
  try {
    const [{ data, error }, summary] = await Promise.all([
      supabase.rpc("admin_list_users"),
      supabase.rpc("admin_watch_summary"),
    ]);
    if (error || !data) return [];
    const users = (data as any[]).map((r) => ({
      userId: r.user_id,
      email: r.email ?? "",
      name: r.name ?? "",
      avatarUrl: r.avatar_url ?? null,
      totalSeconds: Number(r.total_seconds) || 0,
      sessions: Number(r.sessions) || 0,
      firstSeenAt: r.first_seen_at ?? null,
      lastSeenAt: r.last_seen_at,
      createdAt: r.created_at ?? null,
      version: r.version ?? null,
    }));
    return mergeWatchSummaries(
      users,
      summary.error ? [] : ((summary.data as WatchSummaryRow[] | null) ?? []),
    );
  } catch {
    return [];
  }
}

export interface DailyRow {
  /** Local calendar day, "YYYY-MM-DD". */
  day: string;
  /** Seconds spent in the app that day. */
  seconds: number;
  /** Number of times the app was opened (foreground sessions) that day. */
  opens: number;
}

/**
 * Admin-only: a single user's day-by-day usage, newest day first. Enforced by
 * the admin email inside admin_user_daily(); non-admin callers get [].
 */
export async function fetchUserDaily(userId: string): Promise<DailyRow[]> {
  if (!isSupabaseConfigured) return [];
  try {
    const { data, error } = await supabase.rpc("admin_user_daily", { p_user_id: userId });
    if (error || !data) return [];
    return (data as any[]).map((r) => ({
      day: r.day,
      seconds: Number(r.seconds) || 0,
      opens: Number(r.opens) || 0,
    }));
  } catch {
    return [];
  }
}

export type AdminHistoryResult =
  | { ok: true; entries: AdminWatchEntry[] }
  | { ok: false; entries: []; error: string };

/** Admin-only: complete synchronized episode history for one selected user. */
export async function fetchUserWatchHistory(userId: string): Promise<AdminHistoryResult> {
  if (!isSupabaseConfigured) return { ok: false, entries: [], error: "not_configured" };
  try {
    const { data, error } = await supabase.rpc("admin_user_watch_history", { p_user_id: userId });
    if (error || !data) return { ok: false, entries: [], error: error?.message ?? "failed" };
    return { ok: true, entries: (data as AdminHistoryRow[]).map(mapAdminHistoryRow) };
  } catch (e) {
    return { ok: false, entries: [], error: e instanceof Error ? e.message : "failed" };
  }
}

export type { AdminWatchEntry } from "./adminHistory";
