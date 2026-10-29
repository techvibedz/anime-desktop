import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getFavorites, removeFavorite, type FavoriteAnime, type FavoriteList } from "../lib/favorites";
import { getHistory, type WatchEntry, isCompleted, progressPercent, subscribeHistory } from "../lib/history";
import { getCompletedAnime, type CompletedEntry } from "../lib/completion";
import { extractEpisodeNumber } from "../lib/episode-utils";
import { usePosterImage } from "../lib/posters";
import { CompletionBadge } from "../components/CompletionBadge";
import { CardLayoutControl } from "../components/CardLayoutControl";
import { PosterFrame } from "../components/AnimeCard";
import { useCardLayout, type CardLayout } from "../lib/cardLayout";
import { t } from "../lib/i18n";

type Tab = FavoriteList | "completed" | "history";

// comfortable = the default grid; compact packs one step denser; list renders
// one row per item (poster thumb + text).
const FAV_GRID: Record<CardLayout, string> = {
  comfortable: "grid grid-cols-3 gap-x-4 gap-y-5 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7",
  compact: "grid grid-cols-4 gap-3 md:grid-cols-5 lg:grid-cols-7 xl:grid-cols-8 2xl:grid-cols-9",
  list: "flex flex-col gap-2",
};
const HISTORY_GRID: Record<CardLayout, string> = {
  comfortable: "grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3",
  compact: "grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4",
  list: "flex flex-col gap-2.5",
};

