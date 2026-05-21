import { useNavigate } from "react-router-dom";
import type { EpisodeItem } from "../lib/api";
import { extractEpisodeNumber } from "../lib/episode-utils";
import { toAnimeUrl } from "../lib/favorites";
import { t } from "../lib/i18n";

export function EpisodeActionModal({
  episode,
  onClose,
}: {
  episode: EpisodeItem | null;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  if (!episode) return null;
  const num = extractEpisodeNumber(episode.title, episode.href);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[min(440px,92vw)] overflow-hidden rounded-2xl border border-white/10 bg-surface shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative aspect-video w-full bg-bg">
          {episode.image && (
            <img src={episode.image} alt="" className="h-full w-full object-contain bg-black" />
          )}
          <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/90 to-transparent" />
          {num != null && (
            <span className="absolute end-3 top-3 rounded-md bg-accent px-2.5 py-1 text-xs font-bold text-white shadow-glow">
              {t.episode} {num}
            </span>
          )}
        </div>
        <div className="space-y-4 p-5">
          <div>
            <p className="line-clamp-1 text-[11px] font-bold uppercase tracking-wider text-accent">
              {episode.animeTitle}
            </p>
            <h3 className="line-clamp-2 font-display text-lg font-bold text-white">{episode.title}</h3>
          </div>
          <div className="space-y-2">
            <button
              onClick={() => {
                onClose();
                const rawAnime = episode.animeHref || episode.href;
                const animeUrl = rawAnime.includes("/anime/") ? rawAnime : (toAnimeUrl(rawAnime) ?? "");
                const params = new URLSearchParams();
                if (episode.image) params.set("img", episode.image);
                if (animeUrl) params.set("anime", animeUrl);
                const q = params.toString();
                navigate(`/watch/${encodeURIComponent(episode.href)}${q ? `?${q}` : ""}`);
              }}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent py-3 text-sm font-semibold text-white shadow-glow hover:brightness-110"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
              {t.watchEpisode}
            </button>
            <button
              onClick={() => {
                onClose();
                // The scraper sometimes returns an episode URL in animeHref
                // (from older caches). Normalize to a real /anime/ URL.
                const raw = episode.animeHref || episode.href;
                const animeUrl = raw.includes("/anime/") ? raw : (toAnimeUrl(raw) ?? raw);
                if (animeUrl) navigate(`/anime/${encodeURIComponent(animeUrl)}`);
              }}
              disabled={!episode.animeHref && !episode.href}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-white/10 bg-bg py-3 text-sm font-medium text-white hover:bg-white/5 disabled:opacity-40"
            >
              {t.openAnimePage}
            </button>
            <button
              onClick={onClose}
              className="w-full rounded-lg py-2 text-sm text-text-muted hover:text-white"
            >
              {t.cancel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
