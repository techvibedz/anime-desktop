import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useParams, Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  fetchEpisodes, fetchEpisodesUp4, fetchAnime3rbEpisodes,
  findAnime3rbAnimeUrl, findWitanimeAnimeUrl, findAnime4upAnimeUrl,
  type AnimeDetail, type Episode,
} from "../lib/api";
import { addFavorite, removeFavorite, favoriteListOf, type FavoriteList } from "../lib/favorites";
import { getCompletedSets, getHistory, isCompleted as isEntryCompleted, isEpisodeWatched, isEpisodeTracked, animeTitleKey, normAnimeKey, normHref, toggleWatched, type CompletedSets, type WatchEntry } from "../lib/history";
import { extractEpisodeNumber } from "../lib/episode-utils";
import { recordAnimeCompletion, setAnimeMarkedCompleted, useAnimeCompletion } from "../lib/completion";
import {
  fetchAnimeMal, fetchAnimeInfo, fetchAnimeRecommendations, peekMalRating,
  type AnimeInfoField, type RecItem,
} from "../lib/malInfo";
import { fetchAnimeRelations, type RelatedAnimeEntry } from "../lib/relations";
import { resolveSourceUrl } from "../lib/schedule";
import { useCardLayout } from "../lib/cardLayout";
import { MalScoreBadge, MalCardBadge } from "../components/MalRating";
import { AiringCountdown } from "../components/AiringCountdown";
import { CardLayoutControl } from "../components/CardLayoutControl";
import { ShareCard } from "../components/ShareCard";
import { Shimmer } from "../components/Shimmer";
import { Pill, PosterFrame } from "../components/AnimeCard";
import { DownloadPicker } from "../components/DownloadPicker";
import type { DownloadMeta } from "../lib/downloads";
import { t } from "../lib/i18n";

type SourceId = "witanime" | "anime4up" | "anime3rb";
type TabKey = "episodes" | "related" | "maylike" | "info";
type GridEpisode = Episode & {
  href4up: string | null;
  href3rb: string | null;
  sources: SourceId[];
};

function copyToClipboard(text: string) {
  try {
    void navigator.clipboard?.writeText(text)?.catch(() => {});
  } catch {}
}

