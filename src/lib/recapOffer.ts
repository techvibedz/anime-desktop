// "Previously on…" offer logic (pure — unit-tested under tsx).
//
// The player offers an AI recap on the server-picker screen when it would
// actually help: the user is coming back to a show after a real break, or is
// jumping into a show mid-way without any watch history for it. Fresh binges
// (watched yesterday) and episode 1 never see it.

export const RECAP_GAP_DAYS = 5;
/** Starting cold at this episode or later (no history) also earns an offer. */
export const RECAP_JUMP_IN_FROM_EP = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export type RecapOffer =
  | { kind: "gap"; days: number; lastEp: number | null }
  | { kind: "jump" };

export interface RecapHistoryRow {
  /** Pre-normalized per-anime key (normAnimeKey of the anime href). */
  hrefKey: string;
  /** Pre-normalized cross-source title key (animeTitleKey). */
  titleKey: string;
  episodeHref: string;
  updatedAt: number;
  epNum?: number | null;
}

export function decideRecapOffer(
  rows: RecapHistoryRow[],
  ctx: { hrefKey: string; titleKey: string; episodeHref: string; epNum: number | null; now: number },
): RecapOffer | null {
  if (ctx.epNum == null || ctx.epNum <= 1) return null;
  const mine = rows.filter((r) =>
    (!!ctx.hrefKey && r.hrefKey === ctx.hrefKey) || (!!ctx.titleKey && r.titleKey === ctx.titleKey));
  // Ignore rows for episodes AFTER this one (re-watching an older episode
  // after finishing the show shouldn't trigger a "you forgot" recap).
  const relevant = mine.filter((r) => r.epNum == null || r.epNum <= ctx.epNum!);
  if (!relevant.length) {
    if (mine.length) return null; // they've seen later episodes: not a cold start
    return ctx.epNum >= RECAP_JUMP_IN_FROM_EP ? { kind: "jump" } : null;
  }
  let last = relevant[0];
  for (const r of relevant) if (r.updatedAt > last.updatedAt) last = r;
  const days = Math.floor((ctx.now - last.updatedAt) / DAY_MS);
  if (days < RECAP_GAP_DAYS) return null;
  return { kind: "gap", days, lastEp: last.epNum ?? null };
}
