import { useEffect, useState } from "react";
import { listDownloadServers, type DownloadServer } from "../lib/api";
import { startDownload, type DownloadMeta } from "../lib/downloads";
import { t } from "../lib/i18n";

function sourceLabel(provider: string): string {
  if (provider === "vid3rb") return "Anime3rb";
  if (provider === "mp4upload") return "MP4Upload";
  return provider;
}

export function DownloadPicker({
  visible,
  meta,
  onClose,
}: {
  visible: boolean;
  meta: DownloadMeta | null;
  onClose: () => void;
}) {
  const [servers, setServers] = useState<DownloadServer[] | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!visible || !meta) { setServers(null); return; }
    let alive = true;
    setServers(null);
    listDownloadServers({
      episodeHref: meta.episodeHref,
      url4up: meta.url4up,
      url3rb: meta.url3rb,
      epNum: meta.epNum,
      animeTitle: meta.animeTitle,
      force: attempt > 0,
      onUpdate: (list) => { if (alive) setServers(list); },
    })
      .then((list) => { if (alive) setServers(list); })
      .catch(() => { if (alive) setServers([]); });
    return () => { alive = false; };
  }, [visible, meta, attempt]);

  const pick = (server: DownloadServer) => {
    if (!meta) return;
    void startDownload({ ...meta, server });
    onClose();
  };

  if (!visible) return null;
  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/75 p-5" onClick={onClose}>
      <div
        className="w-[min(420px,94vw)] rounded-2xl border border-white/10 bg-surface p-5 shadow-card"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t.chooseDownloadServer}
      >
        <h3 className="text-center text-lg font-bold text-white">{t.chooseDownloadServer}</h3>
        <p className="mt-1 text-center text-xs text-text-muted">{t.chooseDownloadServerSub}</p>

        <div className="mt-4 max-h-[55vh] space-y-2 overflow-y-auto pe-1">
          {servers === null ? (
            <div className="flex flex-col items-center gap-3 py-8 text-text-muted">
              <span className="h-7 w-7 animate-spin rounded-full border-2 border-accent border-t-transparent" />
              <span className="text-xs">{t.loadingServers}</span>
            </div>
          ) : servers.length === 0 ? (
            <div className="py-6 text-center">
              <p className="text-sm text-text-muted">{t.downloadNoServer}</p>
              <button onClick={() => setAttempt((value) => value + 1)} className="mt-3 rounded-full border border-accent/30 px-4 py-2 text-xs font-semibold text-accent hover:bg-accent/10">
                {t.retry}
              </button>
            </div>
          ) : servers.map((server) => (
            <button
              key={`${server.provider}-${server.iframeUrl}`}
              onClick={() => pick(server)}
              className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-bg/70 p-3 text-start transition hover:border-accent/50 hover:bg-white/5"
            >
              <span className={`min-w-12 rounded-full px-2 py-1 text-center text-xs font-extrabold ${server.quality === "FHD" ? "bg-accent/15 text-accent" : "bg-white/5 text-text-secondary"}`}>
                {server.quality || "MP4"}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-bold text-white">{server.name}</span>
                <span className="block text-[11px] text-text-muted">{sourceLabel(server.provider)}</span>
              </span>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" className="text-text-muted"><path d="M12 3v10.55l3.3-3.3 1.4 1.4L12 17.4l-4.7-4.75 1.4-1.4 3.3 3.3V3h2zM5 19h14v2H5z" /></svg>
            </button>
          ))}
        </div>

        <button onClick={onClose} className="mt-4 w-full rounded-xl py-2.5 text-sm font-semibold text-text-muted hover:bg-white/5 hover:text-white">
          {t.cancel}
        </button>
      </div>
    </div>
  );
}
