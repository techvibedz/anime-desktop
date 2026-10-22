// Shared manga building blocks (mobile components/MangaUI + ChapterRow parity),
// rendered with the manga ink-and-paper palette (tailwind `m-*`).

import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { findFallbackMangaCover } from "../../lib/manga/coverFallback";
import { mangaPosterUrl, upgradeMangaCover } from "../../lib/manga/cover";
import { mangaDetailPath } from "../../lib/manga/nav";
import type { MangaCard } from "../../lib/manga/types";
import type { CardLayout } from "../../lib/cardLayout";

/** Stroke icon — same voice as the sidebar icons. */
export function MIcon({ d, size = 20, className = "" }: { d: string; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className}>
      {d.split("|").map((p, i) => <path key={i} d={p} />)}
    </svg>
  );
}

export const ICONS = {
  book: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20|M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z|m21 21-4.3-4.3",
  filter: "M4 6h16|M7 12h10|M10 18h4",
  close: "M18 6 6 18|M6 6l12 12",
  back: "m9 18 6-6-6-6",
  forward: "m15 18-6-6 6-6",
  arrowLeft: "M19 12H5|m12 19-7-7 7-7",
  bookmark: "M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1Z",
  bookmarkFill: "M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1Z",
  check: "M20 6 9 17l-5-5",
  refresh: "M23 4v6h-6|M1 20v-6h6|M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15",
  offline: "M1 1l22 22|M16.72 11.06A10.94 10.94 0 0 1 19 12.55|M5 12.55a10.94 10.94 0 0 1 5.17-2.39|M10.71 5.05A16 16 0 0 1 22.58 9|M1.42 9a15.91 15.91 0 0 1 4.7-2.88|M8.53 16.11a6 6 0 0 1 6.95 0|M12 20h.01",
  alert: "M12 9v4|M12 17h.01|M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z",
  star: "m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z",
  swap: "M7 4v16|m3 16 4 4 4-4|M17 20V4|m21 8-4-4-4 4",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z|M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z",
  list: "M8 6h13|M8 12h13|M8 18h13|M3 6h.01|M3 12h.01|M3 18h.01",
  hash: "M4 9h16|M4 15h16|M10 3 8 21|M16 3l-2 18",
  maximize: "M8 3H5a2 2 0 0 0-2 2v3|M21 8V5a2 2 0 0 0-2-2h-3|M3 16v3a2 2 0 0 0 2 2h3|M16 21h3a2 2 0 0 0 2-2v-3",
} as const;

export function MangaSkeleton({ className = "", dark = false }: { className?: string; dark?: boolean }) {
  return <div className={`${dark ? "shimmer" : "shimmer-paper"} rounded ${className}`} />;
}

/** A real cover with a visible fallback, never a wallpaper crop. Per cover:
 * Photon-sized first, raw original if that errors; then the same work's cover
 * from other sources, then AniList; the label tile if all fail. */
export function MangaCover({ uri, alts, label, className = "", displayWidth = 280 }: {
  uri?: string | null; alts?: (string | null | undefined)[]; label: string; className?: string; displayWidth?: number;
}) {
  const [failed, setFailed] = useState<string[]>([]);
  const [rescue, setRescue] = useState<{ label: string; url: string } | null>(null);
  const requested = useRef<string | null>(null);
  const altKey = (alts ?? []).join("|");
  const rescueUrl = rescue?.label === label ? rescue.url : null;
  const candidates = useMemo(() => [...new Set([uri, ...(alts ?? []), rescueUrl]
    .filter((u): u is string => !!u)
    .flatMap((u) => [mangaPosterUrl(u, displayWidth), u])
    .filter((u): u is string => !!u))],
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [uri, altKey, rescueUrl, displayWidth]);
  const src = candidates.find((u) => !failed.includes(u));
  useEffect(() => {
    if (src || requested.current === label) return;
    requested.current = label;
    let alive = true;
    void findFallbackMangaCover(label).then((url) => { if (alive && url) setRescue({ label, url }); });
    return () => { alive = false; };
  }, [src, label]);
  return (
    <div className={`relative overflow-hidden rounded-md bg-m-wash ${className}`}>
      {src ? (
        <img src={src} alt={label} loading="lazy" decoding="async" draggable={false}
          className="absolute inset-0 h-full w-full object-cover"
          onError={() => setFailed((f) => [...f, src])} />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-3 text-center text-m-muted">
          <MIcon d={ICONS.book} size={28} />
          <span className="line-clamp-3 text-xs font-semibold">{label}</span>
        </div>
      )}
    </div>
  );
}

