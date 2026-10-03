// Upcoming anime — the most-anticipated titles that haven't aired yet. Data is
// AniList's NOT_YET_RELEASED feed (lib/seasons). Because the titles aren't
// released they can't be source-verified, so clicking a card opens its AniList
// detail page (/title/:id) rather than a source page.
// Ported from the mobile app (app/upcoming.tsx).

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchUpcomingAnime, type CatalogAnime } from "../lib/seasons";
import { arFormat } from "../lib/anilistLabels";
import { CatalogCard } from "../components/CatalogCard";
import { CompletionBadge } from "../components/CompletionBadge";
import { CardLayoutControl } from "../components/CardLayoutControl";
import { useCardLayout, type CardLayout } from "../lib/cardLayout";
import { Shimmer } from "../components/Shimmer";
import { t } from "../lib/i18n";

type SortMode = "popular" | "soon";
const DAY = 24 * 60 * 60;

// comfortable = the grid as it always was; compact packs one step denser;
// list renders one row per item (poster thumb + text).
const GRID: Record<CardLayout, string> = {
  comfortable: "grid grid-cols-6 gap-4",
  compact: "grid grid-cols-8 gap-3",
  list: "flex flex-col gap-2",
};

function badgeFor(it: CatalogAnime): string | null {
  if (it.startAt) {
    const days = Math.ceil((it.startAt - Date.now() / 1000) / DAY);
    if (days > 0) return t.upcomingInDays(days);
    return t.upcomingSoon;
  }
  return arFormat(it.format);
}

export function UpcomingPage() {
  const { layout, setLayout } = useCardLayout("upcoming");
  const navigate = useNavigate();
  const [items, setItems] = useState<CatalogAnime[] | null>(null);
  const [sort, setSort] = useState<SortMode>("popular");

  useEffect(() => {
    let cancelled = false;
    fetchUpcomingAnime()
      .then((d) => { if (!cancelled) setItems(d); })
      .catch(() => { if (!cancelled) setItems([]); });
    return () => { cancelled = true; };
  }, []);

  const sorted = useMemo(() => {
    if (!items) return null;
    if (sort === "soon") {
      return [...items].sort((a, b) => {
        if (a.startAt == null && b.startAt == null) return b.popularity - a.popularity;
        if (a.startAt == null) return 1;
        if (b.startAt == null) return -1;
        return a.startAt - b.startAt;
      });
    }
    return [...items].sort((a, b) => b.popularity - a.popularity);
  }, [items, sort]);

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">{t.upcomingTitle}</h1>
          <p className="mt-1 text-sm text-text-muted">{t.upcomingSub}</p>
        </div>
        <CardLayoutControl layout={layout} onChange={setLayout} />
      </div>

      <div className="flex gap-2">
        {(["popular", "soon"] as SortMode[]).map((m) => (
          <button
            key={m}
            onClick={() => setSort(m)}
            className={`rounded-full border px-4 py-1.5 text-sm font-semibold transition ${
              sort === m
                ? "border-accent bg-accent text-black"
                : "border-white/10 bg-surface text-text-secondary hover:border-white/30 hover:text-white"
            }`}
          >
            {m === "popular" ? t.upcomingFilterPopular : t.upcomingFilterSoon}
          </button>
        ))}
      </div>

      {sorted === null ? (
        <div className={GRID[layout]}>
          {Array.from({ length: layout === "list" ? 6 : 18 }).map((_, i) => (
            <Shimmer key={i} className={layout === "list" ? "h-28" : "aspect-[2/3]"} />
          ))}
        </div>
      ) : sorted.length === 0 ? (
        <p className="text-text-muted">{t.noResults}</p>
      ) : layout === "list" ? (
        <div className="flex flex-col gap-2">
          {sorted.map((it) => {
            const badge = badgeFor(it);
            return (
              <button
                key={it.id}
                type="button"
                onClick={() => navigate(`/title/${it.id}`)}
                className="group flex items-center gap-3 rounded-xl bg-surface p-2 text-start ring-1 ring-white/5 transition hover:ring-accent/50"
              >
                <div className="relative aspect-[2/3] w-16 shrink-0 overflow-hidden rounded-lg bg-bg">
                  {it.image ? (
                    <img src={it.image} alt={it.title} className="h-full w-full object-cover" loading="lazy" decoding="async" />
                  ) : (
                    <div className="h-full w-full shimmer" />
                  )}
                  <CompletionBadge titles={[it.title]} className="absolute bottom-1 end-1" />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="line-clamp-2 text-sm font-semibold text-text-secondary transition-colors group-hover:text-white">
                    {it.title}
                  </h3>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    {it.score != null && it.score > 0 && (
                      <span className="text-xs font-bold text-gold">★ {(it.score / 10).toFixed(1)}</span>
                    )}
                    {badge && <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] font-bold text-black">{badge}</span>}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      ) : (
        <div className={GRID[layout]}>
          {sorted.map((it) => (
            <CatalogCard
              key={it.id}
              item={{ id: it.id, title: it.title, image: it.image, score: it.score, badge: badgeFor(it) }}
              onClick={() => navigate(`/title/${it.id}`)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
