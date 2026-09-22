// LocalStorage shim with the same async surface as AsyncStorage so we can
// reuse code patterns ported from the mobile app without rewriting them.

// Re-fetchable caches. localStorage can hit its quota too, and when it does
// EVERY write fails silently — history, dismissals and downloads stop
// persisting. Dropping these is always safe; the app rebuilds them.
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
  "pantoufa_home_cache",
  "pantoufa_cache",
];

function pruneCaches(): number {
  let removed = 0;
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && CACHE_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        localStorage.removeItem(key);
        removed++;
      }
    }
  } catch {}
  return removed;
}

let writeFailureLogged = false;

export const storage = {
  async getItem(key: string): Promise<string | null> {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  async setItem(key: string, value: string): Promise<void> {
    try {
      localStorage.setItem(key, value);
      return;
    } catch (first) {
      // Quota exceeded: free the caches and retry once before giving up.
      const pruned = pruneCaches();
      try {
        localStorage.setItem(key, value);
        console.info(`[storage] write recovered after pruning ${pruned} cache keys`);
      } catch (second) {
        if (!writeFailureLogged) {
          writeFailureLogged = true;
          console.error(`[storage] write FAILED for "${key}":`, second);
        }
      }
    }
  },
  async removeItem(key: string): Promise<void> {
    try {
      localStorage.removeItem(key);
    } catch {}
  },
};
