// Poster grid/rail cell shared by the Seasons, Upcoming and Popular screens.
// Matches AnimeCard's visual language (clean 2:3 poster, title below, green
// hover ring). Ported from the mobile app (components/CatalogCard.tsx).

import { memo } from "react";
import { CompletionBadge } from "./CompletionBadge";
import { t } from "../lib/i18n";

export interface CatalogCardData {
  id: number;
  title: string;
  image: string | null;
  score: number | null;
  /** Small pill text pinned to the poster (e.g. air date / format). */
  badge?: string | null;
  /** Resolved source URL — when set, the card can open the detail page directly. */
  href?: string | null;
}

export const CatalogCard = memo(function CatalogCard({
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
      <div className="relative aspect-[2/3] overflow-hidden rounded-lg bg-surface ring-1 ring-transparent transition-shadow duration-200 group-hover:shadow-glow group-hover:ring-accent/50">
        {item.image ? (
          <img
            src={item.image}
            alt={item.title}
            className="h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.04]"
            loading="lazy"
            decoding="async"
          />
        ) : (
          <div className="h-full w-full shimmer" />
        )}
        {item.score != null && item.score > 0 && (
          <span className="absolute end-2 top-2 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] font-bold text-gold">
            ★ {(item.score / 10).toFixed(1)}
          </span>
        )}
        {item.badge && (
          <span className="absolute start-2 top-2 rounded-md bg-accent px-1.5 py-0.5 text-[10px] font-bold text-black">
            {item.badge}
          </span>
        )}
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60">
            <div className="h-7 w-7 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          </div>
        )}
        <CompletionBadge hrefs={[item.href]} titles={[item.title]} className="absolute bottom-2 end-2" />
      </div>
      <h3 className="mt-2 line-clamp-2 text-[13px] font-semibold leading-snug text-text-secondary transition-colors group-hover:text-white">
        {item.title}
      </h3>
    </button>
  );
});

// Tiny helper so screens can label a "no source" empty grid consistently.
export const catalogEmpty = { title: t.seasonsEmpty, sub: t.seasonsEmptySub };
