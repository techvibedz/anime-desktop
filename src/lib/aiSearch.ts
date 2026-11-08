// AI search — "describe what you want" discovery.
//
// The companion edge function (mode "search") turns any-dialect text into
// real anime titles (cached server-side for everyone); AniList then supplies
// ids, posters and metadata in ONE batched request. Cards open through the
// normal AniList → source resolution (components/AniListPosterCard), so only
// titles the sources actually carry end up playing.

import { storage as AsyncStorage } from "./storage";
import { anilistPost } from "./malInfo";
import { invokeAiFunction, type AiFailure } from "./companion";
import { aiQueryKey, buildAniListBatch, parseAniListBatch, type AiSearchEntry } from "./aiSearchCore";

export * from "./aiSearchCore";

export type AiSearchResult =
  | { ok: true; intent: string; items: AiSearchEntry[] }
  | { ok: false; reason: AiFailure | "empty" };

const CACHE_PREFIX = "@ai_search_v1:";
const CACHE_TTL = 24 * 60 * 60 * 1000;
const mem = new Map<string, { at: number; intent: string; items: AiSearchEntry[] }>();

async function aniListBatch(suggestions: { title: string; reason: string }[]): Promise<AiSearchEntry[] | null> {
  if (!suggestions.length) return [];
  const { query, variables } = buildAniListBatch(suggestions.map((s) => s.title));
  // Main-process POST (DoH, no CORS), with its own 429/5xx retries.
  const json = await anilistPost(query, variables);
  if (!json) return null;
  return parseAniListBatch(json, suggestions);
}

export async function aiSearch(query: string): Promise<AiSearchResult> {
  const key = aiQueryKey(query);
  if (key.length < 2) return { ok: false, reason: "empty" };

  const hit = mem.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return { ok: true, intent: hit.intent, items: hit.items };
  try {
    const raw = await AsyncStorage.getItem(CACHE_PREFIX + key);
    if (raw) {
      const c = JSON.parse(raw) as { at: number; intent: string; items: AiSearchEntry[] };
      if (Date.now() - c.at < CACHE_TTL && Array.isArray(c.items) && c.items.length) {
        mem.set(key, c);
        return { ok: true, intent: c.intent, items: c.items };
      }
    }
  } catch {}

  const res = await invokeAiFunction<{ intent?: string; results?: { title?: string; reason?: string }[] }>(
    { mode: "search", query: query.trim().slice(0, 300) },
    32_000,
  );
  if (!res.ok) return res;
  const suggestions = (res.data.results ?? [])
    .map((r) => ({ title: String(r?.title ?? "").trim(), reason: String(r?.reason ?? "").trim() }))
    .filter((r) => r.title.length >= 2);
  if (!suggestions.length) return { ok: false, reason: "empty" };

  const items = await aniListBatch(suggestions);
  if (items == null) return { ok: false, reason: "error" };
  if (!items.length) return { ok: false, reason: "empty" };
  const entry = { at: Date.now(), intent: String(res.data.intent ?? ""), items };
  mem.set(key, entry);
  AsyncStorage.setItem(CACHE_PREFIX + key, JSON.stringify(entry)).catch(() => {});
  return { ok: true, intent: entry.intent, items };
}
