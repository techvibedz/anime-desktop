import { useEffect, useState, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import {
  fetchEpisodes, fetchEpisodesUp4,
  type AnimeDetail, type Episode,
} from "../lib/api";
import { addFavorite, removeFavorite, favoriteListOf, type FavoriteList } from "../lib/favorites";
import { getWatchedHrefsForAnime, toggleWatched } from "../lib/history";
import { Shimmer } from "../components/Shimmer";
import { t } from "../lib/i18n";

export function AnimeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const animeHref = id ? decodeURIComponent(id) : "";
  const [data, setData] = useState<AnimeDetail | null>(null);
  const [episodes4up, setEpisodes4up] = useState<Episode[]>([]);
  const [merged, setMerged] = useState<{ anime4up: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [bookmarkList, setBookmarkList] = useState<FavoriteList | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [watched, setWatched] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setData(null); setLoading(true); setError(null);
    setEpisodes4up([]); setMerged(null);
    favoriteListOf(animeHref).then(setBookmarkList);
    getWatchedHrefsForAnime(animeHref).then(setWatched);

    // Kick off the primary scrape. As soon as it returns the up4Hint
    // (from a direct link on the wit page) we start the up4 scrape with
    // that URL — no title-search round-trip required.
    fetchEpisodes(animeHref)
      .then((res) => {
        if (cancelled) return;
        setData(res.data);
        setEpisodes4up(res.data.episodes4up || []);
        setMerged(res.data.merged || null);
        setLoading(false);

        // Enrichment in the background. Uses the hint when present, falls
        // back to title-search (still parallel — main UI is already rendered).
        fetchEpisodesUp4(animeHref, res.data.title, res.data.up4Hint)
          .then((enrich) => {
            if (cancelled) return;
            if (enrich.merged) setMerged(enrich.merged);
            if (enrich.episodes4up.length > 0) setEpisodes4up(enrich.episodes4up);
          })
          .catch(() => {});
      })
      .catch((e: any) => {
        if (!cancelled) { setError(e?.message ?? t.failedToLoad); setLoading(false); }
      });

    return () => { cancelled = true; };
  }, [id, animeHref]);

  const onBookmark = useCallback(async (list: FavoriteList) => {
    if (!data) return;
    await addFavorite({ title: data.title, href: animeHref, image: data.poster, list });
    setBookmarkList(list);
    setPickerOpen(false);
  }, [data, animeHref]);

  const onUnbookmark = useCallback(async () => {
    await removeFavorite(animeHref);
    setBookmarkList(null);
  }, [animeHref]);

  const onToggleWatched = useCallback(async (ep: Episode) => {
    if (!data || !ep.href) return;
    const next = await toggleWatched(ep.href, {
      episodeTitle: ep.title || `${t.episode} ${ep.number}`,
      animeTitle: data.title,
      animeHref,
      image: data.poster,
      url4up: pickUp4ForEpisode(ep, episodes4up) ?? undefined,
    });
    setWatched((prev) => {
      const c = new Set(prev);
      if (next) c.add(ep.href!); else c.delete(ep.href!);
      return c;
    });
  }, [data, animeHref, episodes4up]);

  if (loading) {
    const provisionalTitle = titleFromSlug(animeHref);
    return (
      <div className="space-y-6">
        <div className="relative h-[400px] w-full overflow-hidden rounded-2xl bg-surface">
          <div className="shimmer absolute inset-0" />
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-bg via-bg/60 to-transparent p-8 lg:p-12">
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-accent">{t.loading}</p>
            {provisionalTitle && (
              <h1 className="mt-2 font-display text-3xl font-extrabold leading-tight text-white lg:text-4xl">
                {provisionalTitle}
              </h1>
            )}
          </div>
        </div>
        <Shimmer className="h-6 w-1/3" />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
          {Array.from({ length: 16 }).map((_, i) => <Shimmer key={i} className="aspect-video rounded-md" />)}
        </div>
      </div>
    );
  }
  if (error || !data) {
    return <p className="text-center text-accent">{error ?? t.notFound}</p>;
  }

  return (
    <div className="space-y-8">
      <div className="relative overflow-hidden rounded-2xl">
        <div className="relative h-[400px] w-full">
          {data.banner && (
            <img src={data.banner} alt="" className="h-full w-full object-cover" />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-bg via-bg/60 to-bg/30" />
          <div className="absolute inset-0 bg-gradient-to-r from-bg via-bg/40 to-transparent" />
        </div>
        <div className="absolute inset-0 flex items-end p-8 lg:p-12">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end">
            {data.poster && (
              <img
                src={data.poster}
                alt={data.title}
                className="h-60 w-40 flex-shrink-0 rounded-lg object-cover shadow-card"
              />
            )}
            <div className="flex flex-col gap-3">
              <h1 className="font-display text-4xl font-extrabold leading-tight text-white lg:text-5xl">
                {data.title}
              </h1>
              {data.genres.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {data.genres.map((g) => (
                    <span key={g} className="rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-[11px] text-white/80">
                      {g}
                    </span>
                  ))}
                </div>
              )}
              <p className="max-w-2xl text-sm leading-relaxed text-text-secondary line-clamp-4">
                {data.synopsis}
              </p>
              <div className="flex flex-wrap items-center gap-3">
                {bookmarkList ? (
                  <button
                    onClick={onUnbookmark}
                    className="flex items-center gap-2 rounded-full bg-accent px-5 py-2 text-sm font-semibold text-white shadow-glow"
                  >
                    ♥ {t.saved} ({bookmarkList === "watching" ? t.currentlyWatching : t.planToWatch})
                  </button>
                ) : (
                  <button
                    onClick={() => setPickerOpen(true)}
                    className="flex items-center gap-2 rounded-full border border-white/15 bg-surface px-5 py-2 text-sm font-semibold text-white hover:border-accent"
                  >
                    ♡ {t.addToList}
                  </button>
                )}
                {merged?.anime4up && (
                  <span className="rounded-full border border-violet/40 bg-violet/10 px-3 py-1 text-[11px] font-semibold text-violet">
                    {t.bothSources}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <section className="space-y-3">
        <div className="flex items-end justify-between">
          <h2 className="font-display text-2xl font-bold">{t.episodes} ({data.episodes.length})</h2>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
          {data.episodes.map((ep) => {
            const isDone = ep.href ? watched.has(ep.href) : false;
            const up4 = pickUp4ForEpisode(ep, episodes4up);
            return (
              <div key={ep.href ?? `e${ep.number}`} className="relative">
                <Link
                  to={(() => {
                    const params = new URLSearchParams();
                    if (up4) params.set("up4", up4);
                    if (ep.screenshot) params.set("img", ep.screenshot);
                    params.set("anime", animeHref);
                    const q = params.toString();
                    return `/watch/${encodeURIComponent(ep.href ?? "")}${q ? `?${q}` : ""}`;
                  })()}
                  className={`group relative block aspect-video overflow-hidden rounded-md border ${
                    isDone ? "border-violet/40 opacity-70" : "border-white/10 hover:border-accent"
                  } bg-surface`}
                >
                  {ep.screenshot ? (
                    <img src={ep.screenshot} alt="" className="h-full w-full object-contain bg-black" />
                  ) : (
                    <div className="h-full w-full bg-gradient-to-br from-surface to-bg" />
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/85 to-transparent" />
                  <div className="absolute inset-x-1 bottom-1 flex items-center justify-between">
                    <span className="rounded bg-black/60 px-1.5 py-0.5 text-[11px] font-bold">
                      {t.episode} {ep.number}
                    </span>
                    {isDone && <span className="rounded bg-violet px-1.5 py-0.5 text-[10px] font-bold">✓</span>}
                  </div>
                </Link>
                <button
                  onClick={() => onToggleWatched(ep)}
                  className="absolute end-1 top-1 hidden h-6 w-6 items-center justify-center rounded-full bg-black/70 text-[11px] text-white hover:bg-accent group-hover:flex"
                  title={isDone ? "Mark unwatched" : "Mark watched"}
                >
                  {isDone ? "↶" : "✓"}
                </button>
              </div>
            );
          })}
        </div>
      </section>

      {/* Add-to-list modal — rendered outside the banner so the parent
          overflow-hidden doesn't clip it. */}
      {pickerOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm"
          onClick={() => setPickerOpen(false)}
        >
          <div
            className="w-[min(360px,92vw)] overflow-hidden rounded-2xl border border-white/10 bg-surface shadow-card"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-white/5 px-5 py-4">
              <h3 className="font-display text-base font-bold text-white">{t.addToList}</h3>
              <p className="mt-0.5 line-clamp-1 text-xs text-text-secondary">{data.title}</p>
            </div>
            <div className="space-y-1 p-2">
              <button
                onClick={() => onBookmark("watching")}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-start hover:bg-white/5"
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-accent/15 text-accent">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                </span>
                <span className="flex-1">
                  <p className="text-sm font-semibold text-white">{t.currentlyWatching}</p>
                  <p className="text-xs text-text-muted">ما تتابعه الآن</p>
                </span>
              </button>
              <button
                onClick={() => onBookmark("planned")}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-start hover:bg-white/5"
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-violet/15 text-violet">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20a2 2 0 002 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10zM9 14H7v-2h2v2zm4 0h-2v-2h2v2zm4 0h-2v-2h2v2z" /></svg>
                </span>
                <span className="flex-1">
                  <p className="text-sm font-semibold text-white">{t.planToWatch}</p>
                  <p className="text-xs text-text-muted">احفظه للاحقًا</p>
                </span>
              </button>
            </div>
            <button
              onClick={() => setPickerOpen(false)}
              className="block w-full border-t border-white/5 py-3 text-sm text-text-muted hover:text-white"
            >
              {t.cancel}
            </button>
          </div>
        </div>
      )}

    </div>
  );
}

function titleFromSlug(href: string): string {
  if (!href) return "";
  try {
    const slug = decodeURIComponent(new URL(href).pathname.replace(/\/$/, "").split("/").pop() || "");
    return slug.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

function pickUp4ForEpisode(ep: Episode, up4: Episode[]): string | null {
  if (!up4.length) return null;
  console.info(`[anime-detail] matching witanime ep ${ep.number} (${ep.title}) against ${up4.length} anime4up episodes`);
  const match = up4.find((u) => u.number === ep.number);
  if (match) {
    console.info(`[anime-detail] matched to anime4up ep ${match.number} (${match.title}) → ${match.href}`);
  } else {
    console.warn(`[anime-detail] no match found for episode ${ep.number}`);
    console.info(`[anime-detail] available anime4up episodes:`, up4.map(u => ({ num: u.number, title: u.title })));
  }
  return match?.href ?? null;
}
