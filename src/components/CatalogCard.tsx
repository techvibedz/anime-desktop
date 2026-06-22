// Poster grid/rail cell shared by the Seasons, Upcoming and Popular screens and
// the home SourceRail. Matches AnimeCard's visual language (2:3 poster, gradient
// scrim, accent badges). Ported from the mobile app (components/CatalogCard.tsx).

import { t } from "../lib/i18n";

export interface CatalogCardData {
  id: number;
  title: string;
  image: string | null;
  score: number | null;
  /** Small pill text pinned to the poster's bottom (e.g. air date / format). */
  badge?: string | null;
  /** Resolved source URL — when set, the card can open the detail page directly. */
  href?: string | null;
}

export function CatalogCard({
  item,
  onClick,
  loading,
  className = "",
}: {
  item: CatalogCardData;
  onClick: () => void;
  /** Show a spinner overlay (e.g. while resolving the source URL on tap). */
  loading?: boolean;
  className?: string;
}) {
  return (
    <button type="button" onClick={onClick} className={`group block w-full text-start ${className}`}>
      <div className="relative aspect-[2/3] overflow-hidden rounded-lg bg-surface">
        {item.image ? (
          <img
            src={item.image}
            alt={item.title}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
            loading="lazy"
          />
        ) : (
          <div className="h-full w-full shimmer" />
        )}
        <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/85 to-transparent" />
        {item.score != null && item.score > 0 && (
          <span className="absolute end-2 top-2 flex items-center gap-0.5 rounded-md bg-black/65 px-1.5 py-0.5 text-[10px] font-bold text-amber-300 backdrop-blur-sm">
            ★ {(item.score / 10).toFixed(1)}
          </span>
        )}
        {item.badge && (
          <span className="absolute start-2 top-2 rounded-md bg-accent/85 px-2 py-0.5 text-[10px] font-semibold text-white backdrop-blur-sm">
            {item.badge}
          </span>
        )}
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60">
            <div className="h-7 w-7 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          </div>
        )}
        <div className="absolute inset-x-0 bottom-0 p-2.5">
          <h3 className="line-clamp-2 text-[13px] font-semibold leading-tight text-white">{item.title}</h3>
        </div>
      </div>
    </button>
  );
}

// Tiny helper so screens can label a "no source" empty grid consistently.
export const catalogEmpty = { title: t.seasonsEmpty, sub: t.seasonsEmptySub };
