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
import { Shimmer } from "../components/Shimmer";
import { t } from "../lib/i18n";

type Resolved = CatalogAnime & { sourceHref: string };

export function SeasonsPage() {
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
      <h1 className="font-display text-2xl font-extrabold text-white">{t.seasonsTitle}</h1>

      {/* Season selector */}
      <div className="flex flex-wrap gap-2">
        {options.map((o, i) => (
          <button
            key={`${o.season}-${o.year}`}
            onClick={() => setSelected(i)}
            className={`rounded-full border px-4 py-1.5 text-sm font-semibold transition ${
              selected === i
                ? "border-accent bg-accent text-white shadow-glow"
                : "border-white/10 bg-surface text-text-secondary hover:border-white/30 hover:text-white"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>

      {loading && items.length === 0 ? (
        <div className="grid grid-cols-6 gap-4">
          {Array.from({ length: 18 }).map((_, i) => <Shimmer key={i} className="aspect-[2/3]" />)}
        </div>
      ) : items.length === 0 ? (
        <div className="py-16 text-center">
          <p className="font-semibold text-white">{t.seasonsEmpty}</p>
          <p className="mt-1 text-sm text-text-muted">{t.seasonsEmptySub}</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-6 gap-4">
            {items.map((it) => (
              <CatalogCard
                key={it.id}
                item={{ id: it.id, title: it.title, image: it.image, score: it.score }}
                onClick={() => navigate(`/anime/${encodeURIComponent(it.sourceHref)}`)}
              />
            ))}
          </div>
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
