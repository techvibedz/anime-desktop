import { memo, startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  fetchHome, HOME_SECTION_IDS,
  type HomeSection, type FeaturedItem, type AnimeItem, type EpisodeItem,
} from "../lib/api";
import { AnimeCard, EpisodeCard, PlayGlyph, PosterFrame } from "../components/AnimeCard";
import { AnimeOfTheDay } from "../components/AnimeOfTheDay";
import { EpisodeActionModal } from "../components/EpisodeActionModal";
import { MalCardBadge } from "../components/MalRating";
import { Rail, SectionHeader } from "../components/Rail";
import { Shimmer } from "../components/Shimmer";
import {
  animeTitleKey, dismissFromContinue, getContinueWatching, getHistoryByAnime, normAnimeKey,
  progressPercent, subscribeHistory, type AnimeHistoryGroup, type WatchEntry,
} from "../lib/history";
import { getFavorites, isEpisodeUrl, toAnimeUrl } from "../lib/favorites";
import { usePosterImage } from "../lib/posters";
import { usePrefersReducedMotion } from "../lib/motion";
import { canonTitle } from "../lib/relations";
import { fetchAnimeRecommendations, pickTasteSeeds, rankRecommendations, type RankedRec, type RecItem } from "../lib/recommend";
import { resolveSourceUrl } from "../lib/schedule";
import { reconcileCompletionFromEpisodes, useCompletionLookup } from "../lib/completion";
import { extractEpisodeNumber } from "../lib/episode-utils";
import { checkOnline } from "../lib/net";
import { storage } from "../lib/storage";
import { t } from "../lib/i18n";

const SECTION_LABELS: Record<string, string> = {
  recently_updated: t.recentlyUpdated,
  latest_movies: t.latestMovies,
  top_animes: t.topAnimes,
  top_movies: t.topMovies,
};

const POSTER_W = "clamp(150px, 11.5vw, 196px)";
const RANKED_W = "calc(clamp(150px, 11.5vw, 196px) + 52px)";
const WIDE_W = "clamp(270px, 21vw, 340px)";

// Bound the cold-start skeleton by time, not attempt count (mobile parity):
// a blocked source must surface a Retry button, not spin for minutes.
const COLD_START_DEADLINE_MS = 25_000;
const REFRESH_EVERY_MS = 5 * 60_000;

