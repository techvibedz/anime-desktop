import { nextCardLayout, type CardLayout } from "../lib/cardLayout";
import { t } from "../lib/i18n";

const OPTIONS: Record<CardLayout, { label: string; d: string }> = {
  compact: { label: t.cardLayoutCompact, d: "M4 4h4v16H4z|M10 4h4v16h-4z|M16 4h4v16h-4z" },
  comfortable: { label: t.cardLayoutComfortable, d: "M4 4h7v16H4z|M13 4h7v16h-7z" },
  list: { label: t.cardLayoutList, d: "M4 5h16|M4 12h16|M4 19h16" },
};

/** One press cycles compact → comfortable → list → compact. The icon is the current layout. */
export function CardLayoutControl({ layout, onChange }: {
  layout: CardLayout;
  onChange: (layout: CardLayout) => void;
}) {
  const current = OPTIONS[layout];
  return (
    <button
      type="button"
      aria-label={`${t.cardLayout}: ${current.label}`}
      title={`${t.cardLayoutHint} — ${current.label}`}
      onClick={() => onChange(nextCardLayout(layout))}
      className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-raised text-accent transition-colors hover:bg-white/5 active:opacity-75"
    >
      <svg
        width={21} height={21} viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
        aria-hidden
      >
        {current.d.split("|").map((p, i) => <path key={i} d={p} />)}
      </svg>
    </button>
  );
}