export function AnimeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const autoPlay = searchParams.get("play") === "1";
  const animeHref = id ? decodeURIComponent(id) : "";
  const [lastWatched, setLastWatched] = useState<WatchEntry | null>(null);
  const [lastWatchedLoaded, setLastWatchedLoaded] = useState(false);
  const [data, setData] = useState<AnimeDetail | null>(null);
  const [episodes4up, setEpisodes4up] = useState<Episode[]>([]);
  const [episodes3rb, setEpisodes3rb] = useState<Episode[]>([]);
  const [merged, setMerged] = useState<{ anime4up: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [bookmarkList, setBookmarkList] = useState<FavoriteList | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [downloadMeta, setDownloadMeta] = useState<DownloadMeta | null>(null);
  const [setsLoaded, setSetsLoaded] = useState(false);
  const [completed, setCompleted] = useState<CompletedSets>({ hrefs: new Set(), numbersByTitle: new Map(), knownNumbersByTitle: new Map(), knownHrefs: new Set() });

  // Tabs + hero extras (mobile parity: app/anime/[id].tsx).
  const [activeTab, setActiveTab] = useState<TabKey>("episodes");
  const [malScore, setMalScore] = useState<number | null>(null);
  const [relations, setRelations] = useState<RelatedAnimeEntry[] | null>(null);
  const [recs, setRecs] = useState<RecItem[] | null>(null);
  const [resolvingKey, setResolvingKey] = useState<string | null>(null);
  const [titleCopied, setTitleCopied] = useState(false);
  const [posterOpen, setPosterOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  // Mobile parity: episode-number jump box (app/anime/[id].tsx EpisodesTab).
  const [episodeQuery, setEpisodeQuery] = useState("");
  const [jumpError, setJumpError] = useState(false);
  const [highlightedEpisode, setHighlightedEpisode] = useState<number | null>(null);
  const episodeRefs = useRef(new Map<number, HTMLDivElement | null>());

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setData(null); setLoading(true); setError(null);
    setEpisodes4up([]); setEpisodes3rb([]); setMerged(null);
    // This route component is reused across /anime/:id navigations (unlike a
    // fresh mobile screen), so reset per-anime UI state explicitly.
    setActiveTab("episodes");
    setMalScore(null); setRelations(null); setRecs(null); setResolvingKey(null);
    setEpisodeQuery(""); setJumpError(false); setHighlightedEpisode(null);
    episodeRefs.current.clear();
    favoriteListOf(animeHref).then(setBookmarkList);
    setSetsLoaded(false);
    getCompletedSets().then((sets) => { if (!cancelled) { setCompleted(sets); setSetsLoaded(true); } });
    setLastWatched(null);
    setLastWatchedLoaded(false);

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
  }, [id, animeHref, retryNonce]);

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

  // MAL score for the hero badge (mobile: peekMalRating + fetchAnimeMal).
  useEffect(() => {
    if (!data?.title) return;
    const peeked = peekMalRating(data.title);
    if (peeked !== undefined) setMalScore(peeked);
    let cancelled = false;
    fetchAnimeMal(data.title)
      .then((mal) => { if (!cancelled) setMalScore(mal.score); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [data?.title]);

  // Related + "you may like" rails, resolved after the page has painted.
  // Desktop adaptation: AniList relations + AniList community recommendations
  // (no Witanime rails here); each card is resolved to a playable source on tap.
  useEffect(() => {
    if (!data?.title) return;
    let cancelled = false;
    setRelations(null);
    fetchAnimeRelations(data.title, animeHref)
      .then((entries) => { if (!cancelled) setRelations(entries); })
      .catch(() => { if (!cancelled) setRelations([]); });
    return () => { cancelled = true; };
  }, [data?.title, animeHref]);

  useEffect(() => {
    if (!data?.title) return;
    let cancelled = false;
    setRecs(null);
    fetchAnimeRecommendations(data.title, animeHref)
      .then((items) => { if (!cancelled) setRecs(items); })
      .catch(() => { if (!cancelled) setRecs([]); });
    return () => { cancelled = true; };
  }, [data?.title, animeHref]);

  // Escape closes the full-screen poster viewer.
  useEffect(() => {
    if (!posterOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setPosterOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [posterOpen]);

  // Related / you-may-like tap: resolve the card title to a playable source
  // page (same pattern as Schedule), else fall back to a search for the title.
  const openResolved = useCallback(async (key: string, title: string) => {
    if (resolvingKey) return;
    setResolvingKey(key);
    const url = await resolveSourceUrl(title).catch(() => null);
    setResolvingKey(null);
    if (url) navigate(`/anime/${encodeURIComponent(url)}`);
    else navigate(`/search?q=${encodeURIComponent(title)}`);
  }, [resolvingKey, navigate]);

  const onCopyTitle = useCallback(() => {
    if (!data?.title) return;
    copyToClipboard(data.title);
    setTitleCopied(true);
    window.setTimeout(() => setTitleCopied(false), 1500);
  }, [data?.title]);

  // Mobile parity: jump to an episode by number. Accepts Latin and
  // Arabic-Indic digits; empty or non-numeric input is a no-op.
  const jumpToEpisode = useCallback(() => {
    const normalized = episodeQuery
      .trim()
      .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
      .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)));
    const wanted = Number(normalized);
    if (!Number.isInteger(wanted) || wanted <= 0) return;
    const target = episodeRefs.current.get(wanted);
    if (!target) {
      setJumpError(true);
      setHighlightedEpisode(null);
      return;
    }
    setJumpError(false);
    setHighlightedEpisode(wanted);
    target.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [episodeQuery]);

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
  const { maxNum, caughtUp, lastTracked } = useMemo(() => {
    if (!data) return { maxNum: 0, caughtUp: false, lastTracked: false };
    const all = [...data.episodes, ...trusted.up4, ...trusted.a3rb];
    let mx = 0;
    let hasNum = false;
    for (const e of all) {
      if (e.number != null && e.number > mx) { mx = e.number; hasNum = true; }
    }
    if (!hasNum) return { maxNum: 0, caughtUp: false, lastTracked: false };
    const lastHrefs = all.filter((e) => e.number === mx).map((e) => e.href).filter(Boolean) as string[];
    const last = { hrefs: lastHrefs, epNum: mx, animeTitle: data.title };
    return { maxNum: mx, caughtUp: isEpisodeWatched(completed, last), lastTracked: isEpisodeTracked(completed, last) };
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

  // The newest history entry for this anime (any source) — drives "Resume".
  useEffect(() => {
    if (!data?.title) return;
    let alive = true;
    const titleKey = animeTitleKey(data.title);
    const hrefKey = normAnimeKey(animeHref);
    getHistory().then((list) => {
      if (!alive) return;
      const mine = list.filter((e) => (titleKey && animeTitleKey(e.animeTitle) === titleKey) || (hrefKey && normAnimeKey(e.animeHref) === hrefKey));
      setLastWatched(mine.sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null);
      setLastWatchedLoaded(true);
    }).catch(() => { if (alive) setLastWatchedLoaded(true); });
    return () => { alive = false; };
  }, [data?.title, animeHref, completed]);

  const watchUrlFor = useCallback((ep: GridEpisode, primaryOverride?: string | null) => {
    // Resuming reopens the exact URL the progress was saved under — the player
    // looks the position up by href, so another source's copy restarts at 0.
    const primary = primaryOverride || ep.href || ep.href4up || ep.href3rb || "";
    const params = new URLSearchParams();
    if (ep.href4up && ep.href4up !== primary) params.set("up4", ep.href4up);
    if (ep.href3rb && ep.href3rb !== primary) params.set("a3rb", ep.href3rb);
    const artwork = ep.screenshot || data?.poster;
    if (artwork) params.set("img", artwork);
    params.set("anime", animeHref);
    if (data?.title) params.set("title", data.title);
    params.set("ep", String(ep.number));
    return `/watch/${encodeURIComponent(primary)}?${params.toString()}`;
  }, [animeHref, data?.title, data?.poster]);

  // Mirrors mobile: the completion store keeps one record per source page and
  // confirms "finished" against AniList itself, so the page only reports what
  // it sees. lastTracked=false (the finale aged out of the capped history)
  // must not erase an earned badge. Waits for the watched-set to load.
  useEffect(() => {
    if (!data || !animeHref || maxNum === 0 || !setsLoaded) return;
    void recordAnimeCompletion({ hrefs: [animeHref, merged?.anime4up], titles: [data.title], lastEpNum: maxNum, caughtUp, lastTracked }).catch(() => {});
  }, [data?.title, animeHref, merged?.anime4up, maxNum, caughtUp, lastTracked, setsLoaded]);

  // "I've finished this" — for anime watched before the app / elsewhere. Saved
  // to the account (anime_completion.marked_completed, shared with mobile) and
  // hides the anime from Continue Watching.
  const completion = useAnimeCompletion([animeHref, merged?.anime4up], [data?.title]);
  const isCompleted = !!completion?.finished;
  const isMarked = !!completion?.marked;
  const [completedToast, setCompletedToast] = useState<string | null>(null);
  const toggleCompleted = useCallback(() => {
    if (!data || !animeHref) return;
    const flash = (msg: string) => {
      setCompletedToast(msg);
      window.setTimeout(() => setCompletedToast((cur) => (cur === msg ? null : cur)), 1800);
    };
    if (isCompleted && !isMarked) { flash(t.completedFromHistory); return; }
    const marked = !isMarked;
    flash(marked ? t.markedCompleted : t.unmarkedCompleted);
    void setAnimeMarkedCompleted({
      hrefs: [animeHref, merged?.anime4up],
      titles: [data.title],
      image: data.poster,
      lastEpNum: maxNum,
      marked,
      caughtUp,
      lastTracked,
    }).catch(() => {});
  }, [data, animeHref, merged?.anime4up, isCompleted, isMarked, maxNum, caughtUp, lastTracked]);

  // "Resume" target: the last episode in progress, else the one after the
  // newest finished episode, else episode 1 (three clicks to playing).
  const playTarget = useMemo(() => {
    if (displayEpisodes.length === 0) return null;
    const sorted = [...displayEpisodes].sort((a, b) => a.number - b.number);
    const lastNum = lastWatched ? (lastWatched.epNum ?? extractEpisodeNumber(lastWatched.episodeHref, lastWatched.episodeTitle)) : null;
    if (lastWatched && lastNum != null) {
      const current = sorted.find((e) => e.number === lastNum);
      if (current && !isEntryCompleted(lastWatched)) {
        const pct = lastWatched.durationMs > 0 ? lastWatched.positionMs / lastWatched.durationMs : 0;
        return { ep: current, mode: pct > 0.02 ? "resume" as const : "play" as const, href: lastWatched.episodeHref };
      }
      const next = sorted.find((e) => e.number > lastNum);
      if (next) return { ep: next, mode: "next" as const, href: null };
      if (current) return { ep: current, mode: "rewatch" as const, href: null };
    }
    return { ep: sorted[0], mode: "start" as const, href: null };
  }, [displayEpisodes, lastWatched]);

  // Hero "Watch now" lands here with ?play=1 — start the target episode as soon
  // as the list resolves (replace, so Back returns to the home feed).
  const autoPlayedRef = useRef(false);
  useEffect(() => {
    if (!autoPlay || autoPlayedRef.current || !playTarget || !setsLoaded || !lastWatchedLoaded) return;
    autoPlayedRef.current = true;
    navigate(watchUrlFor(playTarget.ep, playTarget.href), { replace: true });
  }, [autoPlay, playTarget, setsLoaded, lastWatchedLoaded, navigate, watchUrlFor]);
  useEffect(() => { autoPlayedRef.current = false; }, [animeHref]);

  if (loading) {
    const provisionalTitle = titleFromSlug(animeHref);
    return (
      <div className="space-y-8">
        <div className="relative -mx-8 -mt-[92px] h-[440px] overflow-hidden">
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
    return <div className="flex flex-col items-center gap-4 py-20 text-center text-text-secondary">
      <p>{error ?? t.notFound}</p>
      {error && <button type="button" onClick={() => setRetryNonce((n) => n + 1)} className="rounded-full bg-accent px-4 py-2 font-semibold text-black">{t.retry}</button>}
    </div>;
  }

  const tabs: { key: TabKey; label: string; count?: number }[] = [
    { key: "episodes", label: t.episodes, count: data.totalEpisodes },
    { key: "related", label: t.tabRelated, count: relations ? relations.length : undefined },
    { key: "maylike", label: t.mayLikeTab, count: recs ? recs.length : undefined },
    { key: "info", label: t.titleDetails },
  ];

  return (
    <div className="space-y-10">
      {/* Full-bleed backdrop — the artwork owns the top of the screen */}
      <div className="relative -mx-8 -mt-[92px]">
        <div className="relative h-[min(64vh,600px)] min-h-[460px] w-full overflow-hidden">
          {(data.banner || data.poster) && (
            <img
              src={data.banner || data.poster || ""}
              alt=""
              className={`h-full w-full object-cover object-[50%_25%] ${data.banner ? "" : "scale-110 blur-2xl opacity-70"}`}
            />
          )}
          <div className="absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-bg/80 to-transparent" />
          <div className="absolute inset-0 bg-gradient-to-t from-bg via-bg/70 via-30% to-bg/10" />
          <div className="absolute inset-0 bg-gradient-to-l from-bg/95 via-bg/50 via-50% to-transparent" />
        </div>
        <div className="absolute inset-x-0 bottom-0 flex items-end gap-8 px-8 pb-2">
          {data.poster && (
            <button
              type="button"
              onClick={() => setPosterOpen(true)}
              aria-label={t.viewPoster}
              title={t.viewPoster}
              className="group relative hidden aspect-[2/3] w-[200px] flex-shrink-0 overflow-hidden rounded-[18px] shadow-lift ring-1 ring-white/10 md:block"
            >
              <img src={data.poster} alt={data.title} className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105" />
              <span className="absolute bottom-2 end-2 flex h-8 w-8 items-center justify-center rounded-full border border-white/25 bg-black/70 text-white opacity-0 transition group-hover:opacity-100">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                  <path d="M9 3H3v6M15 21h6v-6M3 15v6h6M21 9V3h-6" />
                </svg>
              </span>
            </button>
          )}
          <div className="flex min-w-0 max-w-[860px] flex-col gap-3.5 pb-1">
            {(availableSources.length > 0 || data.genres.length > 0) && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                {data.genres.length > 0 && (
                  <span className="text-sm font-bold text-mint">{data.genres.slice(0, 4).join("  ·  ")}</span>
                )}
                {availableSources.map((source) => (
                  <span key={source} className="rounded-full border border-white/10 bg-white/[0.06] px-2.5 py-0.5 text-[11px] font-bold text-text-secondary">
                    {sourceLabel(source)}
                  </span>
                ))}
              </div>
            )}
            <div className="flex items-start gap-3">
              <h1 className="font-display text-[clamp(30px,3.6vw,52px)] font-extrabold leading-[1.1] tracking-tight text-white">
                {data.title}
              </h1>
              <button
                type="button"
                onClick={onCopyTitle}
                aria-label={t.titleCopied}
                title={t.titleCopied}
                className="mt-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/15 bg-black/40 text-text-secondary transition-colors hover:border-accent hover:text-white"
              >
                {titleCopied ? (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" className="text-mint" aria-hidden>
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                ) : (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                    <rect x="9" y="9" width="12" height="12" rx="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                )}
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs font-bold">
              <MalScoreBadge score={malScore} style={{ position: "static" }} />
              {data.rating && (
                <span className="inline-flex items-center gap-1 rounded-full bg-gold/15 px-2.5 py-1 text-gold">
                  <span aria-hidden>★</span> {data.rating}
                </span>
              )}
              {maxNum > 0 && (
                <span className="rounded-full bg-white/[0.07] px-2.5 py-1 text-text-secondary">{t.episodeCount(maxNum)}</span>
              )}
              {isCompleted && (
                <span className="rounded-full bg-mint/15 px-2.5 py-1 text-mint">✓✓ {t.completedBadge}</span>
              )}
              {titleCopied && (
                <span className="rounded-full bg-accent/15 px-2.5 py-1 text-accent">{t.titleCopied}</span>
              )}
            </div>
            {data.synopsis && (
              <p className="line-clamp-3 max-w-[72ch] text-[15px] leading-relaxed text-text-secondary">
                {data.synopsis}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2.5 pt-1">
              {playTarget && (
                <Link
                  to={watchUrlFor(playTarget.ep, playTarget.href)}
                  className="inline-flex h-12 items-center gap-2.5 rounded-control bg-accent px-7 text-[15px] font-extrabold text-on-accent shadow-glow transition hover:bg-accent-bright active:scale-[0.98]"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M8 5v14l11-7z" /></svg>
                  {playTarget.mode === "resume"
                    ? t.resumeEpisode(playTarget.ep.number)
                    : playTarget.mode === "rewatch"
                      ? t.rewatchEpisode(playTarget.ep.number)
                      : t.playEpisodeN(playTarget.ep.number)}
                </Link>
              )}
              {bookmarkList ? (
                <button
                  type="button"
                  onClick={onUnbookmark}
                  title={t.saved}
                  className="inline-flex h-12 items-center gap-2 rounded-control border border-accent/40 bg-accent/15 px-5 text-sm font-bold text-white transition-colors hover:bg-accent/25"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="text-accent" aria-hidden><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1Z" /></svg>
                  {bookmarkList === "watching" ? t.currentlyWatching : t.planToWatch}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setPickerOpen(true)}
                  className="inline-flex h-12 items-center gap-2 rounded-control border border-white/15 bg-white/10 px-5 text-sm font-bold text-white backdrop-blur-md transition-colors hover:bg-white/20"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1Z" /></svg>
                  {t.addToList}
                </button>
              )}
              <button
                type="button"
                onClick={toggleCompleted}
                aria-pressed={isCompleted}
                title={isMarked ? t.unmarkCompleted : t.markCompleted}
                aria-label={isMarked ? t.unmarkCompleted : t.markCompleted}
                className={`flex h-12 w-12 items-center justify-center rounded-control border backdrop-blur-md transition-colors ${
                  isCompleted ? "border-mint/40 bg-mint/15 text-mint" : "border-white/15 bg-white/10 text-white hover:bg-white/20"
                }`}
              >
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <circle cx="12" cy="12" r="9.5" />
                  <path d="m7.5 12.5 2.5 2.5 6-6" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => setShareOpen(true)}
                aria-label={t.shareCardShare}
                title={t.shareCardShare}
                className="flex h-12 w-12 items-center justify-center rounded-control border border-white/15 bg-white/10 text-white backdrop-blur-md transition-colors hover:bg-white/20"
              >
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                  <circle cx="18" cy="5" r="3" />
                  <circle cx="6" cy="12" r="3" />
                  <circle cx="18" cy="19" r="3" />
                  <path d="m8.6 10.5 6.8-4M8.6 13.5l6.8 4" />
                </svg>
              </button>
              {completedToast && (
                <span className="animate-fadeIn rounded-full bg-mint/15 px-3 py-1.5 text-xs font-bold text-mint">{completedToast}</span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Next-episode countdown — renders nothing unless currently airing */}
      <AiringCountdown title={data.title} lastEpisode={maxNum} />

      <section className="space-y-4">
        {/* Editorial underline tabs — الحلقات / ذات صلة / قد يعجبك / تفاصيل */}
        <div className="sticky top-16 z-rail -mx-8 flex items-center gap-1.5 border-b border-white/[0.06] bg-bg/90 px-8 py-3 backdrop-blur-xl">
          {tabs.map((tab) => {
            const active = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveTab(tab.key)}
                className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm font-bold transition-colors ${
                  active ? "bg-white text-on-accent" : "text-text-muted hover:bg-white/[0.06] hover:text-white"
                }`}
              >
                {tab.label}
                {tab.count != null && tab.count > 0 && (
                  <span className={`rounded-full px-1.5 py-px text-[10px] font-extrabold ${active ? "bg-on-accent/10 text-on-accent" : "bg-white/[0.07] text-text-muted"}`}>
                    {tab.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {activeTab === "episodes" && (
          displayEpisodes.length === 0 ? (
            <p className="py-16 text-center text-text-muted">{t.noEpisodes}</p>
          ) : (
            <>
              {/* Mobile parity: jump to an episode number («go to episode»). */}
              <div className="flex flex-wrap items-center gap-2.5">
                <input
                  value={episodeQuery}
                  onChange={(event) => {
                    setEpisodeQuery(event.target.value);
                    if (jumpError) setJumpError(false);
                  }}
                  onKeyDown={(event) => { if (event.key === "Enter") jumpToEpisode(); }}
                  inputMode="numeric"
                  placeholder={t.episodeJumpPlaceholder}
                  aria-label={t.episodeJumpPlaceholder}
                  className={`h-10 w-40 rounded-control border bg-surface px-3.5 text-sm text-white outline-none placeholder:text-text-muted focus:border-accent ${
                    jumpError ? "border-danger/60" : "border-white/10"
                  }`}
                />
                <button
                  type="button"
                  onClick={jumpToEpisode}
                  className="h-10 rounded-control border border-white/10 bg-white/[0.06] px-5 text-sm font-bold text-white transition hover:bg-white/[0.12]"
                >
                  {t.goToEpisode}
                </button>
                {jumpError && <span className="text-xs font-semibold text-danger">{t.episodeNotFound}</span>}
              </div>
              <div className="grid grid-cols-2 gap-x-3.5 gap-y-4 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
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
                  <div
                    key={`${ep.number}-${primary}`}
                    ref={(element) => {
                      if (element) episodeRefs.current.set(ep.number, element);
                      else episodeRefs.current.delete(ep.number);
                    }}
                    className="group relative"
                  >
                    <Link
                      to={watchUrlFor(ep, playTarget?.mode === "resume" && playTarget.ep.number === ep.number ? playTarget.href : null)}
                      className={`relative block aspect-video overflow-hidden rounded-card bg-surface ring-1 transition duration-300 hover:-translate-y-0.5 hover:shadow-glow ${
                        ep.number === highlightedEpisode
                          ? "ring-2 ring-accent shadow-glow"
                          : playTarget?.ep.number === ep.number ? "ring-accent/60" : isDone ? "ring-mint/25" : "ring-white/[0.05]"
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
                      <div className={`absolute inset-0 bg-gradient-to-t from-black/85 via-black/20 to-transparent ${isDone ? "bg-black/35" : ""}`} />
                      <div className="absolute start-1.5 top-1.5 flex gap-1">
                        {ep.sources.map((source) => (
                          <span key={source} className="rounded-md bg-black/65 px-1.5 py-0.5 text-[9px] font-bold uppercase text-white/85 backdrop-blur-sm">
                            {sourceShortLabel(source)}
                          </span>
                        ))}
                      </div>
                      <div className="absolute inset-x-1.5 bottom-1.5 flex items-center justify-between">
                        <span className="text-[13px] font-extrabold text-white drop-shadow">
                          {t.episode} {ep.number}
                        </span>
                        {isDone ? (
                          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-mint text-on-accent" title={t.watched}>
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6 9 17l-5-5" /></svg>
                          </span>
                        ) : playTarget?.ep.number === ep.number ? (
                          <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] font-extrabold text-on-accent">{t.upNext}</span>
                        ) : null}
                      </div>
                    </Link>
                    <div className="absolute end-2 top-2 hidden gap-1.5 group-hover:flex">
                      <button
                        onClick={() => onDownload(ep)}
                        className="flex h-7 w-7 items-center justify-center rounded-full bg-black/75 text-white backdrop-blur-sm transition-colors hover:bg-accent hover:text-on-accent"
                        title={t.downloadEpisode}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55l3.3-3.3 1.4 1.4L12 17.4l-4.7-4.75 1.4-1.4 3.3 3.3V3h2zM5 19h14v2H5z" /></svg>
                      </button>
                      <button
                        onClick={() => onToggleWatched(ep)}
                        className="flex h-7 w-7 items-center justify-center rounded-full bg-black/75 text-[12px] font-bold text-white backdrop-blur-sm transition-colors hover:bg-mint hover:text-on-accent"
                        title={isDone ? t.markUnwatched : t.markWatched}
                      >
                        {isDone ? "↶" : "✓"}
                      </button>
                    </div>
                  </div>
                );
              })}
              </div>
            </>
          )
        )}

        {activeTab === "related" && (
          <PosterGrid
            items={(relations ?? []).map((entry) => ({
              key: `rel-${entry.anilistId}`,
              title: entry.title,
              image: entry.image,
              badge: entry.relation,
            }))}
            loading={relations === null}
            resolvingKey={resolvingKey}
            emptyLabel={t.noRelated}
            onOpen={(item) => openResolved(item.key, item.title)}
          />
        )}

        {activeTab === "maylike" && (
          <PosterGrid
            items={(recs ?? []).map((item) => ({
              key: `rec-${item.anilistId}`,
              title: item.title,
              image: item.image,
              badge: item.format,
            }))}
            loading={recs === null}
            resolvingKey={resolvingKey}
            emptyLabel={t.noRelated}
            onOpen={(item) => openResolved(item.key, item.title)}
          />
        )}

        {activeTab === "info" && <InfoTab title={data.title} metadata={data.metadata} />}
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

      {/* Full-resolution poster viewer — closes on backdrop click or Escape. */}
      {posterOpen && data.poster && (
        <div
          className="fixed inset-0 z-modal flex items-center justify-center bg-black/95 p-6"
          onClick={() => setPosterOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label={t.viewPoster}
        >
          <img
            src={data.poster}
            alt={data.title}
            className="max-h-full max-w-full object-contain"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            type="button"
            onClick={() => setPosterOpen(false)}
            aria-label={t.back}
            className="absolute end-5 top-5 flex h-10 w-10 items-center justify-center rounded-full border border-white/20 bg-black/60 text-white transition-colors hover:bg-white/10"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
          <p className="absolute inset-x-6 bottom-6 text-center text-sm font-bold text-white">{data.title}</p>
        </div>
      )}

      <ShareCard
        visible={shareOpen}
        onClose={() => setShareOpen(false)}
        anime={{
          title: data.title,
          poster: data.poster,
          banner: data.banner,
          score: malScore != null ? String(malScore) : data.rating,
          genres: data.genres,
          episodes: data.totalEpisodes,
        }}
      />

      <DownloadPicker
        visible={downloadMeta !== null}
        meta={downloadMeta}
        onClose={() => setDownloadMeta(null)}
      />

    </div>
  );
}

/* ── Related / you-may-like grid (shared) ── */

interface PosterGridItem {
  key: string;
  title: string;
  image: string | null;
  badge?: string | null;
}

function PosterGrid({
  items,
  loading,
  resolvingKey,
  emptyLabel,
  onOpen,
}: {
  items: PosterGridItem[];
  loading: boolean;
  resolvingKey: string | null;
  emptyLabel: string;
  onOpen: (item: PosterGridItem) => void;
}) {
  // Desktop adaptation: the mobile card-layout control (scope "related"),
  // compact/comfortable → CSS grid, list → rows.
  const cards = useCardLayout("related");

  if (loading) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-text-muted">
        <span className="h-7 w-7 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        <span className="text-sm">{t.loading}</span>
      </div>
    );
  }
  if (items.length === 0) {
    return <p className="py-16 text-center text-text-muted">{emptyLabel}</p>;
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <CardLayoutControl layout={cards.layout} onChange={cards.setLayout} />
        <span className="text-xs font-semibold text-text-muted">{items.length}</span>
      </div>

      {cards.layout === "list" ? (
        <div className="space-y-2">
          {items.map((item) => {
            const resolving = resolvingKey === item.key;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => onOpen(item)}
                className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-surface p-2.5 text-start transition hover:border-white/30"
              >
                <div className="relative h-16 w-12 shrink-0 overflow-hidden rounded-md bg-raised">
                  {item.image ? <img src={item.image} alt="" className="h-full w-full object-cover" loading="lazy" /> : <div className="h-full w-full shimmer" />}
                  {resolving && (
                    <span className="absolute inset-0 flex items-center justify-center bg-black/60">
                      <span className="h-5 w-5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                    </span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-sm font-semibold text-white">{item.title}</p>
                  {item.badge && (
                    <span className="mt-1 inline-block rounded bg-accent/15 px-2 py-0.5 text-[10px] font-bold text-accent">{item.badge}</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      ) : (
        <div className={cards.layout === "comfortable" ? "grid grid-cols-3 gap-x-4 gap-y-5 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7" : "grid grid-cols-4 gap-3 md:grid-cols-5 lg:grid-cols-7 xl:grid-cols-8 2xl:grid-cols-9"}>
          {items.map((item) => {
            const resolving = resolvingKey === item.key;
            return (
              <button key={item.key} type="button" onClick={() => onOpen(item)} className="group block w-full text-start outline-none" title={item.title}>
                <PosterFrame
                  image={item.image}
                  title={item.title}
                  topStart={item.badge ? <Pill tone="accent">{item.badge}</Pill> : undefined}
                  topEnd={<MalCardBadge title={item.title} />}
                  overlay={resolving ? (
                    <span className="absolute inset-0 z-20 flex items-center justify-center bg-black/60">
                      <span className="h-7 w-7 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                    </span>
                  ) : undefined}
                />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ── Tab: Info ── */

function InfoTab({ title, metadata }: { title: string; metadata: Record<string, string> }) {
  const [fields, setFields] = useState<AnimeInfoField[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFields(null);
    fetchAnimeInfo(title)
      .then((next) => { if (!cancelled) setFields(next); })
      .catch(() => { if (!cancelled) setFields([]); });
    return () => { cancelled = true; };
  }, [title]);

  // Prefer the MAL/AniList-enriched facts; fall back to the scraped metadata.
  const rows: AnimeInfoField[] = fields && fields.length > 0
    ? fields
    : Object.entries(metadata).map(([label, value]) => ({ label, value: String(value) }));

  if (fields === null && rows.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-text-muted">
        <span className="h-7 w-7 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        <span className="text-sm">{t.loading}</span>
      </div>
    );
  }
  if (rows.length === 0) {
    return <p className="py-16 text-center text-text-muted">{t.noInfo}</p>;
  }
  return (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-surface">
      {rows.map((row, i) => (
        <div key={`${row.label}-${i}`} className="flex items-start justify-between gap-4 border-b border-white/5 px-4 py-3 last:border-0">
          <span className="shrink-0 text-xs font-semibold text-text-muted">{row.label}</span>
          <span className="text-end text-sm text-text-secondary">{row.value}</span>
        </div>
      ))}
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
