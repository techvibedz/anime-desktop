// Episode reactions (hype map) — network layer over the episode_reactions
// table. Reads are aggregate-only (get_episode_reactions RPC); writes are one
// row per user per bucket per emoji, rate limited server-side.

import { animeTitleKey } from "./history";
import { isSupabaseConfigured, supabase } from "./supabase";
import { buildReactionMap, bucketOf, type ReactionId, type ReactionMap, type ReactionRow } from "./reactionsCore";

export * from "./reactionsCore";

/** Cross-source anime identity for reactions (the same show on any source). */
export function reactionAnimeKey(animeTitle: string): string {
  return animeTitleKey(animeTitle).slice(0, 200);
}

export async function fetchReactions(animeKey: string, epNum: number): Promise<ReactionMap | null> {
  if (!isSupabaseConfigured || !animeKey) return null;
  try {
    const { data, error } = await supabase.rpc("get_episode_reactions", { p_anime_key: animeKey, p_ep: epNum });
    if (error || !Array.isArray(data)) return null;
    return buildReactionMap(data as ReactionRow[]);
  } catch {
    return null;
  }
}

export type PostResult = "ok" | "duplicate" | "rate_limited" | "error";

export async function postReaction(animeKey: string, epNum: number, sec: number, emoji: ReactionId): Promise<PostResult> {
  if (!isSupabaseConfigured || !animeKey) return "error";
  try {
    const { error } = await supabase
      .from("episode_reactions")
      .insert({ anime_key: animeKey, ep_num: epNum, bucket: bucketOf(sec), emoji });
    if (!error) return "ok";
    if (error.code === "23505") return "duplicate";
    if (/rate_limited/i.test(error.message || "")) return "rate_limited";
    return "error";
  } catch {
    return "error";
  }
}
