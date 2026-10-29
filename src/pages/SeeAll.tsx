import { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useLocation, Link } from "react-router-dom";
import {
  fetchHome, fetchRecent, fetchAllAnime,
  type AnimeItem, type EpisodeItem, type SearchResult,
} from "../lib/api";
import { AnimeCard, EpisodeCard } from "../components/AnimeCard";
import { EpisodeActionModal } from "../components/EpisodeActionModal";
import { CompletionBadge } from "../components/CompletionBadge";
import { CardLayoutControl } from "../components/CardLayoutControl";
import { useCardLayout, type CardLayout } from "../lib/cardLayout";
import { extractEpisodeNumber } from "../lib/episode-utils";
import { animeTitleKey } from "../lib/history";
import { Shimmer } from "../components/Shimmer";
import { t } from "../lib/i18n";

type ItemKind = "anime" | "episode";

// comfortable = the grids as they always were; compact packs one step denser;
// list renders one row per item (poster thumb + text).
const ANIME_GRID: Record<CardLayout, string> = {
  comfortable: "grid grid-cols-3 gap-x-4 gap-y-5 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7",
  compact: "grid grid-cols-4 gap-3 md:grid-cols-5 lg:grid-cols-7 xl:grid-cols-8 2xl:grid-cols-9",
  list: "flex flex-col gap-2",
};
const EPISODE_GRID: Record<CardLayout, string> = {
  comfortable: "grid grid-cols-2 gap-x-4 gap-y-6 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5",
  compact: "grid grid-cols-3 gap-x-3 gap-y-5 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6",
  list: "flex flex-col gap-2",
};

