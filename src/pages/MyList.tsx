import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getFavorites, removeFavorite, type FavoriteAnime, type FavoriteList } from "../lib/favorites";
import { getHistory, type WatchEntry, isCompleted, progressPercent } from "../lib/history";
import { t } from "../lib/i18n";

const TABS: { id: FavoriteList | "history"; label: string }[] = [
  { id: "watching", label: t.currentlyWatching },
  { id: "planned", label: t.planToWatch },
  { id: "history", label: t.history },
];

export function MyListPage() {
  const [tab, setTab] = useState<FavoriteList | "history">("watching");
  const [favs, setFavs] = useState<FavoriteAnime[]>([]);
  const [history, setHistory] = useState<WatchEntry[]>([]);

  async function reload() {
    setFavs(await getFavorites());
    setHistory(await getHistory());
  }
  useEffect(() => { reload(); }, []);

  const filtered = tab === "history" ? null : favs.filter((f) => f.list === tab);

  return (
    <div className="space-y-6">
      <h1 className="font-display text-3xl font-extrabold">{t.myListTitle}</h1>
      <div className="flex gap-2 border-b border-white/10">
        {TABS.map((tabDef) => (
          <button
            key={tabDef.id}
            onClick={() => setTab(tabDef.id)}
            className={`relative px-4 py-2.5 text-sm font-semibold transition ${
              tab === tabDef.id ? "text-white" : "text-text-muted hover:text-white"
            }`}
          >
            {tabDef.label}
            {tab === tabDef.id && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" />}
          </button>
        ))}
      </div>

      {tab === "history" ? (
        history.length === 0 ? (
          <Empty msg={t.emptyHistory} />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {history.map((e) => <HistoryRow key={e.episodeHref} entry={e} />)}
          </div>
        )
      ) : filtered && filtered.length === 0 ? (
        <Empty msg={t.emptyList} />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {filtered!.map((f) => (
            <FavRow key={f.href} fav={f} onRemove={async () => { await removeFavorite(f.href); reload(); }} />
          ))}
        </div>
      )}
    </div>
  );
}

function FavRow({ fav, onRemove }: { fav: FavoriteAnime; onRemove: () => void }) {
  return (
    <div className="group relative">
      <Link to={`/anime/${encodeURIComponent(fav.href)}`} className="block">
        <div className="relative aspect-[2/3] overflow-hidden rounded-lg bg-surface">
          {fav.image && <img src={fav.image} alt={fav.title} className="h-full w-full object-cover" />}
          <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/90 to-transparent" />
          <div className="absolute inset-x-0 bottom-0 p-2.5">
            <h3 className="line-clamp-2 text-[13px] font-semibold leading-tight text-white">{fav.title}</h3>
          </div>
        </div>
      </Link>
      <button
        onClick={onRemove}
        className="absolute end-2 top-2 hidden h-7 w-7 items-center justify-center rounded-full bg-black/70 text-white group-hover:flex hover:bg-accent"
        title={t.remove}
      >
        ×
      </button>
    </div>
  );
}

function HistoryRow({ entry }: { entry: WatchEntry }) {
  const pct = Math.round(progressPercent(entry) * 100);
  const done = isCompleted(entry);
  const params = new URLSearchParams();
  if (entry.image) params.set("img", entry.image);
  if (entry.animeHref) params.set("anime", entry.animeHref);
  if (entry.url4up) params.set("up4", entry.url4up);
  const qs = params.toString();
  return (
    <Link
      to={`/watch/${encodeURIComponent(entry.episodeHref)}${qs ? `?${qs}` : ""}`}
      className="group flex items-center gap-3 rounded-lg border border-white/5 bg-surface p-2 hover:border-accent/40"
    >
      <div className="relative h-16 w-28 flex-shrink-0 overflow-hidden rounded bg-bg">
        {entry.image ? (
          <img src={entry.image} alt="" className="h-full w-full object-contain bg-black" />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-surface">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-text-muted">
              <path d="M15.5 2H8.6c-2 0-3.2 1.1-3.5 3-.3 1.9-.3 3.7 0 5.5.3 1.9 1.5 3 3.5 3h6.9c2 0 3.2-1.1 3.5-3 .3-1.8.3-3.6 0-5.5-.3-1.9-1.5-3-3.5-3Z" />
              <path d="M16 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
              <path d="M3.5 18c.5 1.9 1.7 3 3.7 3h9.6c2 0 3.3-1.1 3.7-3" />
            </svg>
          </div>
        )}
        <div className="absolute inset-x-0 bottom-0 h-1 bg-white/10">
          <div className="h-full bg-accent" style={{ width: `${done ? 100 : pct}%` }} />
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <p className="line-clamp-1 text-[11px] font-bold uppercase tracking-wider text-accent">{entry.animeTitle}</p>
        <p className="line-clamp-1 text-sm font-semibold text-white">{entry.episodeTitle}</p>
        <p className="text-xs text-text-muted">{done ? t.watched : t.progressPercent(pct)}</p>
      </div>
    </Link>
  );
}

function Empty({ msg }: { msg: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-white/10 bg-surface/50 p-10 text-center">
      <p className="text-text-secondary">{msg}</p>
    </div>
  );
}
