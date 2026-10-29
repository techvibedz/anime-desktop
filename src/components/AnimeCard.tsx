import { memo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { AnimeItem, SearchResult, EpisodeItem } from "../lib/api";
import { extractEpisodeNumber } from "../lib/episode-utils";
import { CompletionBadge } from "./CompletionBadge";
import { MalCardBadge } from "./MalRating";
import { t } from "../lib/i18n";

type Item = AnimeItem | SearchResult;

export function PlayGlyph({ size = 14, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z" />
    </svg>
  );
}

/**
 * Poster artwork with the shared card chrome: 2:3 frame, hover lift + glow,
 * bottom scrim and an overlaid title (mobile DESIGN.md: grid cards are the
 * artwork alone — the title sits on the poster so no caption stretches a row).
 * Corner slots carry badges; they sit above the title band.
 */
export function PosterFrame({
  image, title, subtitle, topStart, topEnd, bottomEnd, overlay, titleLines = 2, eager,
}: {
  image: string | null | undefined;
  title: string;
  subtitle?: ReactNode;
  topStart?: ReactNode;
  topEnd?: ReactNode;
  bottomEnd?: ReactNode;
  overlay?: ReactNode;
  titleLines?: 1 | 2;
  eager?: boolean;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const show = !!image && failed !== image;
  return (
    <div className="relative aspect-[2/3] overflow-hidden rounded-card bg-surface shadow-card ring-1 ring-white/[0.04] transition duration-300 ease-out group-hover:-translate-y-1 group-hover:shadow-glow group-focus-visible:shadow-glow">
      {show ? (
        <img
          src={image!}
          alt=""
          className="h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.05]"
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          onError={() => setFailed(image!)}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-raised to-surface p-3 text-center">
          <span className="line-clamp-3 font-display text-sm font-bold text-text-muted">{title}</span>
        </div>
      )}
      <div className="poster-scrim pointer-events-none absolute inset-0" />
      {topStart && <div className="absolute start-2 top-2 z-10 flex flex-col items-start gap-1">{topStart}</div>}
      {topEnd}
      {overlay}
      <div className="absolute inset-x-0 bottom-0 z-10 p-2.5 pt-6">
        {bottomEnd && <div className="mb-1.5 flex justify-end">{bottomEnd}</div>}
        <h3 className={`${titleLines === 1 ? "line-clamp-1" : "line-clamp-2"} text-[13px] font-bold leading-snug text-white drop-shadow`}>
          {title}
        </h3>
        {subtitle && <div className="mt-0.5 line-clamp-1 text-[11px] font-semibold text-text-secondary">{subtitle}</div>}
      </div>
    </div>
  );
}

export function Pill({ children, tone = "dark" }: { children: ReactNode; tone?: "dark" | "accent" | "mint" | "gold" }) {
  const cls = {
    dark: "bg-black/70 text-white/90 backdrop-blur-sm",
    accent: "bg-accent text-on-accent",
    mint: "bg-mint text-on-accent",
    gold: "bg-gold text-on-accent",
  }[tone];
  return <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold leading-tight ${cls}`}>{children}</span>;
}

// Poster card for an anime. Memoized — the home hero tick must not re-render
// every poster.
export const AnimeCard = memo(function AnimeCard({ item, rank, eager }: { item: Item; rank?: number; eager?: boolean }) {
  const id = encodeURIComponent(item.href);
  const anime = item as AnimeItem;
  const card = (
    <Link to={`/anime/${id}`} className="group block w-full outline-none" title={item.title}>
      <PosterFrame
        image={item.image}
        title={item.title}
        eager={eager}
        topStart={
          <>
            {anime.isNew && <Pill tone="mint">{t.newBadge}</Pill>}
            {item.type && <Pill>{item.type}</Pill>}
          </>
        }
        topEnd={<MalCardBadge title={item.title} />}
        bottomEnd={<CompletionBadge hrefs={[item.href, ...Object.values(anime.sourceHrefs || {})]} titles={[item.title]} className="" />}
      />
    </Link>
  );
  if (rank == null) return card;
  // "Most watched" rails: a big outlined numeral tucked behind the poster's
  // leading edge, so the rank reads before the art (mobile rank rails).
  return (
    <div className={`relative ${rank >= 10 ? "ps-[92px]" : "ps-[52px]"}`}>
      <span
        aria-hidden
        className="pointer-events-none absolute bottom-[-6px] start-0 select-none font-display text-[150px] font-black leading-none tracking-tighter text-bg"
        style={{ WebkitTextStroke: "3px rgba(139,147,255,0.6)" }}
      >
        {rank}
      </span>
      <div className="relative z-10">{card}</div>
    </div>
  );
});

/**
 * "New episodes" card — wide cinematic frame (mobile EpisodeCardView). Opens
 * the action sheet so the user picks Watch vs the anime page.
 */
export const EpisodeCard = memo(function EpisodeCard({
  episode,
  onOpen,
}: {
  episode: EpisodeItem;
  onOpen: (ep: EpisodeItem) => void;
}) {
  const num = extractEpisodeNumber(episode.href, episode.title);
  const [failed, setFailed] = useState(false);
  const showImg = !!episode.image && !failed;
  const name = episode.animeTitle || episode.title;
  return (
    <button
      type="button"
      onClick={() => onOpen(episode)}
      className="group block w-full text-start outline-none"
      title={name}
    >
      <div className="relative aspect-video overflow-hidden rounded-card bg-surface shadow-card ring-1 ring-white/[0.04] transition duration-300 ease-out group-hover:-translate-y-1 group-hover:shadow-glow group-focus-visible:shadow-glow">
        {showImg ? (
          <img
            src={episode.image}
            alt=""
            className="h-full w-full object-cover object-[50%_25%] transition-transform duration-500 ease-out group-hover:scale-[1.05]"
            loading="lazy"
            decoding="async"
            onError={() => setFailed(true)}
          />
        ) : (
          <div className="h-full w-full bg-gradient-to-br from-raised to-surface" />
        )}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-bg/90 via-bg/10 to-transparent" />
        <CompletionBadge hrefs={[episode.animeHref]} titles={[episode.animeTitle]} className="absolute start-2.5 top-2.5" />
        <span className="absolute bottom-2.5 start-2.5 flex items-center gap-1.5 rounded-full bg-accent px-2.5 py-1 text-[11px] font-bold text-on-accent shadow-card">
          <PlayGlyph size={10} />
          {num != null ? `${t.episode} ${num}` : t.watchNow}
        </span>
        <span className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-200 group-hover:opacity-100">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white/95 text-on-accent shadow-lift">
            <PlayGlyph size={18} className="ms-0.5" />
          </span>
        </span>
      </div>
      <h3 className="mt-2.5 line-clamp-1 text-[14px] font-bold text-white">{name}</h3>
      {episode.animeTitle && num == null && (
        <p className="line-clamp-1 text-xs font-semibold text-text-muted">{episode.title}</p>
      )}
    </button>
  );
});
