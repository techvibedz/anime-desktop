// MyAnimeList rating badges, backed by lib/malInfo (Jikan). Ported from the
// mobile app (components/MalRating.tsx).
//
// • <MalCardBadge> — compact corner pill for poster cards ("MAL ★ 8.74").
// • <MalBadge>     — larger inline badge for the anime detail header.
//
// Both fetch lazily by title and render nothing until (and unless) a score is
// available, so they're safe to drop onto any card without reserving layout.

import { useEffect, useState, type CSSProperties } from "react";
import { getMalRating, peekMalRating } from "../lib/malInfo";

const MAL_BLUE = "#2e51a2";

function fmt(score: number): string {
  return Number.isInteger(score) ? String(score) : score.toFixed(2).replace(/0$/, "");
}

/** Resolve a title's MAL score; null while loading or when there's no match. */
export function useMalRating(title: string | null | undefined): number | null {
  // Seed from the synchronous in-memory cache so an already-resolved score
  // paints on the first render instead of flashing in seconds later.
  const [score, setScore] = useState<number | null>(() => {
    const p = peekMalRating(title);
    return p === undefined ? null : p;
  });
  useEffect(() => {
    if (!title) { setScore(null); return; }
    const p = peekMalRating(title);
    if (p !== undefined) { setScore(p); return; } // already known — no fetch
    setScore(null);
    let cancelled = false;
    getMalRating(title).then((s) => { if (!cancelled) setScore(s); });
    return () => { cancelled = true; };
  }, [title]);
  return score;
}

/** Corner badge for poster cards. */
export function MalCardBadge({ title, style }: { title?: string | null; style?: CSSProperties }) {
  const score = useMalRating(title);
  return <MalScoreBadge score={score} style={style} />;
}

export function MalScoreBadge({ score, style }: { score: number | null; style?: CSSProperties }) {
  if (score == null) return null;
  return (
    <span
      style={style}
      className="absolute end-2 top-2 z-10 flex items-center gap-1 rounded-md border border-glass-border bg-black/80 px-1.5 py-0.5"
    >
      <span className="rounded-[3px] px-1 text-[8px] font-extrabold tracking-wide text-white" style={{ backgroundColor: MAL_BLUE }}>
        MAL
      </span>
      <span aria-hidden className="text-[9px] leading-none text-gold">★</span>
      <span className="text-[10px] font-bold leading-none text-white">{fmt(score)}</span>
    </span>
  );
}

/** Inline badge for the detail header. Pass the score you already resolved. */
export function MalBadge({ score }: { score: number | null }) {
  if (score == null) return null;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-glass-border bg-raised/80 px-2.5 py-1">
      <span className="rounded-[3px] px-1 text-[9px] font-extrabold tracking-wide text-white" style={{ backgroundColor: MAL_BLUE }}>
        MAL
      </span>
      <span aria-hidden className="text-xs leading-none text-gold">★</span>
      <span className="text-xs font-bold leading-none text-text">{fmt(score)}</span>
    </span>
  );
}
