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
import { Shimmer } from "../components/Shimmer";
import { t } from "../lib/i18n";

type SortMode = "popular" | "soon";
const DAY = 24 * 60 * 60;

function badgeFor(it: CatalogAnime): string | null {
  if (it.startAt) {
    const days = Math.ceil((it.startAt - Date.now() / 1000) / DAY);
    if (days > 0) return t.upcomingInDays(days);
    return t.upcomingSoon;
  }
  return arFormat(it.format);
}

export function UpcomingPage() {
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
      <div>
        <h1 className="text-2xl font-bold text-white">{t.upcomingTitle}</h1>
        <p className="mt-1 text-sm text-text-muted">{t.upcomingSub}</p>
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
        <div className="grid grid-cols-6 gap-4">
          {Array.from({ length: 18 }).map((_, i) => <Shimmer key={i} className="aspect-[2/3]" />)}
        </div>
      ) : sorted.length === 0 ? (
        <p className="text-text-muted">{t.noResults}</p>
      ) : (
        <div className="grid grid-cols-6 gap-4">
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
