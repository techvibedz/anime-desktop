// Anime News — article detail. The headline/snippet come from the feed's
// in-memory registry (or router state); the full body + inline images are
// scraped from the MAL news page and translated on open (fetchNewsArticle).
// Ported from the mobile app (app/news/[id].tsx).

import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { fetchNewsArticle, getNewsItem, type ArticleBlock, type NewsItem } from "../lib/news";
import { t } from "../lib/i18n";

export function NewsArticlePage() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const numId = Number(id);

  const item = useMemo(() => {
    const stateItem = (location.state as { item?: NewsItem } | null)?.item;
    if (stateItem && stateItem.id === numId) return stateItem;
    return getNewsItem(numId);
  }, [location.state, numId]);

  // undefined = loading · null = couldn't load (fall back to the notice) · [] none.
  const [blocks, setBlocks] = useState<ArticleBlock[] | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    setBlocks(undefined);
    fetchNewsArticle(numId)
      .then((b) => { if (alive) setBlocks(b); })
      .catch(() => { if (alive) setBlocks(null); });
    return () => { alive = false; };
  }, [numId]);

  if (!item) {
    return (
      <div className="flex flex-col items-center gap-3 py-24 text-center">
        <div className="flex h-20 w-20 items-center justify-center rounded-full border border-white/10 bg-surface text-accent">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2" />
            <path d="M18 14h-8" /><path d="M15 18h-5" /><path d="M10 6h8v4h-8V6Z" />
          </svg>
        </div>
        <h1 className="text-lg font-bold text-white">{t.newsNotFound}</h1>
        <p className="max-w-md text-sm leading-6 text-text-secondary">{t.newsNotFoundSub}</p>
        <Link
          to="/news"
          className="mt-2 rounded-full bg-accent px-6 py-3 text-sm font-bold text-black transition-colors hover:bg-accent-bright"
        >
          {t.newsBackToList}
        </Link>
      </div>
    );
  }

  const hasBody = Array.isArray(blocks) && blocks.length > 0;

  return (
    <article className="pb-12">
      {item.image && (
        <div className="relative -mx-8 -mt-7 h-[340px] overflow-hidden lg:h-[420px]">
          <img src={item.image} alt="" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-t from-bg via-bg/45 to-bg/10" />
        </div>
      )}

      <div className={`mx-auto max-w-3xl ${item.image ? "relative -mt-20" : "pt-2"}`}>
        <Link to="/news" className="text-sm text-text-muted transition-colors hover:text-white">→ {t.back}</Link>

        <div className="mt-8 flex items-center gap-2.5 text-xs">
          <span className="font-semibold text-accent">{t.newsTimeAgo(item.date)}</span>
          {item.tags && (
            <>
              <span className="h-1 w-1 rounded-full bg-text-muted" />
              <span className="line-clamp-1 text-text-muted">{item.tags}</span>
            </>
          )}
        </div>

        <h1 className="mt-3 text-2xl font-bold leading-snug text-white lg:text-3xl">{item.title}</h1>

        <div className="my-7 h-px bg-white/10" />

        {hasBody ? (
          <div className="space-y-6">
            {(blocks as ArticleBlock[]).map((b, i) =>
              b.type === "image" ? (
                <img
                  key={`img-${i}`}
                  src={b.value}
                  alt=""
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  className="w-full rounded-xl bg-raised"
                />
              ) : b.type === "video" ? (
                <div key={`vid-${i}`} className="aspect-video w-full overflow-hidden rounded-xl border border-white/5 bg-black">
                  <iframe
                    src={b.value}
                    title={t.watchTrailer}
                    allow="accelerometer; encrypted-media; gyroscope; picture-in-picture"
                    referrerPolicy="strict-origin-when-cross-origin"
                    allowFullScreen
                    className="h-full w-full border-0"
                  />
                </div>
              ) : (
                <p key={`txt-${i}`} className="whitespace-pre-line text-base leading-8 text-text-secondary">{b.value}</p>
              ),
            )}
          </div>
        ) : blocks === undefined ? (
          <div className="flex items-center justify-center gap-3 py-8 text-sm text-text-secondary">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
            {t.loading}
          </div>
        ) : (
          <p className="text-sm leading-7 text-text-secondary">{t.newsNotFoundSub}</p>
        )}
      </div>
    </article>
  );
}
