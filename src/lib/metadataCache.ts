// Crowdsourced read-through metadata cache (Supabase).
// Ported from mobile lib/metadataCache.ts.
//
// The app is a "scout": every device scrapes on its residential IP (which
// bypasses Cloudflare — a datacenter/serverless IP cannot), and on a cache miss
// it uploads the structured result here so the NEXT user of any device renders
// the detail page instantly without paying for a live scrape.
//
// This holds ONLY public anime metadata (title / poster / synopsis / genres /
// episode list with page hrefs). It NEVER holds video stream URLs (.mp4/.m3u8):
// those carry short-lived tokens, expire, and are always resolved live on the
// client at the moment Play is tapped (see resolveVideo in lib/api.ts).
//
// All calls are best-effort and fully swallow errors — the cloud cache is a
// speed-up, never a dependency. RLS requires an authenticated session (mirrors
// episode_queue), so every call is guarded by a cheap session check.

import { supabase, isSupabaseConfigured } from "./supabase";
import { createMetadataWriteGate } from "./metadataWriteGate";

const TABLE = "anime_metadata_cache";
const allowMetadataWrite = createMetadataWriteGate(10, 60_000, 6 * 60 * 60 * 1000);

// A cloud hit older than this is still served instantly, but triggers a
// background re-scrape that upserts the entry. This bounds how long an ongoing
// anime's new episodes can be missing from the shared cache without forcing a
// live scrape on every single open.
export const CLOUD_REVALIDATE_MS = 6 * 60 * 60 * 1000; // 6h

// RLS is scoped to the `authenticated` role, so an anon call just errors. The
// app gates the whole UI behind AuthGate, so this is virtually always true —
// the check only keeps the very first pre-auth frames from emitting failures.
async function hasSession(): Promise<boolean> {
  if (!isSupabaseConfigured) return false;
  try {
    const { data } = await supabase.auth.getSession();
    return !!data.session;
  } catch {
    return false;
  }
}

export type CloudMeta<T> = {
  /** The cached payload exactly as a scout uploaded it. */
  payload: T;
  /** Epoch ms when the scout last scraped this entry. */
  scrapedAt: number;
  /** True when the entry is older than CLOUD_REVALIDATE_MS (re-scrape in bg). */
  stale: boolean;
  /** True when >=3 distinct devices agreed on this exact payload. */
  verified: boolean;
  /** Distinct-voter count backing this payload. */
  votes: number;
};

// Read-through: look up an anime's consensus metadata by its source URL (the same
// key lib/api.ts uses for the on-device detail cache). Multiple competing payloads
// can exist per anime, so prefer a community-VERIFIED row (>=3 distinct voters);
// failing that, the row with the most votes; ties broken by freshness. Returns
// null on a miss, no session, or any error so the caller falls through to a live
// scrape.
export async function readCloudMetadata<T = unknown>(
  animeUrl: string,
): Promise<CloudMeta<T> | null> {
  if (!animeUrl || !(await hasSession())) return null;
  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select("payload, scraped_at, is_verified, verification_count")
      .eq("anime_url", animeUrl)
      .order("is_verified", { ascending: false })
      .order("verification_count", { ascending: false })
      .order("scraped_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data?.payload) return null;
    const scrapedAt = new Date(data.scraped_at).getTime();
    return {
      payload: data.payload as T,
      scrapedAt,
      stale: Date.now() - scrapedAt > CLOUD_REVALIDATE_MS,
      verified: !!data.is_verified,
      votes: data.verification_count ?? 1,
    };
  } catch {
    return null;
  }
}

// Scout upload (fire-and-forget) via the consensus RPC. The server hashes the
// payload, records this device's vote, and upserts the matching row — so a payload
// that 3+ devices independently produce becomes community-verified. Callers should
// only pass payloads with real content (a non-empty episode list) so a transient
// empty scrape never poisons the cache (the server also rejects empty ones).
// `episodeCount` is accepted for call-site compatibility but recomputed server-side
// from the payload. Never throws: a failed upload just means the next device scouts.
export async function writeCloudMetadata(
  animeUrl: string,
  payload: unknown,
  _episodeCount = 0,
  title: string | null = null,
): Promise<void> {
  if (!animeUrl || !(await hasSession())) return;
  if (!allowMetadataWrite(animeUrl)) return;
  try {
    const { error } = await supabase.rpc("submit_anime_metadata", {
      p_anime_url: animeUrl,
      p_payload: payload,
      p_title: title,
    });
    // A rejection here is EXPECTED and harmless. The server enforces a per-user
    // write rate limit (a plpgsql trigger) and strict payload CHECK constraints,
    // so a throttled or malformed upload comes back as `error` (not a thrown
    // exception) and we simply drop it — the scout moves on. The cloud cache is
    // an optional speed-up layer; a failed upload never affects the local UI or
    // playback. Surface it only in development.
    if (error && import.meta.env.DEV) {
      console.debug("[metadataCache] upload dropped:", error.message);
    }
  } catch (e) {
    // Network/transport-level failure — equally non-fatal; swallow it.
    if (import.meta.env.DEV) console.debug("[metadataCache] upload threw:", e);
  }
}
