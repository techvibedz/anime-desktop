// A source-direct home rail ("this season" / "movies"). Reads the source's own
// listing (lib/sourceRails) in one cheap GET (cached 12h) and renders a polished
// horizontal poster rail with hover scroll-arrows + an edge fade. Each card
// carries its real source URL, so clicking opens the detail page DIRECTLY.
// Ported from the mobile app (components/SourceRail.tsx).

import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getRail, type RailItem, type RailKind } from "../lib/sourceRails";
import { t } from "../lib/i18n";

const RAIL_SHOW = 20;

export function SourceRail({ kind, title }: { kind: RailKind; title: string }) {
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
    <section className="group/rail space-y-3">
      <div className="flex items-end justify-between">
        <h2 className="font-display text-xl font-bold text-white">{title}</h2>
        <Link
          to={`/popular/${kind}`}
          className="text-xs font-semibold uppercase tracking-wider text-accent hover:underline"
        >
          {t.seeAllShort} ←
        </Link>
      </div>

      <div className="relative">
        {/* Scroll arrows (desktop) — appear on rail hover */}
        <button
          onClick={() => scrollBy(-1)}
          aria-label="prev"
          className="absolute -start-3 top-1/2 z-20 hidden h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-white/10 bg-bg/90 text-white opacity-0 shadow-card backdrop-blur transition group-hover/rail:opacity-100 hover:bg-accent md:flex"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 16.59 10.83 12l4.58-4.59L14 6l-6 6 6 6z" /></svg>
        </button>
        <button
          onClick={() => scrollBy(1)}
          aria-label="next"
          className="absolute -end-3 top-1/2 z-20 hidden h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-white/10 bg-bg/90 text-white opacity-0 shadow-card backdrop-blur transition group-hover/rail:opacity-100 hover:bg-accent md:flex"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z" /></svg>
        </button>

        <div
          ref={scrollRef}
          className="flex snap-x gap-3 overflow-x-auto scroll-smooth pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {shown.map((it) => (
            <button
              key={it.id}
              type="button"
              onClick={() => navigate(`/anime/${encodeURIComponent(it.href)}`)}
              className="group/card block w-[140px] shrink-0 snap-start text-start"
            >
              <div className="relative aspect-[2/3] overflow-hidden rounded-xl border border-white/5 bg-surface shadow-card ring-accent/0 transition duration-200 group-hover/card:-translate-y-1 group-hover/card:ring-2 group-hover/card:ring-accent/60">
                {it.image ? (
                  <img
                    src={it.image}
                    alt={it.title}
                    loading="lazy"
                    decoding="async"
                    className="h-full w-full object-cover transition-transform duration-300 group-hover/card:scale-105"
                  />
                ) : (
                  <div className="h-full w-full shimmer" />
                )}
                <div className="absolute inset-x-0 bottom-0 h-3/5 bg-gradient-to-t from-black/90 via-black/30 to-transparent" />
                <div className="absolute inset-0 flex items-center justify-center opacity-0 transition group-hover/card:opacity-100">
                  <span className="flex h-12 w-12 items-center justify-center rounded-full bg-accent/90 shadow-glow">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z" /></svg>
                  </span>
                </div>
                <div className="absolute inset-x-0 bottom-0 p-2.5">
                  <h3 className="line-clamp-2 text-[12.5px] font-semibold leading-tight text-white drop-shadow">{it.title}</h3>
                </div>
              </div>
            </button>
          ))}
        </div>

        {/* Right edge fade hinting more content */}
        <div className="pointer-events-none absolute inset-y-0 end-0 w-12 bg-gradient-to-l from-bg to-transparent" />
      </div>
    </section>
  );
}
