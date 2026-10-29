// "أنمي اليوم" — one great anime a day from an all-time best-of pool
// (lib/dailyPool: finished, highly rated, widely watched first entries). The
// order is a no-repeat daily shuffle (lib/dailyPick), so a title only returns
// after the whole pool has been shown, and every install — desktop and mobile
// — names the same anime on the same day.
//
// Speed: the card is built from AniList data alone, so it shows as soon as the
// cached pool is read; today's pick is kept in memory + on disk. The source
// page resolves in the background; a pick the sources don't carry is replaced
// by the next day's candidate. Ported from mobile components/AnimeOfTheDay.tsx.

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { storage } from "../lib/storage";
import { dailyCandidates, localDayKey, localDayNumber } from "../lib/dailyPick";
import { getDailyPool, type DailyAnime } from "../lib/dailyPool";
import { arGenre } from "../lib/anilistLabels";
import { resolveSourceUrl } from "../lib/schedule";
import { checkOnline } from "../lib/net";
import { usePosterImage } from "../lib/posters";
import { t } from "../lib/i18n";

const PICK_KEY = "@daily_pick_v2";
const MAX_CANDIDATES = 6;
const RESOLVE_DELAY_MS = 2500;

type DailyPick = {
  id: number;
  title: string;
  titleEnglish: string | null;
  format: string | null;
  poster: string | null;
  /** 0–10, one decimal. */
  score: number | null;
  episodes: number | null;
  genres: string[];
  /** Source page once resolved; null while pending. */
  href: string | null;
  /** Remaining fallback candidate ids, in order. */
  next: number[];
};

type StoredPick = { dayKey: string; pick: DailyPick };
let memPick: StoredPick | null = null;

function toPick(a: DailyAnime, next: number[]): DailyPick {
  return {
    id: a.id,
    title: a.title,
    titleEnglish: a.titleEnglish,
    format: a.format,
    poster: a.image,
    score: a.score != null ? Math.round(a.score) / 10 : null,
    episodes: a.episodes,
    genres: a.genres.slice(0, 3).map(arGenre),
    href: null,
    next,
  };
}

function store(dayKey: string, pick: DailyPick) {
  memPick = { dayKey, pick };
  storage.setItem(PICK_KEY, JSON.stringify(memPick)).catch(() => {});
}

async function resolvePick(p: DailyPick): Promise<string | null> {
  return (await resolveSourceUrl(p.title).catch(() => null))
    ?? (p.titleEnglish ? await resolveSourceUrl(p.titleEnglish).catch(() => null) : null);
}

