import { Link } from "react-router-dom";
import type { AnimeItem, SearchResult, EpisodeItem } from "../lib/api";
import { extractEpisodeNumber } from "../lib/episode-utils";
import { t } from "../lib/i18n";

type Item = AnimeItem | SearchResult;

export function AnimeCard({ item }: { item: Item }) {
  const id = encodeURIComponent(item.href);
  return (
    <Link to={`/anime/${id}`} className="group block w-full">
      <div className="relative aspect-[2/3] overflow-hidden rounded-lg bg-surface">
        {item.image ? (
          <img
            src={item.image}
            alt={item.title}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
            loading="lazy"
          />
        ) : (
          <div className="h-full w-full shimmer" />
        )}
        <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/85 to-transparent" />
        {(item as AnimeItem).isNew && (
          <span className="absolute end-2 top-2 rounded-full bg-accent px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white shadow-glow">
            {t.newBadge}
          </span>
        )}
        {item.type && (
          <span className="absolute start-2 top-2 rounded-md bg-black/60 px-2 py-0.5 text-[10px] font-semibold text-white/90 backdrop-blur-sm">
            {item.type}
          </span>
        )}
        <div className="absolute inset-x-0 bottom-0 p-2.5">
          <h3 className="line-clamp-2 text-[13px] font-semibold leading-tight text-white">{item.title}</h3>
        </div>
      </div>
    </Link>
  );
}

/**
 * "Recently updated" episode card. Tapping it opens the action modal so the
 * user can choose between watching the episode directly or opening the parent
 * anime page (matches the mobile app's behavior).
 */
export function EpisodeCard({
  episode,
  onOpen,
}: {
  episode: EpisodeItem;
  onOpen: (ep: EpisodeItem) => void;
}) {
  const num = extractEpisodeNumber(episode.title, episode.href);
  return (
    <button
      type="button"
      onClick={() => onOpen(episode)}
      className="group block w-full text-start"
    >
      <div className="relative aspect-video overflow-hidden rounded-lg bg-surface">
        {episode.image ? (
          <img
            src={episode.image}
            alt={episode.title}
            // object-cover fills the card without the tall black bars
            // that appeared when the source image was a portrait poster.
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
            loading="lazy"
          />
        ) : (
          <div className="h-full w-full shimmer" />
        )}
        <div className="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/90 to-transparent" />
        {num != null && (
          <span className="absolute end-2 top-2 rounded-md bg-accent px-2 py-1 text-[11px] font-bold leading-none text-white shadow-glow">
            {t.episode} {num}
          </span>
        )}
        <div className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-accent shadow-glow">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z" /></svg>
          </div>
        </div>
        <div className="absolute inset-x-0 bottom-0 p-2.5">
          <p className="line-clamp-1 text-[10px] font-semibold uppercase tracking-wider text-accent">
            {episode.animeTitle}
          </p>
          <h3 className="line-clamp-1 text-[13px] font-semibold text-white">{episode.title}</h3>
        </div>
      </div>
    </button>
  );
}
