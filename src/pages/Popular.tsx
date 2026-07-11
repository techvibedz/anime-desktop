// Full grid for a source-direct home rail ("this season" / "movies"). Reads the
// source's own listing (lib/sourceRails) — one cheap GET, cached 12h — and shows
// the whole list. Each card carries its real source URL, so clicking opens the
// detail page directly (no AniList, no per-tap resolution).
// Ported from the mobile app (app/popular/[kind].tsx).

import { useEffect, useState } from "react";
import { useParams, useNavigate, Navigate } from "react-router-dom";
import { getRail, type RailItem, type RailKind } from "../lib/sourceRails";
import { CatalogCard } from "../components/CatalogCard";
import { Shimmer } from "../components/Shimmer";
import { t } from "../lib/i18n";

const VALID: RailKind[] = ["movies", "season"];

function titleFor(kind: RailKind): string {
  return kind === "movies" ? t.railMovies : t.railThisSeason;
}

export function PopularPage() {
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
      <h1 className="text-2xl font-bold text-white">{titleFor(kind as RailKind)}</h1>
      {items === null ? (
        <div className="grid grid-cols-6 gap-4">
          {Array.from({ length: 18 }).map((_, i) => <Shimmer key={i} className="aspect-[2/3]" />)}
        </div>
      ) : items.length === 0 ? (
        <p className="text-text-muted">{t.noResults}</p>
      ) : (
        <div className="grid grid-cols-6 gap-4">
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
