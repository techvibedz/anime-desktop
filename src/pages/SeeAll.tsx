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
    try {
      if (section === "recently_updated") {
        const r = await fetchRecent(next);
        if (r.data.episodes.length === 0) setHasMore(false);
        else setItems((prev) => dedupe(prev.concat(r.data.episodes)));
      } else if (section === "all_anime") {
        const r = await fetchAllAnime(next);
        if (r.data.items.length === 0) setHasMore(false);
        else setItems((prev) => dedupe(prev.concat(r.data.items)));
      } else {
        setHasMore(false);
      }
      setPage(next);
    } finally {
      setLoadingMore(false);
    }
  }, [page, section, hasMore, loadingMore]);

  // Infinite scroll via IntersectionObserver
  useEffect(() => {
    if (!sentinelRef.current || !hasMore) return;
    const el = sentinelRef.current;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) loadMore();
    }, { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore, hasMore]);

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
        <div ref={sentinelRef} className="flex items-center justify-center py-8">
          {loadingMore ? (
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          ) : (
            <span className="text-sm text-text-muted">{t.loading}</span>
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
