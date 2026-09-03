import { memo, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { clearHomeCache, fetchHome, type HomeSection, type FeaturedItem, type AnimeItem, type EpisodeItem } from "../lib/api";
import { AnimeCard, EpisodeCard } from "../components/AnimeCard";
import { EpisodeActionModal } from "../components/EpisodeActionModal";
import { Shimmer } from "../components/Shimmer";
import { SourceRail } from "../components/SourceRail";
import { dismissFromContinue, getContinueWatching, pullHistoryFromCloud, type WatchEntry } from "../lib/history";
import { reconcileCompletionFromEpisodes } from "../lib/completion";
import { extractEpisodeNumber } from "../lib/episode-utils";
import { t } from "../lib/i18n";

export function HomePage() {
  const [featured, setFeatured] = useState<FeaturedItem[]>([]);
  const [sections, setSections] = useState<HomeSection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [episodePopup, setEpisodePopup] = useState<EpisodeItem | null>(null);
  const [history, setHistory] = useState<WatchEntry[]>([]);
  const [retryAttempt, setRetryAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;

    setLoading(true);
    setError(null);
    // Apply a home payload to the screen — used by the initial load AND by
    // fetchHome's onUpdated push, which fires when the background revalidation
    // lands with visibly newer content (new episode aired etc.) so the feed
    // updates live, no manual refresh needed.
    const apply = (r: { data: { featured: FeaturedItem[]; sections: HomeSection[] } }) => {
      setFeatured(r.data.featured);
      setSections(r.data.sections.filter((s) => s.id !== "tv_series"));
      // Clear stale "caught up"/"finished" badges the instant a new episode
      // drops, without waiting for the user to reopen the anime's detail page.
      const recent = r.data.sections.find((s) => s.id === "recently_updated");
      if (recent) {
        reconcileCompletionFromEpisodes(
          (recent.items as EpisodeItem[]).map((ep) => ({
            animeHref: ep.animeHref,
            animeTitle: ep.animeTitle,
            epNum: extractEpisodeNumber(ep.title),
          })),
        ).catch(() => {});
      }
    };
    fetchHome((fresh) => { if (!cancelled) apply(fresh); })
      .then((r) => {
        if (cancelled) return;
        apply(r);
      })
      .catch(async (e) => {
        if (cancelled) return;
        await clearHomeCache().catch(() => {});
        if (retryAttempt < 2) {
          retryTimer = setTimeout(() => setRetryAttempt((n) => n + 1), 1500 * (retryAttempt + 1));
          return;
        }
        setError(e?.message ?? t.failedToLoad);
        reloadTimer = setTimeout(() => window.location.reload(), 1200);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    // Pull the shared cloud history first so the row matches the mobile app on
    // the same account, then read the deduped (one-per-anime) list. Pulling here
    // closes the race where Home read local storage before App's pull finished.
    pullHistoryFromCloud()
      .catch(() => {})
      .then(() => getContinueWatching())
      .then((items) => { if (!cancelled) setHistory(items); });

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (reloadTimer) clearTimeout(reloadTimer);
    };
  }, [retryAttempt]);

  // Refresh when the window regains focus (e.g. back from the Watch page), so
  // progress made elsewhere shows up — mirrors mobile's focus refresh.
  useEffect(() => {
    const refresh = () => getContinueWatching().then(setHistory);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  if ((loading || retryAttempt > 0) && sections.length === 0) {
    return (
      <div className="space-y-10">
        <Shimmer className="h-[440px] w-full rounded-2xl" />
        <div className="space-y-4">
          <Shimmer className="h-6 w-48" />
          <div className="grid grid-cols-6 gap-4">
            {Array.from({ length: 6 }).map((_, i) => <Shimmer key={i} className="aspect-[2/3]" />)}
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center text-text-secondary">
        <div className="h-10 w-10 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        <p>{error}</p>
        <p className="text-sm text-text-muted">Reloading automatically...</p>
      </div>
    );
  }

  return (
    <div className="space-y-12">
      <Hero featured={featured} />

      {history.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-xl font-bold text-white">{t.continueWatching}</h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {history.map((w) => {
              const epNum = extractEpisodeNumber(w.episodeTitle, w.episodeHref);
              const pct = w.durationMs > 0 ? Math.min(100, Math.round((w.positionMs / w.durationMs) * 100)) : 0;
              return (
                <Link
                  key={w.episodeHref}
                  to={`/watch/${encodeURIComponent(w.episodeHref)}${w.animeHref ? `?anime=${encodeURIComponent(w.animeHref)}` : ""}${w.image && !w.animeHref ? `?img=${encodeURIComponent(w.image)}` : ""}${w.url4up ? `&up4=${encodeURIComponent(w.url4up)}` : ""}`}
                  className="group block"
                >
                  <div className="relative aspect-[2/3] overflow-hidden rounded-lg bg-surface ring-1 ring-transparent transition-shadow duration-200 group-hover:shadow-glow group-hover:ring-accent/50">
                    {epNum != null && (
                      <span className="absolute start-2 top-2 z-10 rounded-md bg-accent px-1.5 py-0.5 text-[10px] font-bold leading-tight text-black">
                        {t.episode} {epNum}
                      </span>
                    )}
                    <button
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        dismissFromContinue(w.episodeHref);
                        setHistory((prev) => prev.filter((h) => h.episodeHref !== w.episodeHref));
                      }}
                      className="absolute end-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-white/70 opacity-0 transition group-hover:opacity-100 hover:bg-red-600 hover:text-white"
                      title={t.remove}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                    {w.image ? (
                      <img
                        src={w.image}
                        alt={w.animeTitle || w.episodeTitle}
                        className="h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.04]"
                        loading="lazy"
                        decoding="async"
                      />
                    ) : (
                      <div className="h-full w-full shimmer" />
                    )}
                    {/* Progress bar pinned to the poster's bottom edge */}
                    {w.durationMs > 0 && (
                      <div className="absolute inset-x-0 bottom-0 h-1 bg-black/50">
                        <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
                      </div>
                    )}
                  </div>
                  <p className="mt-2 line-clamp-1 text-[11px] font-semibold text-accent/90">{w.animeTitle || ""}</p>
                  <h3 className="line-clamp-1 text-[13px] font-semibold text-text-secondary transition-colors group-hover:text-white">
                    {w.episodeTitle}
                  </h3>
                </Link>
              );
            })}
          </div>
        </section>
      )}

      {sections.map((s) => (
        <Section key={s.id} section={s} onOpenEpisode={setEpisodePopup} />
      ))}

      {/* Source-direct rails (scraped from our own sources, no AniList) */}
      <SourceRail kind="season" title={t.railThisSeason} />
      <SourceRail kind="movies" title={t.railMovies} />

      <EpisodeActionModal episode={episodePopup} onClose={() => setEpisodePopup(null)} />
    </div>
  );
}