export function AnimeOfTheDay() {
  const navigate = useNavigate();
  const [pick, setPick] = useState<DailyPick | null>(() => (memPick?.dayKey === localDayKey() ? memPick.pick : null));
  const [dayKey, setDayKey] = useState(() => localDayKey());
  const [copied, setCopied] = useState(false);
  const [opening, setOpening] = useState(false);
  const lastPushRef = useRef(0); // double-navigation guard

  // A window left open overnight rolls over to the new day on refocus.
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
    const show = (p: DailyPick) => {
      if (!alive) return;
      store(dayKey, p);
      setPick(p);
    };

    // Background: make sure today's pick opens on the sources; fall through to
    // the next candidate when it doesn't.
    const ensurePlayable = async (start: DailyPick) => {
      let cur: DailyPick | null = start;
      while (alive && cur && !cur.href) {
        const href = await resolvePick(cur);
        if (!alive) return;
        if (href) { show({ ...cur, href }); return; }
        // Offline / sources down is not "not on the sources": keep today's pick.
        if (!(await checkOnline().catch(() => false))) return;
        const nextId: number | undefined = cur.next[0];
        const pool: DailyAnime[] = nextId != null ? await getDailyPool() : [];
        const a: DailyAnime | undefined = pool.find((x) => x.id === nextId);
        cur = a ? toPick(a, cur.next.slice(1)) : null;
        if (cur) show(cur);
      }
    };

    const run = async () => {
      let today = memPick?.dayKey === dayKey ? memPick.pick : null;
      if (!today) {
        try {
          const raw = await storage.getItem(PICK_KEY);
          const saved = raw ? (JSON.parse(raw) as StoredPick) : null;
          if (saved?.dayKey === dayKey && saved.pick?.id) today = saved.pick;
        } catch {}
      }
      if (!today) {
        const pool = await getDailyPool();
        if (!alive || pool.length === 0) return;
        const ids = dailyCandidates(pool.length, localDayNumber(), MAX_CANDIDATES).map((i) => pool[i].id);
        today = toPick(pool.find((x) => x.id === ids[0])!, ids.slice(1));
      }
      if (!alive) return;
      show(today);
      if (today.href) return;
      await new Promise((r) => setTimeout(r, RESOLVE_DELAY_MS));
      if (alive) await ensurePlayable(today);
    };

    void run().catch(() => {});
    return () => { alive = false; };
  }, [dayKey]);

  const openWatch = useCallback(async () => {
    if (!pick || opening) return;
    const now = Date.now();
    if (now - lastPushRef.current < 600) return;
    lastPushRef.current = now;
    if (pick.href) { navigate(`/anime/${encodeURIComponent(pick.href)}`); return; }
    // Not resolved yet: resolve on tap; the AniList page is the fallback.
    setOpening(true);
    const href = await resolvePick(pick).catch(() => null);
    setOpening(false);
    navigate(href ? `/anime/${encodeURIComponent(href)}` : `/title/${pick.id}`);
  }, [navigate, pick, opening]);

  const share = useCallback(() => {
    if (!pick) return;
    navigator.clipboard?.writeText(pick.href || pick.title).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }).catch(() => {});
  }, [pick]);

  const poster = usePosterImage(pick?.poster, pick?.href);

  if (!pick) return null;

  return (
    <section className="lazy-section">
      <div className="relative overflow-hidden rounded-[22px] border border-white/[0.06] bg-surface-container shadow-card">
        {/* Blurred poster wash behind the card — the artwork tints the panel. */}
        {poster.src && (
          <img src={poster.src} alt="" aria-hidden className="pointer-events-none absolute inset-0 h-full w-full scale-125 object-cover opacity-30 blur-3xl" />
        )}
        <div className="absolute inset-0 bg-gradient-to-l from-surface-container/40 via-surface-container/85 to-surface-container" />

        <div className="relative flex items-stretch gap-7 p-6">
          <button
            type="button"
            onClick={openWatch}
            className="group relative aspect-[2/3] w-[150px] shrink-0 overflow-hidden rounded-card bg-surface shadow-lift ring-1 ring-white/10"
            aria-label={pick.title}
          >
            {poster.src ? (
              <img
                src={poster.src}
                alt={pick.title}
                className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
                loading="lazy"
                decoding="async"
                onError={poster.onError}
              />
            ) : (
              <div className={`h-full w-full ${poster.repairing ? "shimmer" : "bg-gradient-to-br from-raised to-surface"}`} />
            )}
          </button>

          <div className="flex min-w-0 flex-1 flex-col justify-center gap-3">
            <p className="flex items-center gap-2 text-xs font-extrabold text-gold">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
              </svg>
              {t.dailyTitle}
              <span className="font-semibold text-text-muted">· {t.dailySub}</span>
            </p>
            <h3 className="line-clamp-2 font-display text-[28px] font-extrabold leading-tight text-white">{pick.title}</h3>

            <div className="flex flex-wrap items-center gap-2 text-xs">
              {pick.score != null && (
                <span className="flex items-center gap-1 rounded-full bg-gold/15 px-2.5 py-1 font-bold text-gold">
                  <span aria-hidden>★</span>
                  {pick.score.toFixed(1)}
                </span>
              )}
              {pick.episodes != null && (
                <span className="rounded-full bg-white/[0.07] px-2.5 py-1 font-semibold text-text-secondary">{t.episodeCount(pick.episodes)}</span>
              )}
              {pick.genres.slice(0, 4).map((g) => (
                <span key={g} className="rounded-full bg-white/[0.07] px-2.5 py-1 font-semibold text-text-secondary">{g}</span>
              ))}
            </div>

            <div className="flex items-center gap-2.5 pt-1">
              <button
                type="button"
                onClick={openWatch}
                className="inline-flex h-11 items-center gap-2 rounded-control bg-accent px-6 text-sm font-extrabold text-on-accent transition-colors hover:bg-accent-bright"
              >
                {opening ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-on-accent/30 border-t-on-accent" /> : <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M8 5v14l11-7z" /></svg>}
                {t.watchNow}
              </button>
              <button
                type="button"
                onClick={share}
                title={t.dailyShare}
                aria-label={t.dailyShare}
                className="flex h-11 w-11 items-center justify-center rounded-control border border-white/10 bg-white/[0.06] text-white transition-colors hover:border-accent hover:text-accent"
              >
                {copied ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="text-mint" aria-hidden><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" /></svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="m8.6 10.5 6.8-4M8.6 13.5l6.8 4" /></svg>
                )}
              </button>
              {copied && <span className="text-xs font-bold text-mint">{t.dailyLinkCopied}</span>}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
