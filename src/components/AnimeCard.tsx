import { memo, useState } from "react";
import { Link } from "react-router-dom";
import type { AnimeItem, SearchResult, EpisodeItem } from "../lib/api";
import { extractEpisodeNumber } from "../lib/episode-utils";
import { CompletionBadge } from "./CompletionBadge";
import { t } from "../lib/i18n";

type Item = AnimeItem | SearchResult;

// Poster-forward card: artwork clean, title set below it. Memoized — home
// re-renders (hero carousel tick) must not re-render every poster.
export const AnimeCard = memo(function AnimeCard({ item }: { item: Item }) {
  const id = encodeURIComponent(item.href);
  const [imgFailed, setImgFailed] = useState(false);
  const showImg = item.image && !imgFailed;
  return (
    <Link to={`/anime/${id}`} className="group block w-full">
      <div className="relative aspect-[2/3] overflow-hidden rounded-lg bg-surface ring-1 ring-transparent transition-shadow duration-200 group-hover:shadow-glow group-hover:ring-accent/50">
        {showImg ? (
          <img
            src={item.image}
            alt={item.title}
            className="h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.04]"
            loading="lazy"
            decoding="async"
            onError={() => setImgFailed(true)}
          />
        ) : (
          <div className="h-full w-full shimmer" />
        )}
        {(item as AnimeItem).isNew && (
          <span className="absolute end-2 top-2 rounded-md bg-accent px-1.5 py-0.5 text-[10px] font-bold text-black">
            {t.newBadge}
          </span>
        )}
        {item.type && (
          <span className="absolute start-2 top-2 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-white/90">
            {item.type}
          </span>
        )}
        <CompletionBadge hrefs={[item.href]} titles={[item.title]} className="absolute bottom-2 end-2" />
      </div>
      <h3 className="mt-2 line-clamp-2 text-[13px] font-semibold leading-snug text-text-secondary transition-colors group-hover:text-white">
        {item.title}
      </h3>
    </Link>
  );
});

/**
 * "Recently updated" episode card. Tapping it opens the action modal so the
 * user can choose between watching the episode directly or opening the parent
 * anime page (matches the mobile app's behavior).
 */
export const EpisodeCard = memo(function EpisodeCard({
  episode,
  onOpen,
}: {
  episode: EpisodeItem;
  onOpen: (ep: EpisodeItem) => void;
}) {
  const num = extractEpisodeNumber(episode.title, episode.href);
  const [imgFailed, setImgFailed] = useState(false);
  const showImg = episode.image && !imgFailed;
  return (
    <button
      type="button"
      onClick={() => onOpen(episode)}
      className="group block w-full text-start"
    >
      <div className="relative aspect-[2/3] overflow-hidden rounded-lg bg-surface ring-1 ring-transparent transition-shadow duration-200 group-hover:shadow-glow group-hover:ring-accent/50">
        {showImg ? (
          <img
            src={episode.image}
            alt={episode.title}
            className="h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.04]"
            loading="lazy"
            decoding="async"
            onError={() => setImgFailed(true)}
          />
        ) : (
          <div className="h-full w-full shimmer" />
        )}
        {num != null && (
          <span className="absolute end-2 top-2 rounded-md bg-accent px-1.5 py-0.5 text-[11px] font-bold leading-tight text-black">
            {t.episode} {num}
          </span>
        )}
        <CompletionBadge
          hrefs={[episode.animeHref]}
          titles={[episode.animeTitle]}
          className="absolute start-2 top-2"
        />
        <div className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-accent">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="black"><path d="M8 5v14l11-7z" /></svg>
          </span>
        </div>
      </div>
      <p className="mt-2 line-clamp-1 text-[11px] font-semibold text-accent/90">{episode.animeTitle}</p>
      <h3 className="line-clamp-1 text-[13px] font-semibold text-text-secondary transition-colors group-hover:text-white">
        {episode.title}
      </h3>
    </button>
  );
});
