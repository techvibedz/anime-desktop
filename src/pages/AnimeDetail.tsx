import { useEffect, useState, useCallback, useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import {
  fetchEpisodes, fetchEpisodesUp4,
  type AnimeDetail, type Episode,
} from "../lib/api";
import { addFavorite, removeFavorite, favoriteListOf, type FavoriteList } from "../lib/favorites";
import { getCompletedSets, isEpisodeWatched, animeTitleKey, normHref, toggleWatched, type CompletedSets } from "../lib/history";
import { recordAnimeCompletion } from "../lib/completion";
import { fetchSeriesFinished } from "../lib/airing";
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
  const [completed, setCompleted] = useState<CompletedSets>({ hrefs: new Set(), numbersByTitle: new Map() });

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setData(null); setLoading(true); setError(null);
    setEpisodes4up([]); setMerged(null);
    favoriteListOf(animeHref).then(setBookmarkList);
    getCompletedSets().then(setCompleted);

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
    await toggleWatched(ep.href, {
      episodeTitle: ep.title || `${t.episode} ${ep.number}`,
      animeTitle: data.title,
      animeHref,
      image: data.poster,
      url4up: pickUp4ForEpisode(ep, episodes4up) ?? undefined,
      epNum: ep.number ?? undefined,
    });
    // Re-read the index so both the href and per-title number sets reflect the toggle.
    getCompletedSets().then(setCompleted);
  }, [data, animeHref, episodes4up]);

  // Record this anime's completion state (caught-up / finished) for the
  // poster-card badges — synced to the cloud so the mobile app sees it too.
  // Recomputed whenever the episode lists or the watched-set change; "finished"
  // is gated on the series no longer airing (so a still-running show's latest
  // episode reads as "caught up", not "completed").
  // Derive last episode number + caught-up state. Memoized so the recording
  // effect depends on PRIMITIVES, not the `completed` object (new ref per load),
  // and toggling a non-final episode doesn't re-fire the AniList airing check.
  const { maxNum, caughtUp } = useMemo(() => {
    if (!data) return { maxNum: 0, caughtUp: false };
    const all = [...data.episodes, ...episodes4up];
    let mx = 0;
    let hasNum = false;
    for (const e of all) {
      if (e.number != null && e.number > mx) { mx = e.number; hasNum = true; }
    }
    if (!hasNum) return { maxNum: 0, caughtUp: false };
    const lastHrefs = all.filter((e) => e.number === mx).map((e) => e.href).filter(Boolean) as string[];
    return { maxNum: mx, caughtUp: isEpisodeWatched(completed, { hrefs: lastHrefs, epNum: mx, animeTitle: data.title }) };
  }, [data, episodes4up, completed]);

  // Displayed episode list = the primary source's episodes UNION the anime4up
  // episodes it's missing. anime4up frequently uploads newer episodes before
  // witanime/anime3rb, so rendering only `data.episodes` left the latest ones
  // hidden ("not full episodes"). Merge by number, keep ascending order (the
  // scrapers already sort ascending), and let anime4up-only episodes carry their
  // own href/screenshot so they open + resolve servers like any other.
  const displayEpisodes = useMemo(() => {
    if (!data) return [] as Episode[];
    const byNum = new Map<number, Episode>();
    const noNum: Episode[] = [];
    for (const e of data.episodes) {
      if (e.number != null) { if (!byNum.has(e.number)) byNum.set(e.number, e); }
      else noNum.push(e);
    }
    for (const e of episodes4up) {
      if (e.number != null && !byNum.has(e.number)) byNum.set(e.number, e);
    }
    const merged = [...byNum.values()].sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
    return [...merged, ...noNum];
  }, [data, episodes4up]);

  // The set of episode numbers watched for THIS anime (cross-source), resolved
  // ONCE instead of re-deriving the title key (NFKD + regex) inside every card.
  const watchedNumbers = useMemo(
    () => (data ? completed.numbersByTitle.get(animeTitleKey(data.title)) ?? null : null),
    [completed, data],
  );

  useEffect(() => {
    if (!data || !animeHref || maxNum === 0) return;
    let cancelled = false;
    (async () => {
      const finished = caughtUp ? await fetchSeriesFinished(data.title, maxNum) : false;
      if (cancelled) return;
      await recordAnimeCompletion({
        hrefs: [animeHref, merged?.anime4up],
        titles: [data.title],
        lastEpNum: maxNum,
        caughtUp,
        finished,
      }).catch(() => {});
    })();
    return () => { cancelled = true; };
  }, [data?.title, animeHref, merged?.anime4up, maxNum, caughtUp]);

  if (loading) {
    const provisionalTitle = titleFromSlug(animeHref);
    return (
      <div className="space-y-8">
        <div className="relative -mx-8 -mt-7 h-[440px] overflow-hidden">
          <div className="shimmer absolute inset-0" />
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-bg via-bg/60 to-transparent px-8 pb-8 pt-24">
            <p className="text-xs font-semibold text-accent">{t.loading}</p>
            {provisionalTitle && (
              <h1 className="mt-2 text-3xl font-bold leading-tight text-white lg:text-4xl">
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
    return <p className="py-20 text-center text-text-secondary">{error ?? t.notFound}</p>;
  }

  return (
    <div className="space-y-10">
      {/* Full-bleed backdrop — the artwork owns the top of the screen */}
      <div className="relative -mx-8 -mt-7">
        <div className="relative h-[440px] w-full overflow-hidden">
          {(data.banner || data.poster) && (
            <img
              src={data.banner || data.poster || ""}
              alt=""
              className="h-full w-full scale-105 object-cover blur-[2px]"
            />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-bg via-bg/55 to-bg/20" />
          <div className="absolute inset-0 bg-gradient-to-l from-bg/85 via-bg/30 to-transparent" />
        </div>
        <div className="absolute inset-x-0 bottom-0 flex items-end gap-6 px-8 pb-6">
          {data.poster && (
            <img
              src={data.poster}
              alt={data.title}
              className="hidden h-64 w-44 flex-shrink-0 rounded-xl object-cover shadow-card md:block"
            />
          )}
          <div className="flex min-w-0 flex-col gap-3 pb-1">
            <h1 className="text-3xl font-bold leading-tight text-white lg:text-5xl">
              {data.title}
            </h1>
            {data.genres.length > 0 && (
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {data.genres.map((g) => (
                  <span key={g} className="text-xs font-medium text-text-secondary">{g}</span>
                ))}
              </div>
            )}
            <p className="line-clamp-3 max-w-[65ch] text-sm leading-relaxed text-text-secondary">
              {data.synopsis}
            </p>
            <div className="flex flex-wrap items-center gap-3">
              {bookmarkList ? (
                <button
                  onClick={onUnbookmark}
                  className="flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-sm font-bold text-black transition-colors hover:bg-accent-bright"
                >
                  ♥ {t.saved} ({bookmarkList === "watching" ? t.currentlyWatching : t.planToWatch})
                </button>
              ) : (
                <button
                  onClick={() => setPickerOpen(true)}
                  className="flex items-center gap-2 rounded-full border border-white/15 bg-black/40 px-5 py-2.5 text-sm font-bold text-white transition-colors hover:border-accent hover:text-accent"
                >
                  ♡ {t.addToList}
                </button>
              )}
              {merged?.anime4up && (
                <span className="rounded-full bg-violet/20 px-3 py-1 text-[11px] font-semibold text-white">
                  {t.bothSources}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      <section className="space-y-4">
        <h2 className="text-xl font-bold text-white">{t.episodes} ({displayEpisodes.length})</h2>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:grid-cols-8">
          {displayEpisodes.map((ep) => {
            // Cheap per-card check (no NFKD): href membership OR the precomputed
            // cross-source episode-number set.
            const isDone =
              (!!ep.href && completed.hrefs.has(normHref(ep.href))) ||
              (ep.number != null && !!watchedNumbers?.has(ep.number));
            const up4 = pickUp4ForEpisode(ep, episodes4up);
            return (
              <div key={ep.href ?? `e${ep.number}`} className="group relative">
                <Link
                  to={(() => {
                    const params = new URLSearchParams();
                    if (up4) params.set("up4", up4);
                    if (ep.screenshot) params.set("img", ep.screenshot);
                    params.set("anime", animeHref);
                    const q = params.toString();
                    return `/watch/${encodeURIComponent(ep.href ?? "")}${q ? `?${q}` : ""}`;
                  })()}
                  className={`relative block aspect-video overflow-hidden rounded-lg bg-surface ring-1 transition ${
                    isDone ? "opacity-60 ring-accent/40" : "ring-white/5 hover:ring-accent/60"
                  }`}
                >
                  {ep.screenshot ? (
                    <img src={ep.screenshot} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
                  ) : (
                    <div className="h-full w-full bg-gradient-to-br from-raised to-surface" />
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent" />
                  <div className="absolute inset-x-1.5 bottom-1.5 flex items-center justify-between">
                    <span className="rounded bg-black/60 px-1.5 py-0.5 text-[11px] font-bold text-white">
                      {t.episode} {ep.number}
                    </span>
                    {isDone && <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] font-bold text-black">✓</span>}
                  </div>
                </Link>
                <button
                  onClick={() => onToggleWatched(ep)}
                  className="absolute end-1.5 top-1.5 hidden h-6 w-6 items-center justify-center rounded-full bg-black/70 text-[11px] text-white transition-colors hover:bg-accent hover:text-black group-hover:flex"
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
          className="fixed inset-0 z-modal flex items-center justify-center bg-black/75"
          onClick={() => setPickerOpen(false)}
        >
          <div
            className="w-[min(360px,92vw)] overflow-hidden rounded-2xl border border-white/10 bg-surface shadow-card"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-white/5 px-5 py-4">
              <h3 className="text-base font-bold text-white">{t.addToList}</h3>
              <p className="mt-0.5 line-clamp-1 text-xs text-text-secondary">{data.title}</p>
            </div>
            <div className="space-y-1 p-2">
              <button
                onClick={() => onBookmark("watching")}
                className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-start transition-colors hover:bg-white/5"
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
                className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-start transition-colors hover:bg-white/5"
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-violet/20 text-white">
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
              className="block w-full border-t border-white/5 py-3 text-sm text-text-muted transition-colors hover:text-white"
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
  return up4.find((u) => u.number === ep.number)?.href ?? null;
}
