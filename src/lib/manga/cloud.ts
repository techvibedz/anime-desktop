// Mirrors the local manga library + reading progress to Supabase
// (public.manga_activity) so the admin users screen can show what each user
// reads. One-way (device → server): manga state stays local-first, this is a
// read-only reflection. Debounced and diffed so a page-by-page reading session
// costs at most one small upsert every few seconds.

import { supabase, isSupabaseConfigured } from "../supabase";
import { getMangaLibrary, getContinueReading, subscribeMangaStore } from "./store";
import { buildMangaActivityRows, MANGA_ACTIVITY_CAP, type MangaActivityRow } from "./activity";

const PUSH_DELAY_MS = 8000;

let lastPushed = new Map<string, string>(); // manga_key → row fingerprint
let lastUser: string | null = null;

async function push(userId: string): Promise<void> {
  if (!isSupabaseConfigured) return;
  const [library, progress] = await Promise.all([getMangaLibrary(), getContinueReading(MANGA_ACTIVITY_CAP)]);
  const rows = buildMangaActivityRows(userId, library, progress);
  const next = new Map(rows.map((r) => [r.manga_key, JSON.stringify(r)]));
  if (lastUser !== userId) {
    // First push this session: learn what the server already holds so removals
    // made while offline / on another app version are cleaned up too.
    const { data } = await supabase.from("manga_activity").select("manga_key").eq("user_id", userId);
    lastPushed = new Map((data ?? []).map((r: { manga_key: string }) => [r.manga_key, ""]));
    lastUser = userId;
  }
  const changed: MangaActivityRow[] = rows.filter((r) => lastPushed.get(r.manga_key) !== next.get(r.manga_key));
  const removed = [...lastPushed.keys()].filter((k) => !next.has(k));
  if (changed.length) {
    const { error } = await supabase.from("manga_activity").upsert(changed, { onConflict: "user_id,manga_key" });
    if (error) throw error;
  }
  if (removed.length) {
    const { error } = await supabase.from("manga_activity").delete().eq("user_id", userId).in("manga_key", removed);
    if (error) throw error;
  }
  lastPushed = next;
}

/** Start mirroring for the signed-in user; returns the stop function. */
export function startMangaCloudSync(userId: string): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (delay = PUSH_DELAY_MS) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; push(userId).catch(() => {}); }, delay);
  };
  schedule(4000); // initial upload shortly after sign-in / launch
  const unsub = subscribeMangaStore(() => schedule());
  return () => {
    unsub();
    if (timer) clearTimeout(timer);
  };
}

/** Flush now (app going to background) so the last chapter read isn't lost. */
export function flushMangaCloudSync(userId: string | null | undefined): void {
  if (userId) push(userId).catch(() => {});
}