export function HomePage() {
  const [featured, setFeatured] = useState<FeaturedItem[]>([]);
  const [sections, setSections] = useState<HomeSection[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<null | "offline" | "error">(null);
  const [episodePopup, setEpisodePopup] = useState<EpisodeItem | null>(null);
  const [history, setHistory] = useState<WatchEntry[]>([]);
  const hasContent = useRef(false);
  const deadline = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLoadAt = useRef(0);

  const apply = useCallback((data: { featured: FeaturedItem[]; sections: HomeSection[] }) => {
    if (data.featured.length === 0 && data.sections.length === 0) return false;
    hasContent.current = true;
    startTransition(() => {
      setFeatured(data.featured);
      setSections(data.sections);
      setFailed(null);
      setLoading(false);
    });
    return true;
  }, []);

  const load = useCallback(async (forceRefresh = false) => {
    lastLoadAt.current = Date.now();
    if (deadline.current === 0) deadline.current = Date.now() + COLD_START_DEADLINE_MS;
    try {
      const res = await fetchHome((fresh) => { apply(fresh.data); }, { forceRefresh });
      if (apply(res.data)) return;
    } catch {
      // handled below
    }
    if (hasContent.current) return;
    if (!(await checkOnline().catch(() => true))) {
      setFailed("offline");
      setLoading(false);
      return;
    }
    if (Date.now() < deadline.current) {
      retryTimer.current = setTimeout(() => { void load(); }, 3000);
      return;
    }
    setFailed("error");
    setLoading(false);
  }, [apply]);

  const reload = useCallback(() => {
    deadline.current = 0;
    if (retryTimer.current) clearTimeout(retryTimer.current);
    setFailed(null);
    setLoading(!hasContent.current);
    void load(true);
  }, [load]);

  useEffect(() => {
    void load();
    return () => { if (retryTimer.current) clearTimeout(retryTimer.current); };
  }, [load]);

  // Keep the feed live: revalidate on focus when it's been a minute, and every
  // five minutes while the window is visible (mobile's foreground refresh).
  useEffect(() => {
    const onFocus = () => { if (Date.now() - lastLoadAt.current > 60_000) void load(true); };
    const poll = setInterval(() => { if (document.visibilityState === "visible") void load(true); }, REFRESH_EVERY_MS);
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(poll); window.removeEventListener("focus", onFocus); };
  }, [load]);

  // Continue Watching follows the history live — a cloud pull (App) or progress
  // saved in the player lands here without a remount.
  useEffect(() => {
    let alive = true;
    const refresh = () => { void getContinueWatching().then((items) => { if (alive) setHistory(items); }); };
    refresh();
    const off = subscribeHistory(refresh);
    window.addEventListener("focus", refresh);
    return () => { alive = false; off(); window.removeEventListener("focus", refresh); };
  }, []);

  // A new episode in the feed clears stale "caught up"/"finished" badges.
  useEffect(() => {
    const episodes = sections.filter((s) => s.type === "episode").flatMap((s) => s.items as EpisodeItem[]);
    if (episodes.length === 0) return;
    void reconcileCompletionFromEpisodes(episodes.map((ep) => ({
      animeHref: ep.animeHref || toAnimeUrl(ep.href),
      animeTitle: ep.animeTitle,
      epNum: extractEpisodeNumber(ep.href, ep.title),
    }))).catch(() => {});
  }, [sections]);

  // Anime the user marked "completed" never sit in Continue Watching.
  const completionLookup = useCompletionLookup();
  const continueItems = useMemo(
    () => history.filter((e) => !completionLookup.get({ hrefs: [e.animeHref], titles: [e.animeTitle] })?.marked),
    [history, completionLookup],
  );

  const removeContinue = useCallback((href: string) => {
    setHistory((prev) => prev.filter((h) => h.episodeHref !== href));
    void dismissFromContinue(href).then(() => getContinueWatching().then(setHistory)).catch(() => {});
  }, []);

  const visibleSections = useMemo(
    () => sections.filter((s) => HOME_SECTION_IDS.includes(s.id) && s.items.length > 0),
    [sections],
  );

  if (loading && !hasContent.current) return <HomeSkeleton />;

  if (failed && featured.length === 0 && visibleSections.length === 0) {
    return <HomeEmpty offline={failed === "offline"} onRetry={reload} />;
  }

  return (
    <div className="space-y-14">
      {featured.length > 0 ? <HeroCarousel featured={featured} /> : <div className="h-2" />}

      {continueItems.length > 0 && (
        <section className="relative z-10 -mt-6">
          <SectionHeader title={t.continueWatching} />
          <Rail itemWidth={WIDE_W}>
            {continueItems.slice(0, 12).map((entry) => (
              <ContinueCard key={entry.episodeHref} entry={entry} onRemove={removeContinue} />
            ))}
          </Rail>
        </section>
      )}

      <AnimeOfTheDay />

      <ForYouRail history={history} />

      {visibleSections.map((section) => (
        <HomeRail key={section.id} section={section} onOpenEpisode={setEpisodePopup} />
      ))}

      <EpisodeActionModal episode={episodePopup} onClose={() => setEpisodePopup(null)} />
    </div>
  );
}

/* ── Hero ─────────────────────────────────────────────────────────────── */

const HERO_INTERVAL_MS = 7000;

function openHeroTarget(item: FeaturedItem, details: boolean): string | null {
  if (!item.href) return null;
  if (isEpisodeUrl(item.href)) {
    const animeUrl = toAnimeUrl(item.href);
    if (details) return animeUrl ? `/anime/${encodeURIComponent(animeUrl)}` : null;
    const params = new URLSearchParams();
    if (animeUrl) params.set("anime", animeUrl);
    if (item.image) params.set("img", item.image);
    const q = params.toString();
    return `/watch/${encodeURIComponent(item.href)}${q ? `?${q}` : ""}`;
  }
  // Anime-page slides: Details opens the page; Watch now opens it and starts
  // the resume / first episode (the page resolves the list).
  return `/anime/${encodeURIComponent(item.href)}${details ? "" : "?play=1"}`;
}