// Self-contained hero carousel. The rotation interval lives HERE so its tick
// re-renders only the hero — not the continue-watching row and every rail.
function Hero({ featured }: { featured: FeaturedItem[] }) {
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    if (featured.length < 2) return;
    const id = setInterval(() => setIdx((i) => (i + 1) % featured.length), 7000);
    return () => clearInterval(id);
  }, [featured.length]);

  // Warm the next slide's artwork so the crossfade never flashes empty.
  useEffect(() => {
    if (featured.length < 2) return;
    const next = featured[(idx + 1) % featured.length];
    if (next?.image) { const im = new Image(); im.src = next.image; }
  }, [idx, featured]);

  const f = featured[idx];
  if (!f) return null;

  return (
    <div className="relative -mx-8 -mt-7 overflow-hidden">
      <div className="relative h-[62vh] min-h-[380px] w-full">
        {f.image && (
          <img
            key={f.image}
            src={f.image}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
            style={{ animation: "heroFade 700ms ease-out" }}
          />
        )}
        {/* Bottom scrim into the canvas + start-side scrim under the copy */}
        <div className="absolute inset-0 bg-gradient-to-t from-bg via-bg/40 to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-l from-bg/95 via-bg/45 to-transparent" />
      </div>
      <div className="absolute inset-x-0 bottom-0 px-8 pb-8">
        <div className="max-w-xl space-y-4">
          <h1 className="text-4xl font-bold leading-tight text-white lg:text-5xl">
            {f.title}
          </h1>
          {f.description && (
            <p className="line-clamp-2 max-w-[65ch] text-sm leading-relaxed text-text-secondary">
              {f.description}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Link
              to={`/anime/${encodeURIComponent(f.href)}`}
              className="inline-flex items-center gap-2 rounded-full bg-accent px-6 py-3 text-sm font-bold text-black transition-colors hover:bg-accent-bright"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
              {t.watchNow}
            </Link>
            {f.genres.slice(0, 3).map((g) => (
              <span key={g} className="text-xs font-medium text-text-muted">
                {g}
              </span>
            ))}
          </div>
        </div>
        {featured.length > 1 && (
          <div className="mt-6 flex gap-1.5">
            {featured.map((_, i) => (
              <button
                key={i}
                onClick={() => setIdx(i)}
                aria-label={`slide ${i + 1}`}
                className={`h-1 rounded-full transition-all duration-300 ${
                  i === idx ? "w-8 bg-accent" : "w-4 bg-white/25 hover:bg-white/40"
                }`}
              />
            ))}
          </div>
        )}
      </div>
      <style>{`@keyframes heroFade { from { opacity: 0 } to { opacity: 1 } }`}</style>
    </div>
  );
}

function localizedSectionTitle(id: string, fallback: string): string {
  switch (id) {
    case "trending": return t.trendingNow;
    case "recently_updated": return t.recentlyUpdated;
    case "tv_series": return t.tvSeries;
    case "movies": return t.movies;
    default: return fallback;
  }
}

// Memoized: section items are stable references from the fetch, so hero ticks
// and popup toggles skip re-rendering the whole grid.
const Section = memo(function Section({
  section, onOpenEpisode,
}: {
  section: HomeSection; onOpenEpisode: (ep: EpisodeItem) => void;
}) {
  return (
    <section className="lazy-section space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-xl font-bold text-white">
          {localizedSectionTitle(section.id, section.title)}
        </h2>
        <Link
          to={`/see-all/${section.id}`}
          className="text-xs font-semibold text-accent transition-colors hover:text-accent-bright"
        >
          {t.seeAllShort} ←
        </Link>
      </div>
      {section.type === "anime" ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {(section.items as AnimeItem[]).slice(0, 12).map((it) => (
            <AnimeCard key={it.href} item={it} />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {(section.items as EpisodeItem[]).slice(0, 12).map((it) => (
            <EpisodeCard key={it.href} episode={it} onOpen={onOpenEpisode} />
          ))}
        </div>
      )}
    </section>
  );
});
