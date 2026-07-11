// A source-direct home rail ("this season" / "movies"). Reads the source's own
// listing (lib/sourceRails) in one cheap GET (cached 12h) and renders a
// horizontal poster rail with hover scroll-arrows + an edge fade. Each card
// carries its real source URL, so clicking opens the detail page DIRECTLY.
// Ported from the mobile app (components/SourceRail.tsx).

import { memo, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getRail, type RailItem, type RailKind } from "../lib/sourceRails";
import { t } from "../lib/i18n";

const RAIL_SHOW = 20;

export const SourceRail = memo(function SourceRail({ kind, title }: { kind: RailKind; title: string }) {
  const navigate = useNavigate();
  const [items, setItems] = useState<RailItem[] | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    // Defer slightly so the rail never competes with the home feed's first paint.
    const id = setTimeout(() => {
      getRail(kind)
        .then((data) => { if (!cancelled) setItems(data); })
        .catch(() => { if (!cancelled) setItems([]); });
    }, kind === "movies" ? 500 : 250);
    return () => { cancelled = true; clearTimeout(id); };
  }, [kind]);

  // Nothing yet / source unreachable → render nothing (rail stays hidden).
  if (!items || items.length === 0) return null;

  const shown = items.slice(0, RAIL_SHOW);
  const scrollBy = (dir: 1 | -1) => {
    scrollRef.current?.scrollBy({ left: dir * 560, behavior: "smooth" });
  };

  return (
    <section className="group/rail lazy-section space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-xl font-bold text-white">{title}</h2>
        <Link
          to={`/popular/${kind}`}
          className="text-xs font-semibold text-accent transition-colors hover:text-accent-bright"
        >
          {t.seeAllShort} ←
        </Link>
      </div>

      <div className="relative">
        {/* Scroll arrows (desktop) — appear on rail hover */}
        <button
          onClick={() => scrollBy(-1)}
          aria-label="prev"
          className="absolute -start-3 top-1/3 z-rail hidden h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-bg/90 text-white opacity-0 shadow-card transition group-hover/rail:opacity-100 hover:border-accent hover:text-accent md:flex"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 16.59 10.83 12l4.58-4.59L14 6l-6 6 6 6z" /></svg>
        </button>
        <button
          onClick={() => scrollBy(1)}
          aria-label="next"
          className="absolute -end-3 top-1/3 z-rail hidden h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-bg/90 text-white opacity-0 shadow-card transition group-hover/rail:opacity-100 hover:border-accent hover:text-accent md:flex"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z" /></svg>
        </button>

        <div
          ref={scrollRef}
          className="flex snap-x gap-4 overflow-x-auto scroll-smooth pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {shown.map((it) => (
            <button
              key={it.id}
              type="button"
              onClick={() => navigate(`/anime/${encodeURIComponent(it.href)}`)}
              className="group/card block w-[150px] shrink-0 snap-start text-start"
            >
              <div className="relative aspect-[2/3] overflow-hidden rounded-lg bg-surface ring-1 ring-transparent transition-shadow duration-200 group-hover/card:shadow-glow group-hover/card:ring-accent/50">
                {it.image ? (
                  <img
                    src={it.image}
                    alt={it.title}
                    loading="lazy"
                    decoding="async"
                    className="h-full w-full object-cover transition-transform duration-300 ease-out group-hover/card:scale-[1.04]"
                  />
                ) : (
                  <div className="h-full w-full shimmer" />
                )}
                <div className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 transition-opacity duration-200 group-hover/card:opacity-100">
                  <span className="flex h-12 w-12 items-center justify-center rounded-full bg-accent">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="black"><path d="M8 5v14l11-7z" /></svg>
                  </span>
                </div>
              </div>
              <h3 className="mt-2 line-clamp-2 text-[12.5px] font-semibold leading-snug text-text-secondary transition-colors group-hover/card:text-white">
                {it.title}
              </h3>
            </button>
          ))}
        </div>

        {/* Edge fade hinting more content */}
        <div className="pointer-events-none absolute inset-y-0 end-0 w-12 bg-gradient-to-l from-bg to-transparent" />
      </div>
    </section>
  );
});
