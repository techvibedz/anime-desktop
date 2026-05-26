import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchHome, type HomeSection, type FeaturedItem, type AnimeItem, type EpisodeItem } from "../lib/api";
import { AnimeCard, EpisodeCard } from "../components/AnimeCard";
import { EpisodeActionModal } from "../components/EpisodeActionModal";
import { Shimmer } from "../components/Shimmer";
import { getHistory, removeFromHistory, type WatchEntry } from "../lib/history";
import { t } from "../lib/i18n";

export function HomePage() {
  const [featured, setFeatured] = useState<FeaturedItem[]>([]);
  const [sections, setSections] = useState<HomeSection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [featuredIdx, setFeaturedIdx] = useState(0);
  const [episodePopup, setEpisodePopup] = useState<EpisodeItem | null>(null);
  const [history, setHistory] = useState<WatchEntry[]>([]);

  useEffect(() => {
    setLoading(true);
    fetchHome()
      .then((r) => {
        setFeatured(r.data.featured);
        setSections(r.data.sections.filter((s) => s.id !== "tv_series"));
      })
      .catch((e) => setError(e?.message ?? t.failedToLoad))
      .finally(() => setLoading(false));

    getHistory().then((h) => setHistory(h.filter((w) => !w.completed).slice(0, 10)));
  }, []);

  useEffect(() => {
    if (featured.length < 2) return;
    const id = setInterval(() => setFeaturedIdx((i) => (i + 1) % featured.length), 6000);
    return () => clearInterval(id);
  }, [featured.length]);

  if (loading && sections.length === 0) {
    return (
      <div className="space-y-8">
        <Shimmer className="h-[420px] w-full rounded-2xl" />
        <div className="space-y-3">
          <Shimmer className="h-6 w-48" />
          <div className="grid grid-cols-6 gap-4">
            {Array.from({ length: 6 }).map((_, i) => <Shimmer key={i} className="aspect-[2/3]" />)}
          </div>
        </div>
      </div>
    );
  }

  if (error) return <p className="text-center text-accent">{error}</p>;

  const f = featured[featuredIdx];

  return (
    <div className="space-y-10">
      {f && (
        <div className="relative overflow-hidden rounded-2xl">
          <div className="relative aspect-[16/6] w-full">
            {f.image && (
              <img key={f.image} src={f.image} alt={f.title} className="h-full w-full object-contain bg-black transition-opacity duration-500" />
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-bg via-bg/60 to-transparent" />
            <div className="absolute inset-0 bg-gradient-to-l from-bg/90 via-bg/30 to-transparent" />
          </div>
          <div className="absolute inset-x-0 bottom-0 p-8 lg:p-12">
            <div className="max-w-xl space-y-3">
              <p className="text-xs font-bold uppercase tracking-[0.2em] text-accent">{t.featured}</p>
              <h1 className="font-display text-3xl font-extrabold leading-tight text-white lg:text-5xl">
                {f.title}
              </h1>
              {f.description && (
                <p className="line-clamp-3 text-sm text-text-secondary">{f.description}</p>
              )}
              {f.genres.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {f.genres.slice(0, 4).map((g) => (
                    <span key={g} className="rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-[11px] text-white/80">
                      {g}
                    </span>
                  ))}
                </div>
              )}
              <Link
                to={`/anime/${encodeURIComponent(f.href)}`}
                className="inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white shadow-glow hover:brightness-110"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                {t.watchNow}
              </Link>
            </div>
          </div>
          {featured.length > 1 && (
            <div className="absolute bottom-4 start-6 flex gap-1.5">
              {featured.map((_, i) => (
                <button
                  key={i}
                  onClick={() => setFeaturedIdx(i)}
                  className={`h-1.5 rounded-full transition-all ${
                    i === featuredIdx ? "w-8 bg-accent" : "w-1.5 bg-white/30"
                  }`}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {history.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-display text-xl font-bold text-white">{t.continueWatching}</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {history.map((w) => (
              <Link
                key={w.episodeHref}
                to={`/watch/${encodeURIComponent(w.episodeHref)}${w.animeHref ? `?anime=${encodeURIComponent(w.animeHref)}` : ""}${w.image && !w.animeHref ? `?img=${encodeURIComponent(w.image)}` : ""}${w.url4up ? `&up4=${encodeURIComponent(w.url4up)}` : ""}`}
                className="group block"
              >
                <div className="relative aspect-[2/3] overflow-hidden rounded-lg bg-surface">
                  <button
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      removeFromHistory(w.episodeHref);
                      setHistory((prev) => prev.filter((h) => h.episodeHref !== w.episodeHref));
                    }}
                    className="absolute end-1 top-1 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-white/70 backdrop-blur-sm transition hover:bg-red-600 hover:text-white"
                    title="Remove"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                  {w.image ? (
                    <img src={w.image} alt={w.animeTitle || w.episodeTitle} className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105" loading="lazy" />
                  ) : (
                    <div className="h-full w-full shimmer" />
                  )}
                  <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/90 to-transparent" />
                  {/* Progress bar */}
                  {w.durationMs > 0 && (
                    <div className="absolute inset-x-0 bottom-0 h-1 bg-white/20">
                      <div
                        className="h-full bg-accent"
                        style={{ width: `${Math.min(100, Math.round((w.positionMs / w.durationMs) * 100))}%` }}
                      />
                    </div>
                  )}
                  <div className="absolute inset-x-0 bottom-1 p-2.5">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-accent/90">
                      {w.animeTitle || ""}
                    </p>
                    <h3 className="line-clamp-2 text-[13px] font-semibold leading-tight text-white">
                      {w.episodeTitle}
                    </h3>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      {sections.map((s) => (
        <Section key={s.id} section={s} onOpenEpisode={setEpisodePopup} />
      ))}

      <EpisodeActionModal episode={episodePopup} onClose={() => setEpisodePopup(null)} />
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

function Section({
  section, onOpenEpisode,
}: {
  section: HomeSection; onOpenEpisode: (ep: EpisodeItem) => void;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between">
        <h2 className="font-display text-xl font-bold text-white">
          {localizedSectionTitle(section.id, section.title)}
        </h2>
        <Link
          to={`/see-all/${section.id}`}
          className="text-xs font-semibold uppercase tracking-wider text-accent hover:underline"
        >
          {t.seeAllShort} ←
        </Link>
      </div>
      {section.type === "anime" ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {(section.items as AnimeItem[]).slice(0, 12).map((it) => (
            <AnimeCard key={it.href} item={it} />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {(section.items as EpisodeItem[]).slice(0, 12).map((it) => (
            <EpisodeCard key={it.href} episode={it} onOpen={onOpenEpisode} />
          ))}
        </div>
      )}
    </section>
  );
}