export function SeeAllPage() {
  const { layout, setLayout } = useCardLayout("see-all");
  const { section } = useParams<{ section: string }>();
  const location = useLocation();
  const [items, setItems] = useState<(AnimeItem | EpisodeItem | SearchResult)[]>([]);
  const [kind, setKind] = useState<ItemKind>("anime");
  const [title, setTitle] = useState("");
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [episodePopup, setEpisodePopup] = useState<EpisodeItem | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const seenAnimeRef = useRef<Set<string>>(new Set()); // per-anime dedup for recently_updated

  // Initial load — figure out which kind of section this is.
  useEffect(() => {
    if (!section) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setItems([]);
    setPage(1);
    setHasMore(true);
    (async () => {
      try {
        if (section === "recently_updated") {
          setTitle(t.recentlyUpdated); setKind("episode");
          const st = location.state as { episodes?: EpisodeItem[]; items?: EpisodeItem[] } | null;
          const seeded = st?.items ?? st?.episodes;
          if (Array.isArray(seeded) && seeded.length > 0) {
            const seen = new Set<string>();
            seenAnimeRef.current = seen;
            setItems(dedupeEpisodes(seeded, seen));
            setHasMore(false);
            setLoading(false);
          }
          const seen = new Set<string>();
          const { collected, nextPage, more } = await fillRecent(1, seen);
          if (cancelled) return;
          seenAnimeRef.current = seen;
          setItems(collected);
          setPage(nextPage - 1); // last page actually fetched
          setHasMore(more);
        } else if (section === "all_anime") {
          setTitle("جميع الأنميات"); setKind("anime");
          const r = await fetchAllAnime(1);
          if (cancelled) return;
          setItems(r.data.items);
          setHasMore(r.data.hasNext && r.data.items.length > 0);
        } else {
          // Sections derived from the home payload — no pagination. The home
          // rail hands its items over in the route state so they paint at once.
          const st = location.state as { items?: AnimeItem[]; type?: ItemKind; title?: string } | null;
          if (Array.isArray(st?.items) && st.items.length > 0) {
            setTitle(localizedTitle(section, st.title || ""));
            setKind(st.type ?? "anime");
            setItems(st.items);
          } else {
            const home = await fetchHome();
            if (cancelled) return;
            const found = home.data.sections.find((s) => s.id === section);
            if (found) {
              setTitle(localizedTitle(section, found.title));
              setKind(found.type);
              setItems(found.items);
            }
          }
          setHasMore(false);
        }
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : t.failedToLoad);
        setHasMore(false);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [section, retryNonce, location.key]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    const next = page + 1;
    console.info(`[see-all] loading page ${next} of "${section}"`);
    try {
      if (section === "recently_updated") {
        // Fetch one page so each set of fresh anime can paint immediately.
        const { collected, nextPage, more } = await fillRecent(next, seenAnimeRef.current);
        if (collected.length > 0) setItems((prev) => prev.concat(collected));
        setHasMore(more);
        setPage(nextPage - 1);
        return;
      } else if (section === "all_anime") {
        const r = await fetchAllAnime(next);
        const fresh = r.data.items;
        if (fresh.length === 0) {
          setHasMore(false);
        } else {
          setItems((prev) => {
            const merged = dedupe(prev.concat(fresh));
            if (merged.length === prev.length) {
              console.warn(`[see-all] page ${next} all duplicates — stopping`);
              setHasMore(false);
            }
            return merged;
          });
        }
      } else {
        setHasMore(false);
      }
      setPage(next);
    } catch (e) {
      console.warn(`[see-all] load page ${next} failed:`, e);
      setError(e instanceof Error ? e.message : t.failedToLoad);
      setHasMore(false);
    } finally {
      setLoadingMore(false);
    }
  }, [page, section, hasMore, loadingMore]);

  // Infinite scroll via IntersectionObserver. Re-creates whenever items
  // grow so the observer is attached to a fresh sentinel (the previous
  // one may have been re-mounted by React after layout shift).
  useEffect(() => {
    if (!sentinelRef.current || !hasMore || loading) return;
    const el = sentinelRef.current;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && !loadingMore) {
        console.info(`[see-all] sentinel visible — triggering loadMore`);
        loadMore();
      }
    }, { rootMargin: "1600px" }); // prefetch ~1.5–2 screens early to hide latency
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore, hasMore, loading, loadingMore, items.length]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="flex items-center gap-3 text-[32px] font-extrabold text-white">
          {title || t.loading}
          {!loading && items.length > 0 && (
            <span className="rounded-full bg-white/[0.07] px-2.5 py-0.5 text-sm font-bold text-text-muted">{items.length}</span>
          )}
        </h1>
        <div className="ms-auto">
          <CardLayoutControl layout={layout} onChange={setLayout} />
        </div>
      </div>
      {error && (
        <div className="flex items-center gap-3 text-sm text-text-secondary">
          <span>{error}</span>
          <button type="button" onClick={() => setRetryNonce((n) => n + 1)} className="rounded-full bg-accent px-4 py-2 font-semibold text-black">{t.retry}</button>
        </div>
      )}
      {loading ? (
        <div className={ANIME_GRID[layout]}>
          {Array.from({ length: layout === "list" ? 6 : 18 }).map((_, i) => (
            <Shimmer key={i} className={layout === "list" ? "h-28" : "aspect-[2/3]"} />
          ))}
        </div>
      ) : kind === "episode" ? (
        layout === "list" ? (
          <div className="flex flex-col gap-2">
            {(items as EpisodeItem[]).map((it) => {
              const num = extractEpisodeNumber(it.title, it.href);
              return (
                <button
                  key={it.href + it.animeHref}
                  type="button"
                  onClick={() => setEpisodePopup(it)}
                  className="group flex items-center gap-3 rounded-xl bg-surface p-2 text-start ring-1 ring-white/5 transition hover:ring-accent/50"
                >
                  <div className="relative aspect-[2/3] w-16 shrink-0 overflow-hidden rounded-lg bg-bg">
                    {it.image ? (
                      <img src={it.image} alt={it.title} className="h-full w-full object-cover" loading="lazy" decoding="async" />
                    ) : (
                      <div className="h-full w-full shimmer" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="line-clamp-1 text-sm font-bold text-white">{it.animeTitle || it.title}</h3>
                    {it.animeTitle && num == null && (
                      <p className="line-clamp-1 text-xs font-semibold text-text-muted">{it.title}</p>
                    )}
                    {num != null && (
                      <span className="mt-1.5 inline-block rounded-full bg-accent px-2 py-0.5 text-[10px] font-bold text-on-accent">
                        {t.episode} {num}
                      </span>
                    )}
                  </div>
                  <CompletionBadge hrefs={[it.animeHref]} titles={[it.animeTitle]} className="shrink-0" />
                </button>
              );
            })}
          </div>
        ) : (
          <div className={EPISODE_GRID[layout]}>
            {(items as EpisodeItem[]).map((it) => (
              <EpisodeCard key={it.href + it.animeHref} episode={it} onOpen={setEpisodePopup} />
            ))}
          </div>
        )
      ) : layout === "list" ? (
        <div className="flex flex-col gap-2">
          {(items as AnimeItem[]).map((it) => (
            <Link
              key={it.href}
              to={`/anime/${encodeURIComponent(it.href)}`}
              className="group flex items-center gap-3 rounded-xl bg-surface p-2 ring-1 ring-white/5 transition hover:ring-accent/50"
            >
              <div className="relative aspect-[2/3] w-16 shrink-0 overflow-hidden rounded-lg bg-bg">
                {it.image ? (
                  <img src={it.image} alt={it.title} className="h-full w-full object-cover" loading="lazy" decoding="async" />
                ) : (
                  <div className="h-full w-full shimmer" />
                )}
                <CompletionBadge hrefs={[it.href]} titles={[it.title]} className="absolute bottom-1 end-1" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="line-clamp-2 text-sm font-semibold text-text-secondary transition-colors group-hover:text-white">
                  {it.title}
                </h3>
                {it.type && (
                  <span className="mt-1 inline-block rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-white/90">
                    {it.type}
                  </span>
                )}
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <div className={ANIME_GRID[layout]}>
          {(items as AnimeItem[]).map((it) => <AnimeCard key={it.href} item={it} />)}
        </div>
      )}

      {hasMore && !loading && (
        <div ref={sentinelRef} className="flex flex-col items-center justify-center gap-3 py-8">
          {loadingMore ? (
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          ) : (
            <button
              onClick={loadMore}
              className="rounded-control border border-white/10 bg-white/[0.06] px-6 py-2.5 text-sm font-bold text-white hover:border-accent hover:bg-accent/10"
            >
              {t.loadMore}
            </button>
          )}
        </div>
      )}

      <EpisodeActionModal episode={episodePopup} onClose={() => setEpisodePopup(null)} />
    </div>
  );
}

function dedupe<T extends { href: string }>(arr: T[]): T[] {
  const seen = new Set<string>();
  return arr.filter((x) => {
    if (seen.has(x.href)) return false;
    seen.add(x.href);
    return true;
  });
}

// ── "New Episodes" per-anime dedup ──────────────────────────────────────────
// The recently-updated feed lists raw episodes newest-first; we want each anime
// to appear exactly once (its latest episode). Because the feed is newest-first,
// the first episode seen for an anime is its newest one.
// One anime arrives from different sources with different hrefs (and the same
// source can spell a title differently), so key on BOTH (mobile parity).
function episodeAnimeKeys(ep: EpisodeItem): string[] {
  const keys: string[] = [];
  const href = String(ep.animeHref || "").trim().toLowerCase().replace(/\/+$/, "");
  if (href) keys.push("h:" + href);
  const title = animeTitleKey(ep.animeTitle);
  if (title) keys.push("t:" + title);
  if (!keys.length) keys.push("x:" + String(ep.href || ep.title || ""));
  return keys;
}

function dedupeEpisodes(eps: EpisodeItem[], seen: Set<string>): EpisodeItem[] {
  const out: EpisodeItem[] = [];
  for (const ep of eps) {
    const keys = episodeAnimeKeys(ep);
    if (keys.some((k) => seen.has(k))) continue;
    for (const k of keys) seen.add(k);
    out.push(ep);
  }
  return out;
}

// Load one page at a time so the first anime cards paint without waiting for
// later pages, and avoid a burst of requests to Anime4up's rate-limited edge.
async function fillRecent(fromPage: number, seen: Set<string>) {
  const r = await fetchRecent(fromPage);
  return {
    collected: dedupeEpisodes(r.data.episodes, seen),
    nextPage: fromPage + 1,
    more: r.data.hasNext && r.data.episodes.length > 0,
  };
}

function localizedTitle(id: string, fallback: string): string {
  switch (id) {
    case "recently_updated": return t.recentlyUpdated;
    case "latest_movies": return t.latestMovies;
    case "top_animes": return t.topAnimes;
    case "top_movies": return t.topMovies;
    case "trending": return t.trendingNow;
    case "movies": return t.movies;
    default: return fallback;
  }
}