export function MangaCardTile({ card, layout = "comfortable", subtitle, rank, corner, width }: {
  card: MangaCard; layout?: CardLayout; subtitle?: string; rank?: number; corner?: ReactNode; width?: number;
}) {
  const list = layout === "list";
  const sub = subtitle ?? [card.type, card.latest].filter(Boolean).join(" · ");
  const cover = upgradeMangaCover(card.cover);
  const alts = card.coverAlts?.map(upgradeMangaCover);
  return (
    <div className={width ? "relative shrink-0" : "relative"} style={width ? { width } : undefined}>
      <Link to={mangaDetailPath(card)} title={card.title}
        className={list
          ? "flex items-center gap-4 border-b border-m-line py-3.5 transition-opacity hover:opacity-80"
          : "group block transition-transform hover:-translate-y-0.5"}>
        <div className={list ? "relative w-[88px] shrink-0" : "relative"}>
          <MangaCover uri={cover} alts={alts} label={card.title} displayWidth={list ? 88 : width ?? 200}
            className={`aspect-[2/3] w-full border border-m-line ${list ? "" : "shadow-sm group-hover:shadow-md"}`} />
          {rank != null && (
            <span className="absolute bottom-0 left-0 rounded-tr bg-m-ink px-2.5 py-1 font-mono text-sm font-bold text-m-sheet" dir="ltr">
              {String(rank).padStart(2, "0")}
            </span>
          )}
        </div>
        <div className={list ? "min-w-0 flex-1" : "space-y-0.5 pt-2"}>
          <div className={`line-clamp-2 font-bold text-m-ink ${list ? "text-base" : "text-[13px] leading-snug"}`}>{card.title}</div>
          {sub ? <div className={`text-xs font-semibold text-m-muted ${list ? "line-clamp-2" : "truncate"}`}>{sub}</div> : null}
          {list && <div className="mt-3 flex items-center gap-1.5 text-xs font-semibold text-m-accent">عرض العمل<MIcon d={ICONS.arrowLeft} size={14} /></div>}
        </div>
      </Link>
      {corner && <div className={`absolute ${list ? "end-2 top-2" : "end-1 top-1"}`}>{corner}</div>}
    </div>
  );
}

export function MangaState({ icon, variant = "empty", title, message, primary, dark = false }: {
  icon: string; variant?: "empty" | "error" | "loading";
  title: string; message?: string; primary?: { label: string; onClick: () => void; icon?: string }; dark?: boolean;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3.5 px-7 py-16 text-center">
      <div className={`flex h-[76px] w-[76px] items-center justify-center rounded-lg border ${dark ? "border-m-night-line bg-m-night-panel text-m-night-accent" : "border-m-line bg-m-sheet text-m-accent"}`}>
        {variant === "loading"
          ? <div className={`h-7 w-7 animate-spin rounded-full border-2 border-t-transparent ${dark ? "border-m-night-accent" : "border-m-accent"}`} />
          : <MIcon d={icon} size={30} />}
      </div>
      <div className={`text-lg font-bold ${dark ? "text-m-sheet" : "text-m-ink"}`}>{title}</div>
      {message && <div className={`max-w-xs text-sm ${dark ? "text-m-night-muted" : "text-m-muted"}`}>{message}</div>}
      {primary && (
        <button type="button" onClick={primary.onClick}
          className="mt-1.5 flex min-h-[48px] items-center gap-2.5 rounded bg-m-accent px-6 text-sm font-bold text-m-sheet transition-opacity hover:opacity-90">
          {primary.icon && <MIcon d={primary.icon} size={18} />}
          {primary.label}
        </button>
      )}
    </div>
  );
}

