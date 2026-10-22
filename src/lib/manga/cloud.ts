// Syncs the local manga library + reading progress with the account copy in
// Supabase (public.manga_activity) — the same table the phone app and the
// admin users screen use. On sign-in the server rows are merged into the local
// store first (library added, newer progress wins), then local changes are
// pushed back, debounced and diffed so a page-by-page reading session costs at
// most one small upsert every few seconds.

import { supabase, isSupabaseConfigured } from "../supabase";
import { getMangaLibrary, getContinueReading, mergeCloudManga, subscribeMangaStore } from "./store";
import type { MangaSourceId } from "./types";
import { buildMangaActivityRows, MANGA_ACTIVITY_CAP, type MangaActivityRow } from "./activity";

const PUSH_DELAY_MS = 8000;

let lastPushed = new Map<string, string>(); // manga_key → row fingerprint
let lastUser: string | null = null;

const SOURCES: readonly string[] = ["asq", "mangawy", "mangalik"] satisfies MangaSourceId[];

/** Pull the account's rows into the local store. Returns the server keys, or
 * null when the read failed (then nothing may be deleted on push). */
async function pull(userId: string): Promise<Map<string, string> | null> {
  const { data, error } = await supabase
    .from("manga_activity")
    .select("manga_key, source, manga_id, title, cover, chapter_number, page, total, in_library, updated_at")
    .eq("user_id", userId)
    .limit(MANGA_ACTIVITY_CAP * 2);
  if (error || !data) return null;
  const rows = data as Omit<MangaActivityRow, "user_id">[];
  await mergeCloudManga(rows
    .filter((r) => SOURCES.includes(r.source) && r.manga_id)
    .map((r) => ({
      source: r.source as MangaSourceId,
      id: r.manga_id,
      title: r.title ?? "",
      cover: r.cover ?? null,
      chapterNumber: r.chapter_number,
      page: Math.max(0, r.page ?? 0),
      total: Math.max(0, r.total ?? 0),
      inLibrary: !!r.in_library,
      updatedAt: Date.parse(r.updated_at) || 0,
    })));
  // Fingerprint "" = re-upsert on the first push (rows from other devices are
  // re-stamped with this device's merged view, which is identical or newer).
  return new Map(rows.map((r) => [r.manga_key, ""]));
}

async function push(userId: string): Promise<void> {
  if (!isSupabaseConfigured) return;
  if (lastUser !== userId) {
    // First sync this session: merge the account copy in BEFORE diffing, so a
    // fresh install (empty local store) restores the profile's manga instead
    // of deleting it from the server.
    const server = await pull(userId);
    if (!server) throw new Error("manga pull failed");
    lastPushed = server;
    lastUser = userId;
  }
  const [library, progress] = await Promise.all([getMangaLibrary(), getContinueReading(MANGA_ACTIVITY_CAP)]);
  const rows = buildMangaActivityRows(userId, library, progress);
  const next = new Map(rows.map((r) => [r.manga_key, JSON.stringify(r)]));
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
  let stopped = false;
  const schedule = (delay = PUSH_DELAY_MS) => {
    if (timer) clearTimeout(timer);
    // A failed pull/push (offline at launch) retries on its own — the profile
    // copy must not wait for the next local change to come down.
    timer = setTimeout(() => { timer = null; push(userId).catch(() => { if (!stopped) schedule(30_000); }); }, delay);
  };
  schedule(1500); // pull + initial upload shortly after sign-in / launch
  const unsub = subscribeMangaStore(() => schedule());
  return () => {
    stopped = true;
    unsub();
    if (timer) clearTimeout(timer);
    lastUser = null; // next sign-in pulls the account copy again
  };
}

/** Flush now (app going to background) so the last chapter read isn't lost. */
export function flushMangaCloudSync(userId: string | null | undefined): void {
  if (userId) push(userId).catch(() => {});
}
