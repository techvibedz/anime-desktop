// "أنمي اليوم" — a deterministic daily pick from the current season's AniList
// catalogue, verified against its source page BEFORE it is shown. When no
// seasonal candidate verifies (new season not yet on the sources), it falls
// back to an anime taken straight from the sources' own top list, so the card
// never just disappears. Watch always opens a pre-resolved source href.
// Ported from the mobile app (components/AnimeOfTheDay.tsx): anilistResolve's
// resolveEntryToSource → the shared schedule.resolveSourceUrl, Share.share →
// clipboard copy, expo-image → <img> via usePosterImage.

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { storage } from "../lib/storage";
import { currentSeason, fetchSeasonAnime, type CatalogAnime } from "../lib/seasons";
import { localDayKey, orderDailyPool, pickIndexOfTheDay } from "../lib/dailyPick";
import { resolveSourceUrl } from "../lib/schedule";
import { fetchEpisodes, fetchHome, type AnimeDetail, type AnimeItem, type EpisodeItem } from "../lib/api";
import { usePosterImage } from "../lib/posters";
import { t } from "../lib/i18n";

// Kept apart from resolveSourceUrl's 7-day cache: that one may hold UNVERIFIED
// hrefs, only a source page that actually loaded belongs in this one. A single
// fixed key (payload carries its dayKey) so old days can never pile up.
const VERIFIED_KEY = "@daily_pick_verified_v1";
// Fallback candidates within the popular pool; each one is a "try a new one".
const MAX_CANDIDATES = 8;
// Total verification budget before the source-native fallback takes over.
const SCAN_DEADLINE_MS = 40_000;

type DailyPick = {
  id: string | number;
  title: string;
  poster?: string | null;
  score?: number | null;
  episodes?: number | null;
  genres: string[];
  href: string;
};

function toSeasonalPick(anime: CatalogAnime, detail: AnimeDetail, href: string): DailyPick {
  return {
    id: anime.id,
    title: detail.title,
    // Source poster only when absolute — a relative/garbage string renders
    // blank, so fall back to the AniList image then.
    poster: /^https?:\/\//i.test(detail.poster || "") ? detail.poster : anime.image,
    score: anime.score,
    episodes: detail.totalEpisodes || anime.episodes,
    genres: detail.genres?.length ? detail.genres : anime.genres,
    href,
  };
}

