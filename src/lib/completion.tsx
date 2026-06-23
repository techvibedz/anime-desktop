// Per-anime "completion" state — the data behind the anime-card badges. Synced
// to Supabase (table `anime_completion`) so it's tied to the user account and
// SHARED with the mobile app: signing into the same account on either surface
// shows the same caught-up / finished badges.
//
//   • caught up — watched the LAST episode currently available in the app.
//   • finished  — caught up AND the series is no longer airing (real finale).
//
// A record carries EVERY known source href + title so a card from any source
// rail resolves the badge regardless of which URL it was recorded under.
// Ported from the mobile app (lib/completion.tsx); AsyncStorage → storage shim.

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { storage } from "./storage";
import { supabase, isSupabaseConfigured } from "./supabase";

const KEY = "anime_completion_v2";

export interface AnimeCompletion {
  key: string;
  hrefs: string[];
  titles: string[];
  lastEpNum: number;
  caughtUp: boolean;
  finished: boolean;
  updatedAt: number;
}

function normHref(u: string | null | undefined): string {
  if (!u) return "";
  try { return decodeURIComponent(u).replace(/\/+$/, "").toLowerCase(); }
  catch { return u.replace(/\/+$/, "").toLowerCase(); }
}
function titleKey(s: string | null | undefined): string {
  return (s || "").toLowerCase().replace(/\s+/g, " ").trim();
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

export async function getCompletionMap(): Promise<Record<string, AnimeCompletion>> {
  try {
    const raw = await storage.getItem(KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

async function saveCompletionMap(map: Record<string, AnimeCompletion>) {
  try { await storage.setItem(KEY, JSON.stringify(map)); } catch {}
}

const listeners = new Set<() => void>();
function notify() {
  for (const l of listeners) {
    try { l(); } catch {}
  }
}

async function pushToCloud(rec: AnimeCompletion) {
  if (!isSupabaseConfigured) return;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  const { error } = await supabase.from("anime_completion").upsert({
    user_id: user.id,
    anime_key: rec.key,
    hrefs: rec.hrefs,
    titles: rec.titles,
    last_ep_num: rec.lastEpNum,
    caught_up: rec.caughtUp,
    finished: rec.finished,
    updated_at: new Date(rec.updatedAt).toISOString(),
  }, { onConflict: "user_id,anime_key" });
  if (error) console.warn("[completion] cloud sync failed:", error.message);
}

export async function recordAnimeCompletion(rec: {
  hrefs: (string | null | undefined)[];
  titles: (string | null | undefined)[];
  lastEpNum: number;
  caughtUp: boolean;
  finished: boolean;
}): Promise<void> {
  const hrefs = uniq(rec.hrefs);
  const titles = uniq(rec.titles);
  const key = normHref(hrefs[0]) || titleKey(titles[0]);
  if (!key) return;
  const map = await getCompletionMap();
  const prev = map[key];
  const next: AnimeCompletion = {
    key,
    hrefs: uniq([...(prev?.hrefs || []), ...hrefs]),
    titles: uniq([...(prev?.titles || []), ...titles]),
    lastEpNum: Math.max(rec.lastEpNum || 0, prev?.lastEpNum || 0),
    caughtUp: rec.caughtUp,
    finished: rec.finished,
    updatedAt: Date.now(),
  };
  if (
    prev &&
    prev.caughtUp === next.caughtUp &&
    prev.finished === next.finished &&
    prev.lastEpNum === next.lastEpNum &&
    prev.hrefs.length === next.hrefs.length &&
    prev.titles.length === next.titles.length
  ) {
    return;
  }
  map[key] = next;
  await saveCompletionMap(map);
  notify();
  pushToCloud(next).catch(() => {});
}

export async function pullCompletionFromCloud(): Promise<void> {
  if (!isSupabaseConfigured) return;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  const { data, error } = await supabase.from("anime_completion")
    .select("*")
    .eq("user_id", user.id);
  if (error) { console.warn("[completion] pull failed:", error.message); return; }
  if (!data) return;
  const map = await getCompletionMap();
  for (const row of data as any[]) {
    const cloud: AnimeCompletion = {
      key: row.anime_key,
      hrefs: Array.isArray(row.hrefs) ? row.hrefs : [],
      titles: Array.isArray(row.titles) ? row.titles : [],
      lastEpNum: row.last_ep_num || 0,
      caughtUp: !!row.caught_up,
      finished: !!row.finished,
      updatedAt: new Date(row.updated_at).getTime(),
    };
    const local = map[cloud.key];
    if (!local || cloud.updatedAt >= local.updatedAt) {
      map[cloud.key] = {
        ...cloud,
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

export async function countCompletedAnime(): Promise<number> {
  const map = await getCompletionMap();
  return Object.values(map).filter((r) => r.finished).length;
}

/* ── Lookup + context ───────────────────────────────── */

export interface CompletionLookup {
  byHref: Map<string, AnimeCompletion>;
  byTitle: Map<string, AnimeCompletion>;
  get(opts: {
    hrefs?: (string | null | undefined)[];
    titles?: (string | null | undefined)[];
  }): AnimeCompletion | null;
}

function buildLookup(map: Record<string, AnimeCompletion>): CompletionLookup {
  const byHref = new Map<string, AnimeCompletion>();
  const byTitle = new Map<string, AnimeCompletion>();
  for (const rec of Object.values(map)) {
    for (const h of rec.hrefs) byHref.set(normHref(h), rec);
    for (const tt of rec.titles) byTitle.set(titleKey(tt), rec);
  }
  return {
    byHref,
    byTitle,
    get({ hrefs, titles }) {
      for (const h of hrefs || []) {
        if (h) { const r = byHref.get(normHref(h)); if (r) return r; }
      }
      for (const tt of titles || []) {
        if (tt) { const r = byTitle.get(titleKey(tt)); if (r) return r; }
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
    return () => { listeners.delete(refresh); };
  }, [refresh]);
  return <CompletionContext.Provider value={lookup}>{children}</CompletionContext.Provider>;
}

export function useCompletionLookup(): CompletionLookup {
  return useContext(CompletionContext);
}

export function useAnimeCompletion(
  hrefs?: (string | null | undefined)[],
  titles?: (string | null | undefined)[],
): AnimeCompletion | null {
  return useCompletionLookup().get({ hrefs, titles });
}
