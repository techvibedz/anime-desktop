// Full grid for a source-direct home rail ("this season" / "movies"). Reads the
// source's own listing (lib/sourceRails) — one cheap GET, cached 12h — and shows
// the whole list. Each card carries its real source URL, so clicking opens the
// detail page directly (no AniList, no per-tap resolution).
// Ported from the mobile app (app/popular/[kind].tsx).

import { useEffect, useState } from "react";
import { useParams, useNavigate, Navigate } from "react-router-dom";
import { getRail, type RailItem, type RailKind } from "../lib/sourceRails";
import { CatalogCard } from "../components/CatalogCard";
import { CompletionBadge } from "../components/CompletionBadge";
import { CardLayoutControl } from "../components/CardLayoutControl";
import { useCardLayout, type CardLayout } from "../lib/cardLayout";
import { Shimmer } from "../components/Shimmer";
import { t } from "../lib/i18n";

const VALID: RailKind[] = ["movies", "season"];

function titleFor(kind: RailKind): string {
  return kind === "movies" ? t.railMovies : t.railThisSeason;
}

// comfortable = the grid as it always was; compact packs one step denser;
// list renders one row per item (poster thumb + text).
const GRID: Record<CardLayout, string> = {
  comfortable: "grid grid-cols-6 gap-4",
  compact: "grid grid-cols-8 gap-3",
  list: "flex flex-col gap-2",
};

export function PopularPage() {
  const { layout, setLayout } = useCardLayout("popular");
  const { kind } = useParams<{ kind: string }>();
  const navigate = useNavigate();
  const [items, setItems] = useState<RailItem[] | null>(null);

  const valid = VALID.includes(kind as RailKind);

  useEffect(() => {
    if (!valid) return;
    let cancelled = false;
    setItems(null);
    getRail(kind as RailKind)
      .then((d) => { if (!cancelled) setItems(d); })
      .catch(() => { if (!cancelled) setItems([]); });
    return () => { cancelled = true; };
  }, [kind, valid]);

  if (!valid) return <Navigate to="/" replace />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-white">{titleFor(kind as RailKind)}</h1>
        <CardLayoutControl layout={layout} onChange={setLayout} />
      </div>
      {items === null ? (
        <div className={GRID[layout]}>
          {Array.from({ length: layout === "list" ? 6 : 18 }).map((_, i) => (
            <Shimmer key={i} className={layout === "list" ? "h-28" : "aspect-[2/3]"} />
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="text-text-muted">{t.noResults}</p>
      ) : layout === "list" ? (
        <div className="flex flex-col gap-2">
          {items.map((it) => (
            <button
              key={it.id}
              type="button"
              onClick={() => navigate(`/anime/${encodeURIComponent(it.href)}`)}
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
              </div>
            </button>
          ))}
        </div>
      ) : (
        <div className={GRID[layout]}>
          {items.map((it) => (
            <CatalogCard
              key={it.id}
              item={{ id: it.id, title: it.title, image: it.image, score: null }}
              onClick={() => navigate(`/anime/${encodeURIComponent(it.href)}`)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
