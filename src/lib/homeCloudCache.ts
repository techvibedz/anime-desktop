// Crowdsourced home-feed cache (Supabase) — the LAST-RESORT fallback for the
// home screen. Ported from mobile lib/homeCloudCache.ts.
//
// Why this exists: a small set of users can't reach ANY scrape source
// (witanime + anime4up + anime3rb) — typically an ISP-level block that DNS-over-
// HTTPS can't beat (IP/SNI filtering). Their devices can still reach Supabase
// (their remote logs arrive), so the working majority acts as scouts: every
// device that successfully scrapes a home feed uploads it here, and a blocked
// device downloads the latest shared payload instead of showing an empty home.
// A scraping SERVER can't do this — the sources reject datacenter IPs (verified:
// public relays get Cloudflare 520/522) — but the crowd's residential IPs can.
//
// The payload is public anime metadata only (titles / hrefs / images) — the
// same data the home screen renders. Writes go through the submit_home_feed
// RPC, which validates the payload shape, restricts item hrefs to the known
// source hosts, and rate-limits each user — a vandal can at worst re-upload a
// valid-looking feed.
//
// All calls are best-effort and fully swallow errors — the cloud cache is a
// fallback, never a dependency. RLS requires an authenticated session (mirrors
// metadataCache), so every call is guarded by a cheap session check.

import { supabase, isSupabaseConfigured } from "./supabase";

const TABLE = "home_feed_cache";
const ROW_ID = "home";

// Serve a shared payload younger than this. The live feed turns over hourly,
// but for a user who otherwise sees NOTHING, day-old content beats an empty
// screen; the local SWR refresh replaces it the moment a live scrape succeeds.
const SERVE_TTL_MS = 24 * 60 * 60 * 1000;

// Client-side upload throttle — the RPC enforces a per-user cooldown too, so
// this just avoids paying for a doomed request on every app launch.
const UPLOAD_THROTTLE_MS = 10 * 60 * 1000;
let _lastUpload = 0;

async function hasSession(): Promise<boolean> {
  if (!isSupabaseConfigured) return false;
  try {
    const { data } = await supabase.auth.getSession();
    return !!data.session;
  } catch {
    return false;
  }
}

// Read the latest shared home payload. Returns null on a miss, a stale row, no
// session, or any error so the caller falls through to the empty state.
export async function readCloudHome<T = unknown>(): Promise<T | null> {
  if (!(await hasSession())) return null;
  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select("payload, updated_at")
      .eq("id", ROW_ID)
      .maybeSingle();
    if (error || !data?.payload) return null;
    if (Date.now() - new Date(data.updated_at).getTime() > SERVE_TTL_MS) return null;
    return data.payload as T;
  } catch {
    return null;
  }
}

// Scout upload (fire-and-forget). Call only with a LIVE-scraped payload that
// has real content — never with a payload that itself came from readCloudHome,
// or a stale feed would echo forever. Never throws.
export async function writeCloudHome(payload: unknown): Promise<void> {
  if (Date.now() - _lastUpload < UPLOAD_THROTTLE_MS) return;
  if (!(await hasSession())) return;
  _lastUpload = Date.now();
  try {
    const { error } = await supabase.rpc("submit_home_feed", { p_payload: payload });
    // A rejection is EXPECTED and harmless (server-side cooldown / validation)
    // — another scout's upload covers the gap. Surface only in development.
    if (error && import.meta.env.DEV) console.debug("[homeCloudCache] upload dropped:", error.message);
  } catch (e) {
    if (import.meta.env.DEV) console.debug("[homeCloudCache] upload threw:", e);
  }
}