// Owns its own index + timer so a tick re-renders only the hero.
const HeroCarousel = memo(function HeroCarousel({ featured }: { featured: FeaturedItem[] }) {
  const navigate = useNavigate();
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const [visible, setVisible] = useState(true);
  const reduced = usePrefersReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const count = featured.length;

  useEffect(() => { if (idx >= count) setIdx(0); }, [count, idx]);

  // Pause while scrolled out of view, hovered, or the window is hidden.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting && e.intersectionRatio > 0.35), { threshold: [0, 0.35, 1] });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const [docVisible, setDocVisible] = useState(document.visibilityState === "visible");
  useEffect(() => {
    const on = () => setDocVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);

  const running = count > 1 && !reduced && !paused && visible && docVisible;
  useEffect(() => {
    if (!running) return;
    const id = setTimeout(() => setIdx((i) => (i + 1) % count), HERO_INTERVAL_MS);
    return () => clearTimeout(id);
  }, [running, idx, count]);

  // Warm the next slide's art so the crossfade never flashes empty.
  useEffect(() => {
    const next = featured[(idx + 1) % count];
    if (next?.image) { const im = new Image(); im.src = next.image; }
  }, [idx, featured, count]);

  const go = (d: number) => setIdx((i) => (i + d + count) % count);
  const f = featured[Math.min(idx, count - 1)];
  if (!f) return null;
  const watchTo = openHeroTarget(f, false);
  const detailTo = openHeroTarget(f, true);

  return (
    <section
      ref={rootRef}
      className="relative -mx-8 -mt-[92px] h-[min(76vh,760px)] min-h-[520px] overflow-hidden"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      aria-roledescription="carousel"
    >
      {featured.map((slide, i) => (
        <div
          key={slide.href || i}
          className={`absolute inset-0 transition-opacity duration-1000 ease-out ${i === idx ? "opacity-100" : "opacity-0"}`}
          aria-hidden={i !== idx}
        >
          {slide.image && (
            <img
              src={slide.image}
              alt=""
              className={`h-full w-full object-cover object-[50%_20%] ${i === idx && !reduced ? "animate-kenburns" : ""}`}
              decoding="async"
              loading={i === 0 ? "eager" : "lazy"}
            />
          )}
        </div>
      ))}
      {/* Top scrim keeps the floating top bar legible; bottom + start scrims put
          the copy on a dark plate (AA) and melt the art into the canvas. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-bg/80 to-transparent" />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-bg via-bg/55 via-35% to-transparent" />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-l from-bg/90 via-bg/35 via-45% to-transparent" />

      <div className="absolute inset-x-0 bottom-0 px-8 pb-16">
        <div key={f.href} className="max-w-[640px] animate-rise space-y-4">
          {f.genres.length > 0 && (
            <p className="text-sm font-bold text-mint">{f.genres.slice(0, 3).join("  ·  ")}</p>
          )}
          <h1 className="line-clamp-2 font-display text-[clamp(34px,4.2vw,60px)] font-extrabold leading-[1.08] tracking-tight text-white drop-shadow-lg">
            {f.title}
          </h1>
          {f.description && (
            <p className="line-clamp-2 max-w-[58ch] text-[15px] leading-relaxed text-text-secondary">{f.description}</p>
          )}
          <div className="flex flex-wrap items-center gap-3 pt-1">
            {watchTo && (
              <button
                type="button"
                onClick={() => navigate(watchTo)}
                className="inline-flex h-12 items-center gap-2.5 rounded-control bg-accent px-7 text-[15px] font-extrabold text-on-accent shadow-glow transition hover:bg-accent-bright active:scale-[0.98]"
              >
                <PlayGlyph size={16} />
                {t.watchNow}
              </button>
            )}
            {detailTo && (
              <button
                type="button"
                onClick={() => navigate(detailTo)}
                className="inline-flex h-12 items-center gap-2.5 rounded-control border border-white/15 bg-white/10 px-6 text-[15px] font-bold text-white backdrop-blur-md transition hover:bg-white/20"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>
                {t.heroDetails}
              </button>
            )}
          </div>
        </div>
      </div>

      {count > 1 && (
        <div className="absolute bottom-7 end-8 flex items-center gap-3">
          <button type="button" onClick={() => go(-1)} aria-label="prev" className="flex h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-black/30 text-white backdrop-blur-md transition hover:bg-white/15">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden><path d="m9 18 6-6-6-6" /></svg>
          </button>
          <div className="flex items-center gap-1.5">
            {featured.map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setIdx(i)}
                aria-label={`${i + 1} / ${count}`}
                aria-current={i === idx}
                className={`relative h-1.5 overflow-hidden rounded-full transition-all duration-300 ${i === idx ? "w-10 bg-white/25" : "w-4 bg-white/25 hover:bg-white/45"}`}
              >
                {i === idx && (
                  <span
                    key={`${idx}-${running}`}
                    className="absolute inset-y-0 start-0 rounded-full bg-accent"
                    style={running ? { animation: `heroProgress ${HERO_INTERVAL_MS}ms linear both` } : { width: "100%" }}
                  />
                )}
              </button>
            ))}
          </div>
          <button type="button" onClick={() => go(1)} aria-label="next" className="flex h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-black/30 text-white backdrop-blur-md transition hover:bg-white/15">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden><path d="m15 18-6-6 6-6" /></svg>
          </button>
        </div>
      )}
      <style>{`@keyframes heroProgress { from { width: 0 } to { width: 100% } }`}</style>
    </section>
  );
});

/* ── Rails ─────────────────────────────────────────────────────────────── */

const HomeRail = memo(function HomeRail({ section, onOpenEpisode }: { section: HomeSection; onOpenEpisode: (ep: EpisodeItem) => void }) {
  const label = SECTION_LABELS[section.id] || section.title;
  const isEpisodes = section.type === "episode";
  const ranked = section.id.startsWith("top_");
  // The new-episodes rail shows the newest 12 (fuller list behind See all);
  // anime rails keep a wider preview.
  const preview = section.items.slice(0, isEpisodes ? 12 : 15);
  return (
    <section className="lazy-section">
      <SectionHeader
        title={label}
        to={`/see-all/${section.id}`}
        linkState={{ items: section.items, type: section.type, title: label }}
      />
      <Rail itemWidth={isEpisodes ? WIDE_W : ranked ? RANKED_W : POSTER_W} gap={ranked ? 12 : 16}>
        {isEpisodes
          ? (preview as EpisodeItem[]).map((ep) => <EpisodeCard key={ep.href} episode={ep} onOpen={onOpenEpisode} />)
          : (preview as AnimeItem[]).map((it, i) => <AnimeCard key={it.href} item={it} rank={ranked ? i + 1 : undefined} />)}
      </Rail>
    </section>
  );
});

/* ── Continue watching ─────────────────────────────────────────────────── */

// The episode URL is the canonical source of the number (witanime /watch/<s>/<n>,
// anime4up …الحلقة-N, anime3rb /episode/<s>/<n>); the title can lag.
function episodeNumberFor(entry: WatchEntry): number | null {
  if (typeof entry.epNum === "number" && entry.epNum > 0) return entry.epNum;
  return extractEpisodeNumber(entry.episodeHref, entry.episodeTitle);
}

function continueHref(entry: WatchEntry): string {
  const params = new URLSearchParams();
  const rawAnime = entry.animeHref || entry.episodeHref;
  const animeUrl = rawAnime && /\/(anime|movie|titles)\//.test(rawAnime) && !isEpisodeUrl(rawAnime) ? rawAnime : toAnimeUrl(rawAnime) ?? "";
  if (animeUrl) params.set("anime", animeUrl);
  if (entry.image) params.set("img", entry.image);
  if (entry.url4up) params.set("up4", entry.url4up);
  if (entry.animeTitle) params.set("title", entry.animeTitle);
  const n = episodeNumberFor(entry);
  if (n != null) params.set("ep", String(n));
  const q = params.toString();
  return `/watch/${encodeURIComponent(entry.episodeHref)}${q ? `?${q}` : ""}`;
}

const ContinueCard = memo(function ContinueCard({ entry, onRemove }: { entry: WatchEntry; onRemove: (href: string) => void }) {
  const poster = usePosterImage(entry.image, entry.animeHref || entry.episodeHref);
  const pct = progressPercent(entry);
  const remainMin = Math.max(1, Math.round((entry.durationMs - entry.positionMs) / 60000));
  const epNum = episodeNumberFor(entry);
  const animeName = (entry.animeTitle || "").trim();
  const rawTitle = (entry.episodeTitle || "").trim();
  // Old rows stored the anime name as the episode title — synthesize the label.
  const epTitle = !rawTitle || (animeName && rawTitle.toLowerCase() === animeName.toLowerCase())
    ? (epNum != null ? `${t.episode} ${epNum}` : "")
    : rawTitle;
  const epHasName = !!epTitle && !!animeName && epTitle.toLowerCase().includes(animeName.toLowerCase());
  const lead = epHasName ? epTitle : (animeName || epTitle);
  const support = [epHasName ? (epNum != null ? `${t.episode} ${epNum}` : "") : epTitle, entry.durationMs > 0 ? t.minLeft(remainMin) : ""]
    .filter(Boolean).join(" · ");
  return (
    <Link to={continueHref(entry)} className="group block outline-none" title={lead}>
      <div className="relative aspect-video overflow-hidden rounded-card bg-surface shadow-card ring-1 ring-white/[0.04] transition duration-300 ease-out group-hover:-translate-y-1 group-hover:shadow-glow group-focus-visible:shadow-glow">
        {poster.src ? (
          <img
            src={poster.src}
            alt=""
            onError={poster.onError}
            className="h-full w-full object-cover object-[50%_25%] transition-transform duration-500 ease-out group-hover:scale-[1.05]"
            loading="lazy"
            decoding="async"
          />
        ) : (
          <div className={`h-full w-full ${poster.repairing ? "shimmer" : "bg-gradient-to-br from-raised to-surface"}`} />
        )}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-bg/90 via-bg/10 to-transparent" />
        <span className="absolute bottom-4 start-3 flex items-center gap-1.5 rounded-full bg-accent px-2.5 py-1 text-[11px] font-bold text-on-accent">
          <PlayGlyph size={10} />
          {t.resume}
        </span>
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRemove(entry.episodeHref); }}
          title={t.remove}
          aria-label={t.remove}
          className="absolute end-2.5 top-2.5 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-white/80 opacity-0 backdrop-blur-sm transition group-hover:opacity-100 hover:bg-danger hover:text-white"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
        <div className="absolute inset-x-0 bottom-0 h-1 bg-white/15">
          <div className="h-full rounded-e-full bg-accent" style={{ width: `${Math.round(pct * 100)}%` }} />
        </div>
      </div>
      <h3 className="mt-2.5 line-clamp-1 text-[14px] font-bold text-white">{lead}</h3>
      {support && <p className="line-clamp-1 text-xs font-semibold text-text-muted">{support}</p>}
    </Link>
  );
});

/* ── For You ───────────────────────────────────────────────────────────── */

// Seeded by the WHOLE watch history: every distinct anime weighted by episodes
// watched + recency (pickTasteSeeds), top 6 resolved against AniList, their
// community recs merged with per-seed weights. The last ranking paints
// instantly on the next launch while a fresh one is computed behind it.
const seedKeyOf = (e: { animeTitle: string; animeHref: string }) =>
  normAnimeKey(e.animeHref) || animeTitleKey(e.animeTitle);
const FOR_YOU_SEEDS = 6;
const FOR_YOU_KEY = "@for_you_rail_v1";
const FOR_YOU_REFRESH_MS = 10 * 60 * 1000;
let forYouMem: RankedRec[] | null = null;
let forYouComputed: { seedKey: string; at: number } | null = null;

const ForYouRail = memo(function ForYouRail({ history }: { history: WatchEntry[] }) {
  const navigate = useNavigate();
  const [items, setItems] = useState<RankedRec[]>(() => forYouMem ?? []);
  const [busyId, setBusyId] = useState<number | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => {
    if (forYouMem) return;
    let alive = true;
    storage.getItem(FOR_YOU_KEY).then((raw) => {
      const cached = raw ? (JSON.parse(raw) as RankedRec[]) : null;
      if (!alive || !Array.isArray(cached) || cached.length === 0 || forYouMem) return;
      forYouMem = cached;
      setItems((prev) => (prev.length ? prev : cached));
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // Full per-anime history (Continue Watching hides finished/dismissed anime).
  const [groups, setGroups] = useState<AnimeHistoryGroup[] | null>(null);
  useEffect(() => {
    let alive = true;
    getHistoryByAnime().then((g) => { if (alive) setGroups(g); }).catch(() => { if (alive) setGroups([]); });
    return () => { alive = false; };
  }, [history]);

  const seeds = useMemo(
    () => pickTasteSeeds((groups ?? []).map((g) => ({ animeTitle: g.animeTitle, animeHref: g.animeHref, watched: g.watched, updatedAt: g.updatedAt })), seedKeyOf, FOR_YOU_SEEDS),
    [groups],
  );
  const seedKey = groups === null ? null : seeds.map((s) => s.animeTitle).join("|");
  const seedsRef = useRef(seeds);
  seedsRef.current = seeds;
  const groupsRef = useRef(groups);
  groupsRef.current = groups;

  useEffect(() => {
    if (seedKey === null) return;
    const picked = seedsRef.current;
    if (picked.length === 0) { forYouMem = null; setItems([]); return; }
    if (forYouComputed?.seedKey === seedKey && Date.now() - forYouComputed.at < FOR_YOU_REFRESH_MS && itemsRef.current.length > 0) return;
    let alive = true;
    const timer = setTimeout(() => { void (async () => {
      const favorites = await getFavorites().catch(() => []);
      // Nothing the user already watched / bookmarked may come back as a rec.
      const keys = new Set<string>();
      const canons = new Set<string>();
      const remember = (title: string | null | undefined) => {
        if (!title) return;
        const k = animeTitleKey(title);
        if (k) keys.add(k);
        canons.add(canonTitle(title));
      };
      for (const g of groupsRef.current ?? []) remember(g.animeTitle);
      for (const f of favorites) remember(f.title);
      const excluded = (item: RecItem) =>
        [item.title, item.titleEnglish].some((title) => !!title && (keys.has(animeTitleKey(title)) || canons.has(canonTitle(title))));
      const weights = picked.map((s) => s.weight);
      const batches: RecItem[][] = picked.map(() => []);
      const rank = () => rankRecommendations(batches, { excluded, cap: 15, weights });
      // Seeds stream in: an empty rail appears with the first seeds' recs.
      await Promise.all(picked.map((s, i) =>
        fetchAnimeRecommendations(s.animeTitle, s.animeHref).catch(() => [] as RecItem[]).then((batch) => {
          batches[i] = batch;
          if (alive && batch.length > 0 && itemsRef.current.length === 0) setItems(rank());
        }),
      ));
      if (!alive) return;
      const ranked = rank();
      forYouComputed = { seedKey, at: Date.now() };
      forYouMem = ranked;
      setItems(ranked);
      storage.setItem(FOR_YOU_KEY, JSON.stringify(ranked)).catch(() => {});
    })().catch(() => {}); }, itemsRef.current.length > 0 ? 2500 : 600);
    return () => { alive = false; clearTimeout(timer); };
  }, [seedKey]);

  const open = async (item: RankedRec) => {
    if (busyId != null) return;
    setBusyId(item.anilistId);
    try {
      const href = await resolveSourceUrl(item.title).catch(() => null);
      // No source carries it → the AniList detail page still has something useful.
      navigate(href ? `/anime/${encodeURIComponent(href)}` : `/title/${item.anilistId}`);
    } finally {
      setBusyId(null);
    }
  };

  if (items.length === 0) return null;
  return (
    <section className="lazy-section">
      <SectionHeader
        title={t.recsForYou}
        icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" className="text-mint" aria-hidden><path d="M12 2l1.9 5.6L19.5 9l-4.6 3.4L16.4 18 12 14.8 7.6 18l1.5-5.6L4.5 9l5.6-1.4z" /></svg>}
      />
      <Rail itemWidth={POSTER_W}>
        {items.map((item) => (
          <button
            key={item.anilistId}
            type="button"
            onClick={() => open(item)}
            disabled={busyId === item.anilistId}
            className="group block w-full text-start outline-none"
          >
            <PosterFrame
              image={item.image}
              title={item.title}
              subtitle={[item.format, item.seasonYear].filter(Boolean).join(" · ") || undefined}
              topEnd={<MalCardBadge title={item.title} />}
              overlay={busyId === item.anilistId ? (
                <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/55">
                  <span className="h-7 w-7 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                </div>
              ) : null}
            />
          </button>
        ))}
      </Rail>
    </section>
  );
});

/* ── Empty / skeleton ──────────────────────────────────────────────────── */

function HomeEmpty({ offline, onRetry }: { offline: boolean; onRetry: () => void }) {
  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center gap-5 text-center">
      <div className={`flex h-20 w-20 items-center justify-center rounded-full ${offline ? "bg-gold/10 text-gold" : "bg-danger/10 text-danger"}`}>
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
          {offline
            ? <path d="M2 2l20 20M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5.2-2.8M19 13a10 10 0 0 0-2.4-1.7M2 8.8a15 15 0 0 1 4.2-2.6M22 8.8A15 15 0 0 0 11 5M12 20h.01" />
            : <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />}
        </svg>
      </div>
      <div className="max-w-md space-y-2">
        <h2 className="text-2xl font-extrabold text-white">{offline ? t.offlineTitle : t.homeEmptyTitle}</h2>
        <p className="text-sm leading-relaxed text-text-secondary">{offline ? t.offlineSub : t.homeEmptySub}</p>
      </div>
      <div className="flex items-center gap-3">
        <Link to="/downloads" className="inline-flex h-11 items-center gap-2 rounded-control bg-accent px-6 text-sm font-extrabold text-on-accent hover:bg-accent-bright">
          {t.watchDownloads}
        </Link>
        <button type="button" onClick={onRetry} className="inline-flex h-11 items-center gap-2 rounded-control border border-white/15 bg-white/[0.06] px-6 text-sm font-bold text-white hover:bg-white/[0.12]">
          {t.retry}
        </button>
      </div>
    </div>
  );
}

function HomeSkeleton() {
  return (
    <div className="space-y-12">
      <div className="relative -mx-8 -mt-[92px] h-[min(76vh,760px)] min-h-[520px] overflow-hidden">
        <div className="shimmer absolute inset-0 opacity-60" />
        <div className="absolute inset-0 bg-gradient-to-t from-bg via-bg/40 to-transparent" />
        <div className="absolute bottom-16 start-8 w-[min(560px,60%)] space-y-4">
          <Shimmer className="h-4 w-40 rounded-full" />
          <Shimmer className="h-12 w-full rounded-xl" />
          <Shimmer className="h-4 w-4/5 rounded-full" />
          <div className="flex gap-3 pt-2"><Shimmer className="h-12 w-40 rounded-control" /><Shimmer className="h-12 w-36 rounded-control" /></div>
        </div>
      </div>
      {[0, 1].map((row) => (
        <div key={row} className="space-y-4">
          <Shimmer className="h-6 w-52 rounded-full" />
          <div className="flex gap-4 overflow-hidden">
            {Array.from({ length: row === 0 ? 5 : 8 }).map((_, i) => (
              <Shimmer key={i} className={`shrink-0 rounded-card ${row === 0 ? "aspect-video w-[300px]" : "aspect-[2/3] w-[170px]"}`} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
