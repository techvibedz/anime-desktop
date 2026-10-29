// Poster grid/rail cell shared by the Seasons, Upcoming and Popular screens.
// Matches AnimeCard's visual language (clean 2:3 poster, title below, green
// hover ring). Ported from the mobile app (components/CatalogCard.tsx).

import { memo } from "react";
import { CompletionBadge } from "./CompletionBadge";
import { Pill, PosterFrame } from "./AnimeCard";
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
    <button type="button" onClick={onClick} className={"group block w-full text-start outline-none " + className} title={item.title}>
      <PosterFrame
        image={item.image}
        title={item.title}
        topStart={item.badge ? <Pill tone="accent">{item.badge}</Pill> : undefined}
        topEnd={item.score != null && item.score > 0 ? (
          <span className="absolute end-2 top-2 z-10 rounded-md bg-black/75 px-1.5 py-0.5 text-[10px] font-bold text-gold backdrop-blur-sm">
            ★ {(item.score / 10).toFixed(1)}
          </span>
        ) : undefined}
        bottomEnd={<CompletionBadge hrefs={[item.href]} titles={[item.title]} className="" />}
        overlay={loading ? (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60">
            <div className="h-7 w-7 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          </div>
        ) : undefined}
      />
    </button>
  );
});

// Tiny helper so screens can label a "no source" empty grid consistently.
export const catalogEmpty = { title: t.seasonsEmpty, sub: t.seasonsEmptySub };