export function MyListPage() {
  const { layout, setLayout } = useCardLayout("mylist");
  const [tab, setTab] = useState<Tab>("watching");
  const [favs, setFavs] = useState<FavoriteAnime[]>([]);
  const [history, setHistory] = useState<WatchEntry[]>([]);
  const [completed, setCompleted] = useState<CompletedEntry[]>([]);

  const reload = useCallback(async () => {
    const [f, h] = await Promise.all([getFavorites(), getHistory()]);
    setFavs(f);
    setHistory(h);
    // Completed shelf (mobile parity): finale watched or marked by hand, with
    // posters borrowed from history / My List.
    setCompleted(await getCompletedAnime(f.map((x) => ({ title: x.title, href: x.href, image: x.image }))).catch(() => []));
  }, []);
  useEffect(() => {
    void reload();
    return subscribeHistory(() => { void reload(); });
  }, [reload]);

  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: "watching", label: t.currentlyWatching, count: favs.filter((f) => f.list === "watching").length },
    { id: "planned", label: t.planToWatch, count: favs.filter((f) => f.list === "planned").length },
    { id: "completed", label: t.completedShelf, count: completed.length },
    { id: "history", label: t.history, count: history.length },
  ];

  const filtered = tab === "watching" || tab === "planned" ? favs.filter((f) => f.list === tab) : [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-[32px] font-extrabold text-white">{t.myListTitle}</h1>
        <CardLayoutControl layout={layout} onChange={setLayout} />
      </div>
      <div className="flex flex-wrap gap-2">
        {tabs.map((tabDef) => {
          const active = tab === tabDef.id;
          return (
            <button
              key={tabDef.id}
              type="button"
              onClick={() => setTab(tabDef.id)}
              className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm font-bold transition-colors ${
                active ? "bg-white text-on-accent" : "bg-white/[0.06] text-text-secondary hover:bg-white/[0.1] hover:text-white"
              }`}
            >
              {tabDef.label}
              <span className={`rounded-full px-1.5 py-px text-[10px] font-extrabold ${active ? "bg-on-accent/10" : "bg-white/[0.08] text-text-muted"}`}>
                {tabDef.count}
              </span>
            </button>
          );
        })}
      </div>

      {tab === "history" ? (
        history.length === 0 ? (
          <Empty msg={t.emptyHistory} />
        ) : (
          <div className={HISTORY_GRID[layout]}>
            {history.map((e) => <HistoryRow key={e.episodeHref} entry={e} />)}
          </div>
        )
      ) : tab === "completed" ? (
        completed.length === 0 ? (
          <Empty msg={t.emptyList} />
        ) : (
          <div className={FAV_GRID[layout]}>
            {completed.map((c) => (
              <FavRow key={c.key} fav={{ title: c.title, href: c.href, image: c.image || "", addedAt: c.updatedAt, list: "watching" }} layout={layout} completedShelf />
            ))}
          </div>
        )
      ) : filtered.length === 0 ? (
        <Empty msg={t.emptyList} />
      ) : (
        <div className={FAV_GRID[layout]}>
          {filtered.map((f) => (
            <FavRow key={f.href} fav={f} layout={layout} onRemove={async () => { await removeFavorite(f.href); void reload(); }} />
          ))}
        </div>
      )}
    </div>
  );
}

function FavRow({ fav, layout, onRemove, completedShelf }: { fav: FavoriteAnime; layout: CardLayout; onRemove?: () => void; completedShelf?: boolean }) {
  // Records synced from the cloud (or saved before witanime rotated TLDs) can
  // hold artwork from a retired host — re-resolve it from the anime page.
  const poster = usePosterImage(fav.image, fav.href);
  const removeBtn = onRemove && (
    <button
      type="button"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRemove(); }}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-black/70 text-white backdrop-blur-sm transition-colors hover:bg-danger"
      title={t.remove}
      aria-label={t.remove}
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" aria-hidden><path d="M18 6 6 18M6 6l12 12" /></svg>
    </button>
  );
  if (layout === "list") {
    return (
      <div className="group flex items-center gap-3 rounded-card bg-surface p-2 ring-1 ring-white/[0.05] transition hover:ring-accent/40">
        <Link to={`/anime/${encodeURIComponent(fav.href)}`} className="flex min-w-0 flex-1 items-center gap-3">
          <div className="relative aspect-[2/3] w-14 shrink-0 overflow-hidden rounded-lg bg-bg">
            {poster.src ? (
              <img src={poster.src} alt={fav.title} className="h-full w-full object-cover" loading="lazy" decoding="async" onError={poster.onError} />
            ) : (
              <div className={`h-full w-full ${poster.repairing ? "shimmer" : "bg-raised"}`} />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="line-clamp-2 text-sm font-bold text-white">{fav.title}</h3>
            <p className="mt-1 text-xs font-semibold text-text-muted">
              {completedShelf ? t.completedShelf : fav.list === "watching" ? t.currentlyWatching : t.planToWatch}
            </p>
          </div>
          <CompletionBadge hrefs={[fav.href]} titles={[fav.title]} className="shrink-0" />
        </Link>
        {removeBtn}
      </div>
    );
  }
  return (
    <div className="group relative">
      <Link to={`/anime/${encodeURIComponent(fav.href)}`} className="block outline-none" title={fav.title}>
        <PosterFrame
          image={poster.src ?? null}
          title={fav.title}
          bottomEnd={<CompletionBadge hrefs={[fav.href]} titles={[fav.title]} className="" />}
        />
      </Link>
      {removeBtn && <div className="absolute end-2 top-2 z-20 hidden group-hover:block">{removeBtn}</div>}
    </div>
  );
}

function HistoryRow({ entry }: { entry: WatchEntry }) {
  const poster = usePosterImage(entry.image, entry.animeHref || entry.episodeHref);
  const pct = Math.round(progressPercent(entry) * 100);
  const done = isCompleted(entry);
  const num = entry.epNum ?? extractEpisodeNumber(entry.episodeHref, entry.episodeTitle);
  const params = new URLSearchParams();
  if (poster.src) params.set("img", poster.src);
  if (entry.animeHref) params.set("anime", entry.animeHref);
  if (entry.url4up) params.set("up4", entry.url4up);
  if (entry.animeTitle) params.set("title", entry.animeTitle);
  if (num != null) params.set("ep", String(num));
  const qs = params.toString();
  return (
    <Link
      to={`/watch/${encodeURIComponent(entry.episodeHref)}${qs ? `?${qs}` : ""}`}
      className="group flex items-center gap-3.5 rounded-card bg-surface p-2.5 ring-1 ring-white/[0.05] transition hover:bg-raised hover:ring-accent/40"
    >
      <div className="relative aspect-video w-32 flex-shrink-0 overflow-hidden rounded-[10px] bg-bg">
        {poster.src ? (
          <img src={poster.src} alt="" className="h-full w-full object-cover object-[50%_25%]" loading="lazy" decoding="async" onError={poster.onError} />
        ) : (
          <div className={`h-full w-full ${poster.repairing ? "shimmer" : "bg-raised"}`} />
        )}
        <div className="absolute inset-x-0 bottom-0 h-1 bg-black/50">
          <div className={`h-full ${done ? "bg-mint" : "bg-accent"}`} style={{ width: `${done ? 100 : pct}%` }} />
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <p className="line-clamp-1 text-sm font-bold text-white">{entry.animeTitle || entry.episodeTitle}</p>
        <p className="mt-0.5 line-clamp-1 text-xs font-semibold text-text-muted">
          {[num != null ? `${t.episode} ${num}` : entry.episodeTitle, done ? t.watched : t.progressPercent(pct)].filter(Boolean).join(" · ")}
        </p>
      </div>
      {done && (
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-mint/15 text-mint">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6 9 17l-5-5" /></svg>
        </span>
      )}
    </Link>
  );
}

function Empty({ msg }: { msg: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-[22px] border border-dashed border-white/10 px-6 py-16 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-white/[0.05] text-text-muted">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1Z" /></svg>
      </span>
      <p className="text-sm font-semibold text-text-secondary">{msg}</p>
    </div>
  );
}
