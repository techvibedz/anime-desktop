import { useEffect, useState, useRef, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import {
  fetchHome, fetchRecent, fetchAllAnime,
  type AnimeItem, type EpisodeItem, type SearchResult,
} from "../lib/api";
import { AnimeCard, EpisodeCard } from "../components/AnimeCard";
import { EpisodeActionModal } from "../components/EpisodeActionModal";
import { Shimmer } from "../components/Shimmer";
import { t } from "../lib/i18n";

type ItemKind = "anime" | "episode";

export function SeeAllPage() {
  const { section } = useParams<{ section: string }>();
  const [items, setItems] = useState<(AnimeItem | EpisodeItem | SearchResult)[]>([]);
  const [kind, setKind] = useState<ItemKind>("anime");
  const [title, setTitle] = useState("");
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [episodePopup, setEpisodePopup] = useState<EpisodeItem | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Initial load — figure out which kind of section this is.
  useEffect(() => {
    if (!section) return;
    setLoading(true);
    setItems([]);
    setPage(1);
    setHasMore(true);
    (async () => {
      try {
        if (section === "recently_updated") {
          setTitle(t.recentlyUpdated); setKind("episode");
          const r = await fetchRecent(1);
          setItems(r.data.episodes);
          setHasMore(r.data.hasNext && r.data.episodes.length > 0);
        } else if (section === "all_anime") {
          setTitle("جميع الأنميات"); setKind("anime");
          const r = await fetchAllAnime(1);
          setItems(r.data.items);
          setHasMore(r.data.hasNext && r.data.items.length > 0);
        } else {
          // Sections derived from the cached home payload — no pagination.
          const home = await fetchHome();
          const found = home.data.sections.find((s) => s.id === section);
          if (found) {
            setTitle(localizedTitle(section, found.title));
            setKind(found.type);
            setItems(found.items);
          }
          setHasMore(false);
        }
      } finally {
        setLoading(false);
      }
    })();
  }, [section]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    const next = page + 1;
    console.info(`[see-all] loading page ${next} of "${section}"`);
    try {
      if (section === "recently_updated") {
        const r = await fetchRecent(next);
        const fresh = r.data.episodes;
        if (fresh.length === 0) {
          console.info(`[see-all] page ${next} returned 0 episodes — end of list`);
          setHasMore(false);
        } else {
          setItems((prev) => {
            const merged = dedupe(prev.concat(fresh));
            if (merged.length === prev.length) {
              console.warn(`[see-all] page ${next} fetched ${fresh.length} items but all were duplicates — stopping`);
              setHasMore(false);
            }
            return merged;
          });
        }
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
    }, { rootMargin: "800px" });
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore, hasMore, loading, loadingMore, items.length]);

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Link to="/" className="text-text-muted hover:text-white">→ {t.back}</Link>
        <h1 className="font-display text-3xl font-extrabold">{title || t.loading}</h1>
      </div>
      {loading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          {Array.from({ length: 18 }).map((_, i) => <Shimmer key={i} className="aspect-[2/3]" />)}
        </div>
      ) : kind === "episode" ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {(items as EpisodeItem[]).map((it) => (
            <EpisodeCard key={it.href + it.animeHref} episode={it} onOpen={setEpisodePopup} />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
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
              className="rounded-full border border-white/10 bg-surface px-6 py-2.5 text-sm font-semibold text-white hover:border-accent hover:bg-accent/10"
            >
              عرض المزيد
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

function localizedTitle(id: string, fallback: string): string {
  switch (id) {
    case "trending": return t.trendingNow;
    case "recently_updated": return t.recentlyUpdated;
    case "tv_series": return t.tvSeries;
    case "movies": return t.movies;
    default: return fallback;
  }
}
