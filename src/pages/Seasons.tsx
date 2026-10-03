// Seasons browser — pick a season (current + previous ones) and see the anime
// that aired that season. Data is AniList's per-season catalogue (lib/seasons),
// then resolved against our own sources (resolveAvailableItems) so the grid only
// shows titles the app can actually open — and each kept card carries its real
// source URL, so clicking opens the detail page directly.
// Ported from the mobile app (app/seasons.tsx).

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchSeasonAnime, seasonOptions, type CatalogAnime } from "../lib/seasons";
import { resolveAvailableItems } from "../lib/schedule";
import { CatalogCard } from "../components/CatalogCard";
import { CompletionBadge } from "../components/CompletionBadge";
import { CardLayoutControl } from "../components/CardLayoutControl";
import { useCardLayout, type CardLayout } from "../lib/cardLayout";
import { Shimmer } from "../components/Shimmer";
import { t } from "../lib/i18n";

type Resolved = CatalogAnime & { sourceHref: string };

// comfortable = the grid as it always was; compact packs one step denser;
// list renders one row per item (poster thumb + text).
const GRID: Record<CardLayout, string> = {
  comfortable: "grid grid-cols-6 gap-4",
  compact: "grid grid-cols-8 gap-3",
  list: "flex flex-col gap-2",
};

export function SeasonsPage() {
  const { layout, setLayout } = useCardLayout("seasons");
  const navigate = useNavigate();
  const options = useMemo(() => seasonOptions(8), []);
  const [selected, setSelected] = useState(0);
  const [items, setItems] = useState<Resolved[]>([]);
  const [loading, setLoading] = useState(true);
  const runRef = useRef(0);

  useEffect(() => {
    const opt = options[selected];
    if (!opt) return;
    const run = ++runRef.current;
    setLoading(true);
    setItems([]);
    (async () => {
      const raw = await fetchSeasonAnime(opt.season, opt.year).catch(() => [] as CatalogAnime[]);
      if (runRef.current !== run) return;
      // Stream rows in as each title is confirmed available on our sources.
      await resolveAvailableItems(raw, (soFar) => {
        if (runRef.current === run) setItems(soFar as Resolved[]);
      });
      if (runRef.current === run) setLoading(false);
    })();
  }, [selected, options]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-white">{t.seasonsTitle}</h1>
        <CardLayoutControl layout={layout} onChange={setLayout} />
      </div>

      {/* Season selector */}
      <div className="flex flex-wrap gap-2">
        {options.map((o, i) => (
          <button
            key={`${o.season}-${o.year}`}
            onClick={() => setSelected(i)}
            className={`rounded-full border px-4 py-1.5 text-sm font-semibold transition ${
              selected === i
                ? "border-accent bg-accent text-black"
                : "border-white/10 bg-surface text-text-secondary hover:border-white/30 hover:text-white"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>

      {loading && items.length === 0 ? (
        <div className={GRID[layout]}>
          {Array.from({ length: layout === "list" ? 6 : 18 }).map((_, i) => (
            <Shimmer key={i} className={layout === "list" ? "h-28" : "aspect-[2/3]"} />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="py-16 text-center">
          <p className="font-semibold text-white">{t.seasonsEmpty}</p>
          <p className="mt-1 text-sm text-text-muted">{t.seasonsEmptySub}</p>
        </div>
      ) : (
        <>
          {layout === "list" ? (
            <div className="flex flex-col gap-2">
              {items.map((it) => (
                <button
                  key={it.id}
                  type="button"
                  onClick={() => navigate(`/anime/${encodeURIComponent(it.sourceHref)}`)}
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
                    {it.score != null && it.score > 0 && (
                      <p className="mt-1 text-xs font-bold text-gold">★ {(it.score / 10).toFixed(1)}</p>
                    )}
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className={GRID[layout]}>
              {items.map((it) => (
                <CatalogCard
                  key={it.id}
                  item={{ id: it.id, title: it.title, image: it.image, score: it.score }}
                  onClick={() => navigate(`/anime/${encodeURIComponent(it.sourceHref)}`)}
                />
              ))}
            </div>
          )}
          {loading && (
            <div className="flex justify-center py-4">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
            </div>
          )}
        </>
      )}
    </div>
  );
}
