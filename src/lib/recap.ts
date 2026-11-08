// "Previously on…" — when to offer the AI recap, and remembering dismissals.
// The recap text itself comes from the companion edge function (mode
// "recap"), which caches every recap in Supabase so each episode's recap is
// generated once for all users.

import { storage as AsyncStorage } from "./storage";
import { animeTitleKey, getHistory, normAnimeKey } from "./history";
import { getRecapOffers } from "./settings";
import { decideRecapOffer, type RecapOffer } from "./recapOffer";

export * from "./recapOffer";

const DISMISS_KEY = "@recap_dismissed_v1";
/** A dismissed offer stays quiet for this anime for a while. */
const DISMISS_QUIET_MS = 3 * 24 * 60 * 60 * 1000;

async function readDismissed(): Promise<Record<string, number>> {
  try {
    const raw = await AsyncStorage.getItem(DISMISS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function getRecapOffer(ctx: {
  animeHref: string;
  animeTitle: string;
  episodeHref: string;
  epNum: number | null;
}): Promise<RecapOffer | null> {
  try {
    if (!(await getRecapOffers())) return null;
    const titleKey = animeTitleKey(ctx.animeTitle);
    const hrefKey = ctx.animeHref ? normAnimeKey(ctx.animeHref) : "";
    const dismissed = await readDismissed();
    const at = dismissed[titleKey || hrefKey];
    if (at && Date.now() - at < DISMISS_QUIET_MS) return null;
    const history = await getHistory();
    return decideRecapOffer(
      history.map((e) => ({
        hrefKey: e.animeHref ? normAnimeKey(e.animeHref) : "",
        titleKey: animeTitleKey(e.animeTitle),
        episodeHref: e.episodeHref,
        updatedAt: e.updatedAt,
        epNum: e.epNum ?? null,
      })),
      { hrefKey, titleKey, episodeHref: ctx.episodeHref, epNum: ctx.epNum, now: Date.now() },
    );
  } catch {
    return null;
  }
}

export async function dismissRecapOffer(animeTitle: string, animeHref: string): Promise<void> {
  const key = animeTitleKey(animeTitle) || (animeHref ? normAnimeKey(animeHref) : "");
  if (!key) return;
  const map = await readDismissed();
  map[key] = Date.now();
  // Keep the map small.
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 200);
  await AsyncStorage.setItem(DISMISS_KEY, JSON.stringify(Object.fromEntries(entries))).catch(() => {});
}
