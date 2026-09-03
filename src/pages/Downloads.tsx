// Downloads — episodes saved for offline viewing. Lists every download with live
// progress (subscribed to lib/downloads), plays completed ones from the local
// file (offline, no scraping) in an inline overlay player, and lets the user
// retry a failed one or delete. Ported from the mobile app (app/downloads.tsx).

import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  getDownloads, subscribeDownloads, deleteDownload, retryDownload, downloadFileUrl,
  formatBytes, type DownloadItem,
} from "../lib/downloads";
import { t } from "../lib/i18n";

function statusLabel(it: DownloadItem): string {
  switch (it.status) {
    case "resolving": return t.downloadResolving;
    case "downloading": return it.totalBytes > 0
      ? `${t.downloading} ${Math.round(it.progress * 100)}%`
      : t.downloading;
    case "completed": return t.downloaded;
    case "failed": return t.downloadFailed;
  }
}

export function DownloadsPage() {
  const [items, setItems] = useState<DownloadItem[]>([]);
  const navigate = useNavigate();

  const refresh = useCallback(() => { getDownloads().then(setItems); }, []);

  useEffect(() => {
    refresh();
    const unsub = subscribeDownloads(refresh);
    return unsub;
  }, [refresh]);

  const totalBytes = items.filter((i) => i.status === "completed").reduce((a, i) => a + (i.totalBytes || 0), 0);

  const playOffline = useCallback((item: DownloadItem) => {
    const local = downloadFileUrl(item.id);
    if (!local) return;
    const params = new URLSearchParams();
    params.set("local", local);
    if (item.image) params.set("img", item.image);
    if (item.animeTitle) params.set("title", item.animeTitle);
    if (item.animeHref) params.set("anime", item.animeHref);
    if (item.epNum != null) params.set("ep", String(item.epNum));
    navigate(`/watch/${encodeURIComponent(item.episodeHref)}?${params.toString()}`);
  }, [navigate]);

  return (
    <div className="space-y-5">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-bold text-white">{t.downloadsTitle}</h1>
        {totalBytes > 0 && <span className="text-xs text-text-muted">{t.storageUsed(formatBytes(totalBytes))}</span>}
      </div>

      {items.length === 0 ? (
        <div className="py-20 text-center">
          <p className="font-semibold text-white">{t.downloadsEmpty}</p>
          <p className="mt-1 text-sm text-text-muted">{t.downloadsEmptySub}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((it) => (
            <div key={it.id} className="flex items-center gap-3 rounded-xl border border-white/10 bg-surface p-2.5">
              <div className="h-16 w-12 shrink-0 overflow-hidden rounded-md bg-bg">
                {it.image ? <img src={it.image} alt="" referrerPolicy="no-referrer" onError={(event) => { event.currentTarget.style.display = "none"; }} className="h-full w-full object-cover" /> : <div className="h-full w-full shimmer" />}
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="line-clamp-1 font-semibold text-white">{it.animeTitle || it.episodeTitle}</h3>
                <p className="line-clamp-1 text-xs text-text-secondary">{it.episodeTitle}</p>
                <p className={`mt-0.5 text-xs ${it.status === "failed" ? "text-red-400" : "text-text-muted"}`}>{statusLabel(it)}</p>
                {it.status === "downloading" && (
                  <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-white/10">
                    <div className="h-full bg-accent transition-all" style={{ width: `${Math.round(it.progress * 100)}%` }} />
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {it.status === "completed" && (
                  <button onClick={() => playOffline(it)} title={t.playDownload} className="rounded-full bg-accent px-3 py-1.5 text-xs font-bold text-black transition-colors hover:bg-accent-bright">
                    {t.playDownload}
                  </button>
                )}
                {it.status === "failed" && (
                  <button onClick={() => retryDownload(it.id)} className="rounded-full border border-white/15 bg-bg px-3 py-1.5 text-xs font-semibold text-white hover:border-white/30">
                    {t.downloadRetry}
                  </button>
                )}
                <button
                  onClick={() => { if (confirm(t.confirmRemoveDownload)) deleteDownload(it.id); }}
                  title={t.removeDownload}
                  className="rounded-full border border-white/10 bg-bg p-2 text-text-muted transition hover:border-red-500/40 hover:text-red-400"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 7h12v13a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V7zm3-3h6l1 2h4v2H4V6h4l1-2z" /></svg>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

    </div>
  );
}
