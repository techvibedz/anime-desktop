// Remote device logger — ships failure traces to Supabase so the admin can
// diagnose "stuck on loading" / scrape-fail issues WITHOUT the user filing a
// manual report. Write-only: users never see these logs; only the admin reads
// them (via the admin_list_logs RPC, gated by the email allowlist).
//
// PERF: `remoteLog` itself does NO network I/O beyond the one insert. The
// current user id/email is pushed in by the auth provider (setLogUser)
// whenever the session changes, so we never call supabase.auth.getUser()
// per-log. A dedup cooldown also stops a tight retry loop from flooding
// near-identical rows: the same (tag, message) inside 5s is dropped.

import { supabase, isSupabaseConfigured } from "./supabase";
import { APP_VERSION } from "./appVersion";

export type LogLevel = "info" | "warn" | "error";
export type LogTag = "auth" | "home" | "scraper" | "video" | "app";

// Pushed in by the auth provider on session change — keeps the logger off the
// getUser() hot path entirely.
let _userId: string | null = null;
let _email: string | null = null;

/** Called by the auth provider whenever the session changes. Synchronous, free. */
export function setLogUser(user: { id: string; email?: string } | null): void {
  _userId = user?.id ?? null;
  _email = user?.email ?? null;
}

// Dedup: drop the same (tag, message) within this window so a retry loop
// (home retries up to 5×) doesn't insert 5 near-identical rows. 5s is enough
// to collapse a tight retry burst while still letting genuinely separate
// failures (minutes apart) through.
const DEDUP_MS = 5000;
const _recent = new Map<string, number>();

function isDuplicate(tag: LogTag, message: string): boolean {
  const key = tag + "|" + message;
  const now = Date.now();
  const last = _recent.get(key);
  if (last && now - last < DEDUP_MS) return true;
  _recent.set(key, now);
  // Bounded: prune entries older than the window so the map can't grow.
  if (_recent.size > 200) {
    for (const [k, ts] of _recent) if (now - ts > DEDUP_MS) _recent.delete(k);
  }
  return false;
}

/** Log a remote event. Fire-and-forget; never throws, rejects, or awaits.
 *  Safe to call from render paths, catch blocks, and hot loops. */
export function remoteLog(
  level: LogLevel,
  tag: LogTag,
  message: string,
  context?: Record<string, unknown>,
): void {
  if (isDuplicate(tag, message)) return;
  if (!isSupabaseConfigured) return;
  try {
    supabase
      .from("device_logs")
      .insert({
        user_id: _userId,
        email: _email,
        level,
        tag,
        message,
        context: context ?? null,
        app_version: APP_VERSION,
        platform: "win32",
        device: typeof navigator !== "undefined" ? navigator.platform || null : null,
        os_version: typeof navigator !== "undefined" ? navigator.userAgent : null,
      })
      .then(() => {}, () => {});
  } catch {
    // Never let logging break the caller.
  }
}

/** Canonicalize an unknown catch value to a short string for the message. */
export function errText(e: unknown): string {
  if (!e) return "unknown";
  if (e instanceof Error) return e.message;
  return String(e).slice(0, 300);
}

/** One row as returned by the admin_list_logs RPC (newest first). */
export interface AdminLogRow {
  id: string;
  email: string | null;
  level: string;
  tag: string;
  message: string;
  context: Record<string, unknown> | null;
  app_version: string | null;
  platform: string | null;
  device: string | null;
  os_version: string | null;
  created_at: string;
}

/**
 * Admin-only: read recent device logs for the admin logs screen. Enforced by
 * the admin email inside admin_list_logs(); non-admin callers get [].
 */
export async function fetchAdminLogs(
  limit = 200,
  level: LogLevel | null = null,
): Promise<AdminLogRow[]> {
  if (!isSupabaseConfigured) return [];
  try {
    const { data, error } = await supabase.rpc("admin_list_logs", {
      p_limit: limit,
      p_level: level,
    });
    if (error || !data) return [];
    return data as AdminLogRow[];
  } catch {
    return [];
  }
}
