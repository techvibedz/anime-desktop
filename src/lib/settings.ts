import { storage } from "./storage";

// Lightweight user-preferences store backed by the storage shim. Each setting
// has a key, a default, and typed get/set helpers. Kept tiny and dependency-free
// so any screen can read/write a preference without a global state library.

const KEYS = {
  notificationsEnabled: "@settings_notifications_enabled",
  autoplayNext: "@settings_autoplay_next",
  notificationScope: "@settings_notification_scope",
  autoSkipIntro: "@settings_auto_skip_intro",
  prefetchNext: "@settings_prefetch_next",
  dailyAnimeNotif: "@settings_daily_anime_notif",
} as const;

/** Which anime trigger new-episode notifications. */
export type NotificationScope = "all" | "mylist";

async function getBool(key: string, fallback: boolean): Promise<boolean> {
  try {
    const raw = await storage.getItem(key);
    if (raw === null) return fallback;
    return raw === "1";
  } catch {
    return fallback;
  }
}

async function setBool(key: string, value: boolean) {
  try {
    await storage.setItem(key, value ? "1" : "0");
  } catch {}
}

/** New-episode notifications master switch (default on). */
export const getNotificationsEnabled = () => getBool(KEYS.notificationsEnabled, true);
export const setNotificationsEnabled = (v: boolean) => setBool(KEYS.notificationsEnabled, v);

/** Autoplay the next episode when the current one ends (default on). */
export const getAutoplayNext = () => getBool(KEYS.autoplayNext, true);
export const setAutoplayNext = (v: boolean) => setBool(KEYS.autoplayNext, v);

/** Automatically skip intro & outro during playback (default off). */
export const getAutoSkipIntro = () => getBool(KEYS.autoSkipIntro, false);
export const setAutoSkipIntro = (v: boolean) => setBool(KEYS.autoSkipIntro, v);

/** Silent pre-buffer of the next episode while one plays (default on). */
export const getPrefetchNext = () => getBool(KEYS.prefetchNext, true);
export const setPrefetchNext = (v: boolean) => setBool(KEYS.prefetchNext, v);

/** Daily "anime of the day" local notification (default off — opt-in). */
export const getDailyAnimeNotif = () => getBool(KEYS.dailyAnimeNotif, false);
export const setDailyAnimeNotif = (v: boolean) => setBool(KEYS.dailyAnimeNotif, v);

/**
 * Notification scope (default "all"): notify for every new episode across all
 * anime, or only for anime saved in the user's list.
 */
export async function getNotificationScope(): Promise<NotificationScope> {
  try {
    const raw = await storage.getItem(KEYS.notificationScope);
    return raw === "mylist" ? "mylist" : "all";
  } catch {
    return "all";
  }
}

export async function setNotificationScope(value: NotificationScope) {
  try {
    await storage.setItem(KEYS.notificationScope, value);
  } catch {}
}

// Re-fetchable caches only: favorites, watch history, downloads, settings,
// notifications and auth keys never match any prefix below.
const CACHE_PREFIXES = [
  "@home_cache_",
  "@detail_",
  "@up4_",
  "@search_",
  "@listing_",
  "@recent_",
  "@servers_",
  "@wit_",
  "@a3rb_",
  "@xsource_",
  "@anime_catalog_",
  "@anime_airing_",
  "@anime_mal_",
  "@anime_relations_",
  "@anime_yt_",
  "@anime_schedule_",
  "@anime_srcurl_",
  "@translate_ar_",
  "@source_rail_",
  "@aniskip_",
  "@poster_fix_",
  "pantoufa_home_cache",
  "pantoufa_cache",
];

/**
 * Clear the app's scraping/data caches (home feed, anime details, search,
 * listings, recent, servers, etc.) without touching favorites, watch history,
 * settings or notifications. Returns the number of keys removed.
 */
export async function clearContentCache(): Promise<number> {
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && CACHE_PREFIXES.some((prefix) => key.startsWith(prefix))) toRemove.push(key);
    }
    for (const key of toRemove) localStorage.removeItem(key);
    return toRemove.length;
  } catch {
    return 0;
  }
}
