import { useEffect, useState, useCallback, useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import {
  fetchEpisodes, fetchEpisodesUp4, fetchAnime3rbEpisodes,
  type AnimeDetail, type Episode,
} from "../lib/api";
import { addFavorite, removeFavorite, favoriteListOf, type FavoriteList } from "../lib/favorites";
import { getCompletedSets, isEpisodeWatched, animeTitleKey, normHref, toggleWatched, type CompletedSets } from "../lib/history";
import { recordAnimeCompletion } from "../lib/completion";
import { fetchSeriesFinished } from "../lib/airing";
import { Shimmer } from "../components/Shimmer";
import { DownloadPicker } from "../components/DownloadPicker";
import type { DownloadMeta } from "../lib/downloads";
import { t } from "../lib/i18n";

type SourceId = "witanime" | "anime4up" | "anime3rb";
type GridEpisode = Episode & {
  href4up: string | null;
  href3rb: string | null;
  sources: SourceId[];
};

export function AnimeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const animeHref = id ? decodeURIComponent(id) : "";
  const [data, setData] = useState<AnimeDetail | null>(null);
  const [episodes4up, setEpisodes4up] = useState<Episode[]>([]);
  const [episodes3rb, setEpisodes3rb] = useState<Episode[]>([]);
  const [merged, setMerged] = useState<{ anime4up: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [bookmarkList, setBookmarkList] = useState<FavoriteList | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [downloadMeta, setDownloadMeta] = useState<DownloadMeta | null>(null);
  const [completed, setCompleted] = useState<CompletedSets>({ hrefs: new Set(), numbersByTitle: new Map() });

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setData(null); setLoading(true); setError(null);
    setEpisodes4up([]); setEpisodes3rb([]); setMerged(null);
    favoriteListOf(animeHref).then(setBookmarkList);
    getCompletedSets().then(setCompleted);

    // Kick off the primary scrape. As soon as it returns the up4Hint
    // (from a direct link on the wit page) we start the up4 scrape with
    // that URL — no title-search round-trip required.
    // onUpdated fires when the background revalidation finds visibly newer
    // data (a newly-aired episode) — the list refreshes itself, no reload.
    // Only `data` is replaced: episodes4up/merged are enriched separately and
    // a fresh payload carries none, so touching them would clear the union.
    fetchEpisodes(animeHref, (fresh) => {
      if (cancelled) return;
      setData(fresh.data);
    })
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

  // Mobile parity: Anime3rb contributes a third, independent episode list.
  // Resolve it after the primary detail has painted so it never delays opening
  // the page. An Anime3rb-primary page already owns that list, so skip it.
  useEffect(() => {
    if (!data?.title || /anime3rb\.com/i.test(animeHref)) return;
    let cancelled = false;
    fetchAnime3rbEpisodes(data.title)
      .then((episodes) => {
        if (!cancelled && episodes.length > 0) setEpisodes3rb(episodes);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [data?.title, animeHref]);

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

  const onToggleWatched = useCallback(async (ep: GridEpisode) => {
    const primary = ep.href || ep.href4up || ep.href3rb;
    if (!data || !primary) return;
    await toggleWatched(primary, {
      episodeTitle: ep.title || `${t.episode} ${ep.number}`,
      animeTitle: data.title,
      animeHref,
      image: data.poster,
      url4up: ep.href4up ?? undefined,
      epNum: ep.number ?? undefined,
    });
    // Re-read the index so both the href and per-title number sets reflect the toggle.
    getCompletedSets().then(setCompleted);
  }, [data, animeHref]);

  const onDownload = useCallback((ep: GridEpisode) => {
    if (!data) return;
    const primary = ep.href || ep.href4up || ep.href3rb;
    if (!primary) return;
    setDownloadMeta({
      animeTitle: data.title,
      episodeTitle: ep.title || `${t.episode} ${ep.number}`,
      epNum: ep.number ?? null,
      image: ep.screenshot || data.poster || "",
      animeHref,
      episodeHref: primary,
      url4up: ep.href4up || undefined,
      url3rb: ep.href3rb || undefined,
    });
  }, [data, animeHref]);

  // A title-based secondary lookup can resolve a different season/cour. Match
  // the mobile app's trust guard: require overlap with the opened page and
  // clamp secondaries to its episode-number range. When the primary list is
  // empty, keep the secondary lists because they are the only usable data.
  const trusted = useMemo(
    () => trustedSources(data?.episodes ?? [], episodes4up, episodes3rb),
    [data?.episodes, episodes4up, episodes3rb],
  );

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
    const all = [...data.episodes, ...trusted.up4, ...trusted.a3rb];
    let mx = 0;
    let hasNum = false;
    for (const e of all) {
      if (e.number != null && e.number > mx) { mx = e.number; hasNum = true; }
    }
    if (!hasNum) return { maxNum: 0, caughtUp: false };
    const lastHrefs = all.filter((e) => e.number === mx).map((e) => e.href).filter(Boolean) as string[];
    return { maxNum: mx, caughtUp: isEpisodeWatched(completed, { hrefs: lastHrefs, epNum: mx, animeTitle: data.title }) };
  }, [data, trusted, completed]);

  // Union all three trusted episode lists by number. Each grid entry retains
  // every source href, so the player can start with the best available primary
  // and layer servers from the other two sources on top.
  const displayEpisodes = useMemo(() => {
    if (!data) return [] as GridEpisode[];
    const byNum = new Map<number, GridEpisode>();
    const ensure = (episode: Episode): GridEpisode => {
      let item = byNum.get(episode.number);
      if (!item) {
        item = { ...episode, href: null, href4up: null, href3rb: null, sources: [] };
        byNum.set(episode.number, item);
      }
      return item;
    };
    const addSource = (item: GridEpisode, source: SourceId) => {
      if (!item.sources.includes(source)) item.sources.push(source);
    };
    for (const episode of data.episodes) {
      const item = ensure(episode);
      item.href = episode.href ?? item.href;
      item.title = episode.title || item.title;
      if (episode.type) item.type = episode.type;
      if (episode.screenshot) item.screenshot = episode.screenshot;
      const source = sourceOfHref(episode.href || animeHref);
      addSource(item, source);
      if (source === "anime4up") item.href4up = episode.href;
      if (source === "anime3rb") item.href3rb = episode.href;
    }
    for (const episode of trusted.up4) {
      const item = ensure(episode);
      item.href4up = episode.href || item.href4up;
      if (!item.screenshot && episode.screenshot) item.screenshot = episode.screenshot;
      addSource(item, "anime4up");
    }
    for (const episode of trusted.a3rb) {
      const item = ensure(episode);
      item.href3rb = episode.href || item.href3rb;
      if (!item.screenshot && episode.screenshot) item.screenshot = episode.screenshot;
      addSource(item, "anime3rb");
    }
    return [...byNum.values()].sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
  }, [data, trusted, animeHref]);

  const availableSources = useMemo(() => {
    const found = new Set<SourceId>([sourceOfHref(animeHref)]);
    if (trusted.up4.length > 0) found.add("anime4up");
    if (trusted.a3rb.length > 0) found.add("anime3rb");
    return (["witanime", "anime4up", "anime3rb"] as SourceId[]).filter((source) => found.has(source));
  }, [animeHref, trusted]);

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
              {availableSources.map((source) => (
                <span key={source} className="rounded-full bg-violet/20 px-3 py-1 text-[11px] font-semibold text-white">
                  {sourceLabel(source)}
                </span>
              ))}
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
              (!!ep.href4up && completed.hrefs.has(normHref(ep.href4up))) ||
              (!!ep.href3rb && completed.hrefs.has(normHref(ep.href3rb))) ||
              (ep.number != null && !!watchedNumbers?.has(ep.number));
            const primary = ep.href || ep.href4up || ep.href3rb || "";
            // Anime4up and Anime3rb episode indexes usually do not publish a
            // per-episode screenshot. Match mobile: use the anime poster as the
            // artwork fallback, and also fall back to it when a supplied remote
            // screenshot fails to load.
            const artwork = ep.screenshot || data.poster;
            return (
              <div key={`${ep.number}-${primary}`} className="group relative">
                <Link
                  to={(() => {
                    const params = new URLSearchParams();
                    if (ep.href4up && ep.href4up !== primary) params.set("up4", ep.href4up);
                    if (ep.href3rb && ep.href3rb !== primary) params.set("a3rb", ep.href3rb);
                    if (artwork) params.set("img", artwork);
                    params.set("anime", animeHref);
                    params.set("title", data.title);
                    params.set("ep", String(ep.number));
                    const q = params.toString();
                    return `/watch/${encodeURIComponent(primary)}${q ? `?${q}` : ""}`;
                  })()}
                  className={`relative block aspect-video overflow-hidden rounded-lg bg-surface ring-1 transition ${
                    isDone ? "opacity-60 ring-accent/40" : "ring-white/5 hover:ring-accent/60"
                  }`}
                >
                  <div className="absolute inset-0 bg-gradient-to-br from-raised to-surface" />
                  {artwork && (
                    <img
                      src={artwork}
                      alt={`${data.title} — ${t.episode} ${ep.number}`}
                      loading="lazy"
                      decoding="async"
                      referrerPolicy="no-referrer"
                      className="absolute inset-0 h-full w-full object-cover"
                      onError={(event) => {
                        const image = event.currentTarget;
                        if (data.poster && image.dataset.posterFallback !== "1") {
                          image.dataset.posterFallback = "1";
                          image.src = data.poster;
                        } else {
                          image.style.display = "none";
                        }
                      }}
                    />
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent" />
                  <div className="absolute start-1.5 top-1.5 flex gap-1">
                    {ep.sources.map((source) => (
                      <span key={source} className="rounded bg-black/70 px-1 py-0.5 text-[8px] font-bold uppercase text-white/80">
                        {sourceShortLabel(source)}
                      </span>
                    ))}
                  </div>
                  <div className="absolute inset-x-1.5 bottom-1.5 flex items-center justify-between">
                    <span className="rounded bg-black/60 px-1.5 py-0.5 text-[11px] font-bold text-white">
                      {t.episode} {ep.number}
                    </span>
                    {isDone && <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] font-bold text-black">✓</span>}
                  </div>
                </Link>
                <div className="absolute end-1.5 top-1.5 hidden flex-col gap-1 group-hover:flex">
                  <button
                    onClick={() => onDownload(ep)}
                    className="flex h-6 w-6 items-center justify-center rounded-full bg-black/75 text-white transition-colors hover:bg-accent hover:text-black"
                    title={t.downloadEpisode}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55l3.3-3.3 1.4 1.4L12 17.4l-4.7-4.75 1.4-1.4 3.3 3.3V3h2zM5 19h14v2H5z" /></svg>
                  </button>
                  <button
                    onClick={() => onToggleWatched(ep)}
                    className="flex h-6 w-6 items-center justify-center rounded-full bg-black/75 text-[11px] text-white transition-colors hover:bg-accent hover:text-black"
                    title={isDone ? "Mark unwatched" : "Mark watched"}
                  >
                    {isDone ? "↶" : "✓"}
                  </button>
                </div>
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

      <DownloadPicker
        visible={downloadMeta !== null}
        meta={downloadMeta}
        onClose={() => setDownloadMeta(null)}
      />

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

function sourceOfHref(href: string): SourceId {
  if (/anime3rb\.com/i.test(href)) return "anime3rb";
  if (/anime4up/i.test(href)) return "anime4up";
  return "witanime";
}

function sourceLabel(source: SourceId): string {
  if (source === "anime4up") return "Anime4up";
  if (source === "anime3rb") return "Anime3rb";
  return "WitAnime";
}

function sourceShortLabel(source: SourceId): string {
  if (source === "anime4up") return "4up";
  if (source === "anime3rb") return "3rb";
  return "wit";
}

function trustedSources(
  anchor: Episode[],
  up4: Episode[],
  a3rb: Episode[],
): { up4: Episode[]; a3rb: Episode[] } {
  const anchorNums = new Set<number>();
  for (const episode of anchor) {
    if (episode.number != null) anchorNums.add(episode.number);
  }
  if (anchorNums.size === 0) return { up4, a3rb };

  let min = Infinity;
  let max = -Infinity;
  for (const number of anchorNums) {
    min = Math.min(min, number);
    max = Math.max(max, number);
  }

  const clamp = (episodes: Episode[]) => {
    const overlaps = episodes.some(
      (episode) => episode.number != null && anchorNums.has(episode.number),
    );
    if (!overlaps) return [];
    return episodes.filter(
      (episode) => episode.number != null && episode.number >= min && episode.number <= max,
    );
  };

  return { up4: clamp(up4), a3rb: clamp(a3rb) };
}