function parseScore(raw?: string | null): number | null {
  const n = parseFloat(String(raw ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function AnimeOfTheDay() {
  const navigate = useNavigate();
  const [pick, setPick] = useState<DailyPick | null>(null);
  const [dayKey, setDayKey] = useState(() => localDayKey());
  const [copied, setCopied] = useState(false);
  const lastPushRef = useRef(0); // synchronous navigation double-push guard

  // A window left open (or resumed the next day) must not keep showing
  // yesterday's pick — recompute the day whenever the window regains focus.
  useEffect(() => {
    const onFocus = () => setDayKey((prev) => {
      const today = localDayKey();
      return prev === today ? prev : today;
    });
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  useEffect(() => {
    let alive = true;
    setPick(null);
    const { season, year } = currentSeason();

    const verifyHref = async (href: string): Promise<AnimeDetail | null> => {
      const res = await fetchEpisodes(href).catch(() => null);
      // Verification means playable, not merely parseable: a www redirect to a
      // homepage passes the title check but has no episodes, so a title alone
      // must never count as verified.
      return res?.success && res.data.title && res.data.episodes.length > 0 ? res.data : null;
    };

    const run = async () => {
      // Watchable seasonal entries, most popular first.
      const pool = orderDailyPool(
        await fetchSeasonAnime(season, year).catch(() => [] as CatalogAnime[]),
      );
      if (!alive) return;

      const deadline = Date.now() + SCAN_DEADLINE_MS;
      // Soft deadline: a single slow scrape must not blow the whole budget.
      // The underlying scrape job can't be cancelled, but we stop waiting.
      const raceDeadline = <T,>(p: Promise<T>): Promise<T | null> => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        return Promise.race([
          p.finally(() => { if (timer) clearTimeout(timer); }),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()));
          }),
        ]);
      };

      // 1) Today's already-verified pick — re-verify, then show with no search.
      if (pool.length > 0) {
        try {
          const raw = await storage.getItem(VERIFIED_KEY);
          if (raw) {
            const cached = JSON.parse(raw) as { dayKey?: string; anilistId?: number; href?: string };
            if (cached.dayKey === dayKey && typeof cached.anilistId === "number" && cached.href) {
              const detail = await raceDeadline(verifyHref(cached.href));
              if (!alive) return;
              const anime = pool.find((a) => a.id === cached.anilistId);
              if (detail && anime) {
                setPick(toSeasonalPick(anime, detail, cached.href));
                return;
              }
            }
            // Stale day, corrupt entry, or no longer verifiable → drop and search.
            await storage.removeItem(VERIFIED_KEY).catch(() => {});
          }
        } catch {
          await storage.removeItem(VERIFIED_KEY).catch(() => {});
        }

        // 2) Scan the popular pool. Starting at the day index and walking
        // BACKWARD reaches the most popular end first (then wraps around), so
        // retries are likelier to exist in the sources than the initial pick.
        const n = pool.length;
        const start = pickIndexOfTheDay(n, dayKey);
        const count = Math.min(MAX_CANDIDATES, n);
        for (let i = 0; i < count; i++) {
          if (!alive || Date.now() > deadline) break;
          const candidate = pool[(start - i + n) % n];
          const href = await raceDeadline(resolveSourceUrl(candidate.title).catch(() => null));
          if (!alive) return;
          if (!href) continue;
          const detail = await raceDeadline(verifyHref(href));
          if (!alive) return;
          if (!detail) continue;
          setPick(toSeasonalPick(candidate, detail, href));
          storage.setItem(
            VERIFIED_KEY,
            JSON.stringify({ dayKey, anilistId: candidate.id, href }),
          ).catch(() => {});
          return;
        }
      }

      // 3) Guaranteed fallback: an anime taken straight from the sources' own
      // home feed. It already lives on the sources, so no verification is
      // needed — the card shows something watchable no matter how new the
      // season is on AniList or which rail survived the scrape.
      if (!alive) return;
      const home = await fetchHome().catch(() => null);
      if (!alive || !home?.data) return;
      const sections = home.data.sections ?? [];
      const absoluteImage = (src?: string | null) =>
        /^https?:\/\//i.test(src || "") ? src! : null;

      // 3a) A source-native ANIME card (top list preferred).
      const animeSection =
        sections.find((sec) => sec.type === "anime" && /top[_-]?anime/i.test(sec.id)) ??
        sections.find((sec) => sec.type === "anime");
      const animeItem = animeSection?.items.find(
        (it): it is AnimeItem =>
          !!it && !("animeHref" in it) &&
          typeof (it as AnimeItem).href === "string" && (it as AnimeItem).href.length > 0,
      );
      if (animeItem) {
        setPick({
          id: `source:${animeItem.href}`,
          title: animeItem.title,
          poster: absoluteImage(animeItem.image),
          score: parseScore(animeItem.rating),
          episodes: null,
          genres: [],
          href: animeItem.href,
        });
        return;
      }

      // 3b) Episode-only home (witanime scrape failed, another recent feed
      // survived): open the episode's parent anime page instead.
      for (const sec of sections) {
        const ep = sec.items.find(
          (it): it is EpisodeItem =>
            !!it && typeof (it as EpisodeItem).animeHref === "string" &&
            (it as EpisodeItem).animeHref.length > 0,
        );
        if (!ep) continue;
        setPick({
          id: `source:${ep.animeHref}`,
          title: ep.animeTitle || ep.title,
          poster: absoluteImage(ep.image),
          score: null,
          episodes: null,
          genres: [],
          href: ep.animeHref,
        });
        return;
      }

      // 3c) Last resort: the featured hero.
      const featured = home.data.featured?.[0];
      if (featured?.href) {
        setPick({
          id: `source:${featured.href}`,
          title: featured.title,
          poster: absoluteImage(featured.image),
          score: null,
          episodes: null,
          genres: featured.genres ?? [],
          href: featured.href,
        });
      }
    };

    run().catch(() => {});
    return () => {
      alive = false;
    };
  }, [dayKey]);

  const openWatch = useCallback(() => {
    if (!pick) return;
    const now = Date.now();
    if (now - lastPushRef.current < 600) return;
    lastPushRef.current = now;
    navigate(`/anime/${encodeURIComponent(pick.href)}`);
  }, [navigate, pick]);

  const share = useCallback(() => {
    if (!pick) return;
    navigator.clipboard?.writeText(pick.href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }).catch(() => {});
  }, [pick]);

  const poster = usePosterImage(pick?.poster, pick?.href);

  if (!pick) return null;

  return (
    <section className="lazy-section space-y-4">
      <div>
        <h2 className="flex items-center gap-2 text-xl font-bold text-white">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-accent">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
          </svg>
          {t.dailyTitle}
        </h2>
        <p className="mt-1 text-xs text-text-muted">{t.dailySub}</p>
      </div>

      <div className="flex gap-4 rounded-xl border border-white/10 bg-raised p-4 shadow-card">
        <div className="relative aspect-[2/3] w-[110px] shrink-0 overflow-hidden rounded-lg bg-surface">
          {poster.src ? (
            <img
              src={poster.src}
              alt={pick.title}
              className="h-full w-full object-cover"
              loading="lazy"
              decoding="async"
              onError={poster.onError}
            />
          ) : poster.repairing ? (
            <div className="h-full w-full shimmer" />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="text-text-muted">
                <rect x="2" y="3" width="20" height="18" rx="2" />
                <path d="M7 3v18M17 3v18M2 9h5M2 15h5M17 9h5M17 15h5" />
              </svg>
            </div>
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col justify-between gap-2">
          <h3 className="line-clamp-2 text-lg font-bold leading-snug text-text">{pick.title}</h3>

          <div className="flex items-center gap-2 text-xs">
            {pick.score != null && (
              <span className="flex items-center gap-1 rounded bg-gold/10 px-1.5 py-0.5 font-bold text-gold">
                <span aria-hidden>★</span>
                {pick.score}
              </span>
            )}
            {pick.episodes != null && <span className="text-text-muted">{t.episodeCount(pick.episodes)}</span>}
          </div>

          {pick.genres.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {pick.genres.slice(0, 3).map((g) => (
                <span key={g} className="rounded bg-surface px-2 py-0.5 text-[10px] font-semibold text-text-secondary">
                  {g}
                </span>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={openWatch}
              className="flex min-h-[40px] flex-1 items-center justify-center gap-2 rounded-lg bg-accent text-sm font-bold text-black transition-colors hover:bg-accent-bright"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
              {t.watchNow}
            </button>
            <button
              type="button"
              onClick={share}
              title={t.dailyShare}
              aria-label={t.dailyShare}
              className="flex h-10 w-10 items-center justify-center rounded-lg border border-glass-border bg-bg/40 text-text transition-colors hover:border-accent hover:text-accent"
            >
              {copied ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="text-accent"><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" /></svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z" /></svg>
              )}
            </button>
          </div>
        </div>
      </div>

      {copied && <p className="text-[11px] font-semibold text-accent">{t.dailyLinkCopied}</p>}
    </section>
  );
}
