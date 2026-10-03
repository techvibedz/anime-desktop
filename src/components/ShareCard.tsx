// Poster-card share modal for the anime detail page. Ported from the mobile app
// (components/ShareCard.tsx). The desktop has no native share sheet, so both
// actions copy to the clipboard: "مشاركة" copies the share text, "نسخ الرابط"
// copies the site link — each with copied feedback. Closes on backdrop click,
// the close button, or Escape.

import { useEffect, useState } from "react";
import { t } from "../lib/i18n";

export interface ShareCardAnime {
  title: string;
  poster?: string | null;
  banner?: string | null;
  score?: string | null;
  genres?: string[];
  episodes?: number | null;
}

const SITE_URL = "https://pantoufa.pages.dev/";

function copyToClipboard(text: string) {
  try {
    void navigator.clipboard?.writeText(text)?.catch(() => {});
  } catch {}
}

export function ShareCard({
  visible,
  onClose,
  anime,
}: {
  visible: boolean;
  onClose: () => void;
  anime: ShareCardAnime;
}) {
  const [copied, setCopied] = useState<"share" | "link" | null>(null);

  useEffect(() => {
    if (!visible) return;
    setCopied(null);
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, onClose]);

  if (!visible) return null;
  const { title, poster, banner, score, genres, episodes } = anime;

  const feedback = (kind: "share" | "link") => {
    setCopied(kind);
    window.setTimeout(() => setCopied((current) => (current === kind ? null : current)), 1600);
  };

  const onShare = () => {
    copyToClipboard(score ? t.shareAnimeWithScore(title, score) : t.shareAnimePlain(title));
    feedback("share");
  };

  const onCopyLink = () => {
    copyToClipboard(SITE_URL);
    feedback("link");
  };

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center p-5"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t.shareCardTitle}
    >
      {banner ? (
        <img src={banner} alt="" aria-hidden className="absolute inset-0 h-full w-full object-cover" />
      ) : (
        <div className="absolute inset-0 bg-bg" />
      )}
      <div className="absolute inset-0 bg-black/75 backdrop-blur-sm" />

      <div
        className="relative w-[min(520px,94vw)] rounded-2xl border border-white/10 bg-surface p-5 shadow-card"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex gap-4">
          {poster ? (
            <img src={poster} alt="" className="h-44 w-32 shrink-0 rounded-xl object-cover" />
          ) : (
            <div className="flex h-44 w-32 shrink-0 items-center justify-center rounded-xl bg-raised text-text-muted">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="9" cy="9" r="2" />
                <path d="m21 15-4.35-4.35L5 21" />
              </svg>
            </div>
          )}
          <div className="min-w-0 flex-1">
            <h3 className="line-clamp-2 text-lg font-bold leading-snug text-white">{title}</h3>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {score && (
                <span className="inline-flex items-center gap-1 rounded-full border border-gold/35 bg-gold/10 px-2.5 py-1 text-xs font-bold text-gold">
                  <span aria-hidden>★</span> {score}
                </span>
              )}
              {episodes != null && episodes > 0 && (
                <span className="rounded-full border border-white/10 bg-raised px-2.5 py-1 text-xs font-semibold text-text-secondary">
                  {t.episodeCount(episodes)}
                </span>
              )}
              {(genres ?? []).slice(0, 3).map((genre, i) => (
                <span key={`${genre}-${i}`} className="max-w-full truncate rounded-full border border-accent/30 bg-accent/10 px-2.5 py-1 text-xs font-semibold text-accent">
                  {genre}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-4 border-t border-white/10 pt-3 text-end">
          <p className="text-sm font-bold text-text-secondary">{t.shareCardBrand}</p>
          <p className="text-xs text-text-muted" dir="ltr">{SITE_URL}</p>
          <p className="mt-0.5 text-[11px] text-text-muted">{t.shareCardHint}</p>
        </div>

        <div className="mt-4 flex flex-wrap gap-2.5">
          <button
            type="button"
            onClick={onShare}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-accent py-3 text-sm font-bold text-black transition-colors hover:bg-accent-bright"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <circle cx="18" cy="5" r="3" />
              <circle cx="6" cy="12" r="3" />
              <circle cx="18" cy="19" r="3" />
              <path d="m8.6 10.5 6.8-4M8.6 13.5l6.8 4" />
            </svg>
            {copied === "share" ? t.copied : t.shareCardShare}
          </button>
          <button
            type="button"
            onClick={onCopyLink}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-white/10 bg-raised py-3 text-sm font-semibold text-white transition-colors hover:bg-white/5"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07L11.6 4.3" />
              <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.4-1.4" />
            </svg>
            {copied === "link" ? t.linkCopied : t.copyLink}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-white/10 px-4 py-3 text-sm font-semibold text-text-muted transition-colors hover:text-white"
          >
            {t.shareCardClose}
          </button>
        </div>
      </div>
    </div>
  );
}
