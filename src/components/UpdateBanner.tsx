import { useEffect, useState } from "react";
import type { UpdateInfo } from "../preload-types";

/**
 * Floating bottom-right toast that appears when electron-updater
 * has downloaded a new release. Tapping the button installs + restarts.
 */
export function UpdateBanner() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    const off = window.pantoufa?.onUpdateDownloaded?.((i) => setInfo(i));
    return () => { off?.(); };
  }, []);

  if (!info) return null;

  return (
    <div className="fixed bottom-5 end-5 z-[200] w-[min(420px,92vw)] overflow-hidden rounded-2xl border border-accent/30 bg-surface shadow-card">
      <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-accent to-violet" />
      <div className="space-y-3 p-4">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-accent shadow-glow">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
              <path d="M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-bold uppercase tracking-wider text-accent">تحديث متاح</p>
            <h3 className="font-display text-base font-bold text-white">
              النسخة {info.version} جاهزة
            </h3>
            {info.releaseNotes && (
              <p className="mt-1 line-clamp-2 text-xs text-text-secondary">
                {info.releaseNotes.replace(/<[^>]*>/g, " ").slice(0, 160)}
              </p>
            )}
          </div>
          <button
            onClick={() => setInfo(null)}
            className="rounded-full p-1 text-text-muted hover:bg-white/5 hover:text-white"
            aria-label="إغلاق"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>
        <div className="flex gap-2">
          <button
            onClick={async () => {
              setInstalling(true);
              try { await window.pantoufa.installUpdate(); } catch { setInstalling(false); }
            }}
            disabled={installing}
            className="flex-1 rounded-lg bg-accent py-2.5 text-sm font-semibold text-white shadow-glow hover:brightness-110 disabled:opacity-60"
          >
            {installing ? "جارٍ التثبيت…" : "أعد التشغيل وتحديث"}
          </button>
          <button
            onClick={() => setInfo(null)}
            className="rounded-lg border border-white/10 bg-bg px-4 py-2.5 text-sm font-medium text-white hover:bg-white/5"
          >
            لاحقًا
          </button>
        </div>
      </div>
    </div>
  );
}
