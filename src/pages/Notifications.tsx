import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  getNotifications,
  markAllRead,
  markRead,
  clearNotifications,
  syncEpisodeNotifications,
  subscribeNotifications,
  type AppNotification,
} from "../lib/notifications";
import { toAnimeUrl } from "../lib/favorites";
import { usePosterImage } from "../lib/posters";
import { t } from "../lib/i18n";

function timeAgo(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return t.justNow;
  if (mins < 60) return t.minutesAgo(mins);
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return t.hoursAgo(hrs);
  return t.daysAgo(Math.floor(hrs / 24));
}

function NotifThumb({ item }: { item: AppNotification }) {
  const poster = usePosterImage(item.image, item.animeHref || item.episodeHref);
  return (
    <div className="relative h-[92px] w-[84px] shrink-0 overflow-hidden rounded-lg bg-bg">
      {poster.src ? (
        <img
          src={poster.src}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={poster.onError}
          className="h-full w-full object-cover"
        />
      ) : poster.repairing ? (
        <div className="h-full w-full shimmer" />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-raised text-text-muted">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="m9 8.5 6 3.5-6 3.5v-7Z" />
          </svg>
        </div>
      )}
      <span className="absolute left-1/2 top-1/2 flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-gradient-to-br from-accent to-violet text-black shadow-glow">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M8 5v14l11-7L8 5Z" />
        </svg>
      </span>
    </div>
  );
}

export function NotificationsPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<AppNotification[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(() => {
    getNotifications().then(setItems).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const unsub = subscribeNotifications(load);
    const timer = setTimeout(() => { markAllRead().then(load).catch(() => {}); }, 600);
    return () => { clearTimeout(timer); unsub(); };
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await syncEpisodeNotifications({ force: true }).catch(() => {});
      setItems(await getNotifications());
    } catch {
    } finally {
      setRefreshing(false);
    }
  }, []);

  const open = useCallback((n: AppNotification) => {
    markRead(n.id).catch(() => {});
    const params = new URLSearchParams();
    if (n.image) params.set("img", n.image);
    const animeUrl = n.animeHref?.includes("/anime/") ? n.animeHref : (toAnimeUrl(n.episodeHref) ?? n.animeHref);
    if (animeUrl) params.set("anime", animeUrl);
    if (n.episodeNumber != null) params.set("ep", String(n.episodeNumber));
    const qs = params.toString();
    navigate(`/watch/${encodeURIComponent(n.episodeHref)}${qs ? `?${qs}` : ""}`);
  }, [navigate]);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">{t.notifications}</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={onRefresh}
            disabled={refreshing}
            title={t.refresh}
            className="rounded-lg border border-white/10 bg-surface p-2 text-text-muted transition hover:border-white/25 hover:text-white disabled:opacity-60"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={refreshing ? "animate-spin" : ""}>
              <path d="M23 4v6h-6" />
              <path d="M1 20v-6h6" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
          </button>
          {items.length > 0 && (
            <button
              onClick={() => { clearNotifications().then(load).catch(() => {}); }}
              title={t.remove}
              className="rounded-lg border border-white/10 bg-surface p-2 text-text-muted transition hover:border-red-500/40 hover:text-red-400"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M6 7h12v13a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V7zm3-3h6l1 2h4v2H4V6h4l1-2z" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-2xl border border-white/10 bg-surface text-text-muted">
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.7 21a2 2 0 0 1-3.4 0" />
              <path d="m3 3 18 18" />
            </svg>
          </div>
          <p className="mt-4 font-bold text-white">{t.notifEmpty}</p>
          <p className="mt-1 max-w-sm text-sm text-text-muted">{t.notifEmptySub}</p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {items.map((n) => (
            <button
              key={n.id}
              onClick={() => open(n)}
              className={`flex w-full items-center gap-4 rounded-xl border p-4 text-start transition ${
                n.read
                  ? "border-white/10 bg-surface hover:bg-raised"
                  : "border-accent/40 bg-raised hover:border-accent/60"
              }`}
            >
              <NotifThumb item={n} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  {!n.read && <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-accent" />}
                  <span className="line-clamp-1 text-xs font-bold text-accent">{t.notifNewEpisodeTitle}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-sm font-semibold leading-6 text-text">
                  {n.episodeNumber != null
                    ? t.notifNewEpisode(n.animeTitle, n.episodeNumber)
                    : t.notifNewEpisodeNoNum(n.animeTitle)}
                </p>
                <p className="mt-1 text-[11px] text-text-muted">{timeAgo(n.createdAt)}</p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
