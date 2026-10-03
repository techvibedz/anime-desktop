// Anime News — infinite feed of the latest MyAnimeList news, translated to
// Arabic. Brand safety is enforced in lib/news.ts (headline keyword guard).
// Ported from the mobile app (app/news.tsx).

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchNewsPage, resetNews, type NewsItem } from "../lib/news";
import { useOnlineStatus } from "../lib/net";
import { Shimmer } from "../components/Shimmer";
import { t } from "../lib/i18n";

export function NewsPage() {
  const navigate = useNavigate();
  const { online } = useOnlineStatus();
  const [items, setItems] = useState<NewsItem[] | null>(null);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const seenRef = useRef<Set<number>>(new Set());
  const sentinelRef = useRef<HTMLDivElement>(null);

  const loadFirst = useCallback(async () => {
    setItems(null);
    setPage(0);
    setHasMore(true);
    seenRef.current = new Set();
    try {
      const { items: batch, hasMore: more } = await fetchNewsPage(0);
      seenRef.current = new Set(batch.map((n) => n.id));
      setItems(batch);
      setHasMore(more);
    } catch {
      setItems([]);
    } finally {
      setRefreshing(false);
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || items === null) return;
    setLoadingMore(true);
    const next = page + 1;
    try {
      const { items: batch, hasMore: more } = await fetchNewsPage(next);
      setPage(next);
      setHasMore(more);
      const fresh = batch.filter((n) => !seenRef.current.has(n.id));
      fresh.forEach((n) => seenRef.current.add(n.id));
      setItems((prev) => [...(prev ?? []), ...fresh]);
    } catch {
      setHasMore(false);
    } finally {
      setLoadingMore(false);
    }
  }, [page, hasMore, loadingMore, items]);

  useEffect(() => {
    void loadFirst();
  }, [loadFirst]);

  useEffect(() => {
    if (!sentinelRef.current || !hasMore || items === null) return;
    const el = sentinelRef.current;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) void loadMore();
    }, { rootMargin: "1200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore, hasMore, items]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    resetNews();
    void loadFirst();
  }, [loadFirst]);

  const openArticle = useCallback((n: NewsItem) => {
    navigate(`/news/${n.id}`, { state: { item: n } });
  }, [navigate]);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-white">{t.newsTitle}</h1>
          <p className="mt-1 text-sm leading-relaxed text-text-muted">{t.newsSub}</p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="flex shrink-0 items-center gap-2 rounded-full border border-white/10 bg-surface px-4 py-2 text-xs font-semibold text-text-secondary transition hover:border-accent/50 hover:text-white disabled:opacity-60"
        >
          <svg
            width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            className={refreshing ? "animate-spin" : ""}
          >
            <path d="M23 4v6h-6" />
            <path d="M1 20v-6h6" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
          {t.refresh}
        </button>
      </div>

      {items === null ? (
        <div className="space-y-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="overflow-hidden rounded-xl border border-white/5 bg-surface p-5">
              <Shimmer className="mb-4 h-52 w-full rounded-lg" />
              <Shimmer className="mb-2 h-3.5 w-24" />
              <Shimmer className="h-6 w-3/4" />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="py-20 text-center">
          <p className="font-semibold text-white">{t.newsEmpty}</p>
          <p className="mx-auto mt-1.5 max-w-sm text-sm leading-6 text-text-muted">
            {online === false ? t.authErrors.offline : t.newsEmptySub}
          </p>
          <button
            type="button"
            onClick={onRefresh}
            className="mt-5 rounded-full bg-accent px-5 py-2.5 text-sm font-bold text-black transition-colors hover:bg-accent-bright"
          >
            {t.retry}
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {items.map((n) => <NewsCard key={n.id} item={n} onOpen={openArticle} />)}
        </div>
      )}

      {items !== null && items.length > 0 && hasMore && (
        <div ref={sentinelRef} className="flex flex-col items-center justify-center gap-3 py-6">
          {loadingMore ? (
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          ) : (
            <button
              type="button"
              onClick={loadMore}
              className="rounded-full border border-white/10 bg-surface px-6 py-2.5 text-sm font-semibold text-white hover:border-accent hover:bg-accent/10"
            >
              عرض المزيد
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function NewsCard({ item, onOpen }: { item: NewsItem; onOpen: (n: NewsItem) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      className="group block w-full overflow-hidden rounded-xl border border-white/10 bg-surface text-start shadow-card transition hover:border-accent/40"
    >
      {item.image && (
        <div className="relative h-56 overflow-hidden bg-raised">
          <img
            src={item.image}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.03]"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-surface via-surface/35 to-transparent" />
          {item.tags && (
            <span className="absolute start-3 top-3 flex max-w-[70%] items-center gap-1.5 rounded-full border border-accent/30 bg-black/60 px-3 py-1 text-[11px] font-semibold text-white backdrop-blur">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2" />
                <path d="M18 14h-8" /><path d="M15 18h-5" /><path d="M10 6h8v4h-8V6Z" />
              </svg>
              <span className="line-clamp-1">{item.tags}</span>
            </span>
          )}
        </div>
      )}

      <div className="space-y-2 p-5">
        <div className="flex items-center gap-2.5 text-[11px]">
          <span className="font-semibold text-accent">{t.newsTimeAgo(item.date)}</span>
          {!item.image && item.tags && (
            <>
              <span className="h-1 w-1 rounded-full bg-text-muted" />
              <span className="line-clamp-1 text-text-muted">{item.tags}</span>
            </>
          )}
        </div>
        <h2 className="line-clamp-3 text-xl font-bold leading-relaxed text-white">{item.title}</h2>
        <div className="flex items-center gap-1.5 pt-2 text-xs font-bold text-accent">
          {t.newsRead}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5" /><path d="m12 19-7-7 7-7" />
          </svg>
        </div>
      </div>
    </button>
  );
}
