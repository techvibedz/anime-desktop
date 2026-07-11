import { useEffect, useState } from "react";
import type { UpdateInfo } from "../preload-types";

/**
 * Floating bottom toast that appears when electron-updater
 * has downloaded a new release. Tapping the button installs + restarts.
 */
export function UpdateBanner() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    const offDownloaded = window.pantoufa?.onUpdateDownloaded?.((i) => {
      setError(null); // a successful download supersedes any earlier error
      setInfo(i);
    });
    const offError = window.pantoufa?.onUpdateError?.((e) => setError(e.message));
    return () => {
      offDownloaded?.();
      offError?.();
    };
  }, []);

  // Update failed (check/download/install) — show a dismissible error toast so
  // the failure is visible instead of silently doing nothing.
  if (!info && error) {
    return (
      <div className="fixed bottom-5 end-5 z-toast w-[min(420px,92vw)] overflow-hidden rounded-2xl border border-red-500/30 bg-raised shadow-card">
        <div className="flex items-start gap-3 p-4">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-bold text-red-400">فشل التحديث</p>
            <p className="mt-1 line-clamp-3 text-xs text-text-secondary" dir="ltr">{error}</p>
          </div>
          <button
            onClick={() => setError(null)}
            className="rounded-full p-1 text-text-muted hover:bg-white/5 hover:text-white"
            aria-label="إغلاق"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>
      </div>
    );
  }

  if (!info) return null;

  return (
    <div className="fixed bottom-5 end-5 z-toast w-[min(420px,92vw)] overflow-hidden rounded-2xl border border-accent/25 bg-raised shadow-card">
      <div className="space-y-3 p-4">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-accent">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="black">
              <path d="M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-bold text-accent">تحديث متاح</p>
            <h3 className="text-base font-bold text-white">
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
            className="flex-1 rounded-full bg-accent py-2.5 text-sm font-bold text-black transition-colors hover:bg-accent-bright disabled:opacity-60"
          >
            {installing ? "جارٍ التثبيت…" : "أعد التشغيل وتحديث"}
          </button>
          <button
            onClick={() => setInfo(null)}
            className="rounded-full border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-white/10"
          >
            لاحقًا
          </button>
        </div>
      </div>
    </div>
  );
}