export function ChoiceChip({ label, active, onClick, disabled = false, dark = false }: {
  label: string; active: boolean; onClick: () => void; disabled?: boolean; dark?: boolean;
}) {
  const base = "min-h-[40px] rounded border px-4 text-sm font-bold transition-colors disabled:opacity-40";
  const tone = dark
    ? active ? "border-m-night-accent bg-m-night-accent text-m-night" : "border-m-night-line bg-m-night-panel text-m-night-muted hover:text-m-sheet"
    : active ? "border-m-ink bg-m-ink text-m-sheet" : "border-m-line bg-m-sheet text-m-ink hover:border-m-ink";
  return <button type="button" aria-pressed={active} disabled={disabled} onClick={onClick} className={`${base} ${tone}`}>{label}</button>;
}

/** Numbered chapter index, shared by details and the reader's chapter sheet. */
export const ChapterRow = memo(function ChapterRow({ number, title, date, read = false, active = false, onClick, onToggleRead, dark = false }: {
  number: string; title?: string | null; date?: string | null; read?: boolean; active?: boolean;
  onClick: () => void; onToggleRead?: () => void; dark?: boolean;
}) {
  const label = title || (active ? "أقرأ الآن" : read ? "تمت القراءة" : "جاهز للقراءة");
  const frame = dark
    ? active ? "border-m-night-accent bg-m-night-panel" : "border-m-night-line bg-m-night-panel/60 hover:bg-m-night-panel"
    : active ? "border-m-accent bg-m-accent-wash" : "border-m-line bg-m-sheet hover:border-m-ink/40";
  return (
    <div className={`group flex min-h-[72px] items-center rounded border px-3 py-2.5 transition-colors ${frame}`}
      onContextMenu={onToggleRead ? (e) => { e.preventDefault(); onToggleRead(); } : undefined}>
      <button type="button" onClick={onClick} className="flex min-w-0 flex-1 items-center text-start"
        aria-label={`الفصل ${number}${title ? `، ${title}` : ""}${read ? "، مقروء" : ""}`}>
        <div className={`flex w-[76px] shrink-0 flex-col items-center border-e ps-0 pe-2 ${dark ? "border-m-night-line" : active ? "border-m-accent" : "border-m-line"}`}>
          <span className={`text-[10px] font-semibold ${dark ? "text-m-night-muted" : "text-m-muted"}`}>الفصل</span>
          <span className={`max-w-full truncate font-mono text-[22px] font-bold leading-7 ${read ? "text-m-read" : dark ? "text-m-sheet" : "text-m-ink"}`} dir="ltr">{number}</span>
        </div>
        <div className="mx-3 min-w-0 flex-1">
          <div className={`line-clamp-2 text-sm font-bold ${dark ? "text-m-sheet" : "text-m-ink"}`}>{label}</div>
          {date ? <div className={`mt-0.5 truncate text-xs ${dark ? "text-m-night-muted" : "text-m-muted"}`}>{date}</div> : null}
        </div>
      </button>
      {onToggleRead ? (
        <button type="button" onClick={onToggleRead} title={read ? "تحديد كغير مقروء" : "تحديد كمقروء"}
          className={`flex h-9 w-9 items-center justify-center rounded-full transition-colors ${read ? "text-m-read" : dark ? "text-m-night-muted opacity-0 hover:text-m-sheet group-hover:opacity-100" : "text-m-muted opacity-0 hover:text-m-ink group-hover:opacity-100"}`}>
          <MIcon d={ICONS.check} size={18} />
        </button>
      ) : read ? (
        <span className="text-m-read"><MIcon d={ICONS.check} size={18} /></span>
      ) : (
        <span className={dark ? "text-m-night-muted" : "text-m-muted"}><MIcon d={ICONS.forward} size={16} /></span>
      )}
    </div>
  );
});

/** Shell for manga pages inside the app layout: paper canvas, full bleed. */
export function MangaPage({ children }: { children: ReactNode }) {
  return <div dir="rtl" className="-mx-8 -my-7 min-h-screen bg-m-paper px-8 py-7 text-m-ink">{children}</div>;
}
