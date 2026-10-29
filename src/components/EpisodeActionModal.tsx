import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import type { EpisodeItem } from "../lib/api";
import { extractEpisodeNumber } from "../lib/episode-utils";
import { toAnimeUrl } from "../lib/favorites";
import { t } from "../lib/i18n";

// Episode tap → choose Watch vs the anime page (mobile EpisodeActionSheet).
export function EpisodeActionModal({
  episode,
  onClose,
}: {
  episode: EpisodeItem | null;
  onClose: () => void;
}) {
  const navigate = useNavigate();

  useEffect(() => {
    if (!episode) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [episode, onClose]);

  if (!episode) return null;
  const num = extractEpisodeNumber(episode.href, episode.title);
  // Cached payloads sometimes carry an episode URL in animeHref; normalize so
  // we always land on the real anime page.
  const raw = episode.animeHref || episode.href;
  const animeUrl = raw ? (toAnimeUrl(raw) ?? "") : "";

  const watch = () => {
    onClose();
    const params = new URLSearchParams();
    if (episode.image) params.set("img", episode.image);
    if (animeUrl) params.set("anime", animeUrl);
    if (episode.animeTitle) params.set("title", episode.animeTitle);
    if (num != null) params.set("ep", String(num));
    const q = params.toString();
    navigate(`/watch/${encodeURIComponent(episode.href)}${q ? `?${q}` : ""}`);
  };

  return (
    <div
      className="fixed inset-0 z-modal flex animate-fadeIn items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={episode.animeTitle || episode.title}
    >
      <div
        className="w-[min(460px,92vw)] animate-sheetUp overflow-hidden rounded-[22px] border border-white/[0.08] bg-surface shadow-lift"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative aspect-video w-full bg-black">
          {episode.image && (
            <img src={episode.image} alt="" className="h-full w-full object-cover object-[50%_25%]" />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-surface via-surface/30 to-transparent" />
          {num != null && (
            <span className="absolute end-3 top-3 rounded-full bg-accent px-3 py-1 text-xs font-extrabold text-on-accent">
              {t.episode} {num}
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label={t.cancel}
            className="absolute start-3 top-3 flex h-8 w-8 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur-sm hover:bg-black/80"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="space-y-4 p-5 pt-1">
          <div>
            <h3 className="line-clamp-2 text-xl font-extrabold leading-snug text-white">{episode.animeTitle || episode.title}</h3>
            {episode.animeTitle && <p className="mt-0.5 line-clamp-1 text-sm font-semibold text-text-muted">{episode.title}</p>}
          </div>
          <div className="grid gap-2.5">
            <button
              type="button"
              autoFocus
              onClick={watch}
              className="flex h-12 w-full items-center justify-center gap-2 rounded-control bg-accent text-[15px] font-extrabold text-on-accent transition-colors hover:bg-accent-bright"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M8 5v14l11-7z" /></svg>
              {t.watchEpisode}
            </button>
            <button
              type="button"
              onClick={() => {
                onClose();
                if (animeUrl) navigate(`/anime/${encodeURIComponent(animeUrl)}`);
              }}
              disabled={!animeUrl}
              className="flex h-12 w-full items-center justify-center gap-2 rounded-control border border-white/10 bg-white/[0.06] text-[15px] font-bold text-white transition-colors hover:bg-white/[0.12] disabled:opacity-40"
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>
              {t.openAnimePage}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
