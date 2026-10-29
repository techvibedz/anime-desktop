// Horizontal content rail: section header (title + tick + "see all") and a
// snap-scrolling row with edge-hover arrows. RTL-aware: "next" scrolls toward
// the reading direction (left in Arabic).

import { Children, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { t } from "../lib/i18n";

export function SectionHeader({
  title, icon, to, linkState, onSeeAll, subtitle,
}: {
  title: string;
  icon?: ReactNode;
  to?: string;
  linkState?: unknown;
  onSeeAll?: () => void;
  subtitle?: string;
}) {
  const seeAll = "flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-bold text-accent transition-colors hover:bg-accent/10";
  const chevron = (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden><path d="m15 18-6-6 6-6" /></svg>
  );
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <div className="min-w-0">
        <h2 className="flex items-center gap-2.5 text-[22px] font-extrabold leading-tight text-white">
          {icon}
          <span className="truncate">{title}</span>
          <span className="section-tick mt-1" aria-hidden />
        </h2>
        {subtitle && <p className="mt-1 text-xs font-semibold text-text-muted">{subtitle}</p>}
      </div>
      {to ? (
        <Link to={to} state={linkState} className={seeAll}>{t.seeAllShort}{chevron}</Link>
      ) : onSeeAll ? (
        <button type="button" onClick={onSeeAll} className={seeAll}>{t.seeAllShort}{chevron}</button>
      ) : null}
    </div>
  );
}

export function Rail({
  children, itemWidth, gap = 16, className = "",
}: {
  children: ReactNode;
  /** CSS width of one item, e.g. "168px" or "clamp(...)". */
  itemWidth?: string;
  gap?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [canPrev, setCanPrev] = useState(false);
  const [canNext, setCanNext] = useState(false);

  // RTL scrollLeft runs 0 → negative. "Start" is 0; "end" is -(scrollWidth-clientWidth).
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const pos = Math.abs(el.scrollLeft);
    setCanPrev(pos > 4);
    setCanNext(pos < max - 4);
  }, []);

  useEffect(() => {
    measure();
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, children]);

  const page = (dir: 1 | -1) => {
    const el = ref.current;
    if (!el) return;
    // In RTL, moving forward means a more negative scrollLeft.
    el.scrollBy({ left: -dir * el.clientWidth * 0.85, behavior: "smooth" });
  };

  const arrow = "absolute top-0 bottom-0 z-rail my-auto flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-bg/90 text-white opacity-0 shadow-lift backdrop-blur-md transition duration-200 hover:border-accent hover:text-accent group-hover/rail:opacity-100 disabled:pointer-events-none disabled:!opacity-0";

  return (
    <div className={`group/rail relative -mx-8 ${className}`}>
      <button type="button" onClick={() => page(-1)} disabled={!canPrev} aria-label="prev" className={`${arrow} start-3`}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden><path d="m9 18 6-6-6-6" /></svg>
      </button>
      <div
        ref={ref}
        onScroll={measure}
        className="no-scrollbar flex snap-x snap-mandatory overflow-x-auto scroll-smooth px-8 pb-3 pt-2"
        style={{
          gap,
          scrollPaddingInline: 32,
          // Soft edges hint there's more to scroll without a hard crop.
          maskImage: `linear-gradient(to left, ${canPrev ? "transparent 0, #000 56px" : "#000 0"}, #000 calc(100% - 56px), ${canNext ? "transparent 100%" : "#000 100%"})`,
        }}
      >
        {Children.toArray(children).map((child, i) => (
          <div key={(child as { key?: string | null }).key ?? i} className="shrink-0 snap-start" style={itemWidth ? { width: itemWidth } : undefined}>
            {child}
          </div>
        ))}
      </div>
      <button type="button" onClick={() => page(1)} disabled={!canNext} aria-label="next" className={`${arrow} end-3`}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden><path d="m15 18-6-6 6-6" /></svg>
      </button>
    </div>
  );
}
