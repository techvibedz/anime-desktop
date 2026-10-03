// Report — issue-report form ported from the mobile app (app/report.tsx).
// Writes one row to the Supabase `reports` table via lib/reports (optional
// screenshot upload), then shows a success screen. Works signed-out too; the
// contact email is pre-filled from the signed-in user when available.

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { submitReport } from "../lib/reports";
import { t } from "../lib/i18n";

const CATEGORIES: { key: string; label: string }[] = [
  { key: "content", label: t.reportCatContent },
  { key: "playback", label: t.reportCatPlayback },
  { key: "crash", label: t.reportCatCrash },
  { key: "suggestion", label: t.reportCatSuggestion },
  { key: "other", label: t.reportCatOther },
];

export function ReportPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);

  const [category, setCategory] = useState("content");
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Session restore can finish after mount — fill the contact email once known
  // (never overwrite what the user typed).
  useEffect(() => {
    const em = user?.email;
    if (em) setEmail((prev) => prev || em);
  }, [user?.email]);

  function removeFile() {
    setFile(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!message.trim()) { setErr(t.reportErrorEmpty); return; }
    setBusy(true);
    setErr(null);
    const r = await submitReport({ message, category, email, screenshotFile: file });
    setBusy(false);
    if (r.ok) setDone(true);
    else setErr(t.reportErrorFailed);
  }

  if (done) {
    return (
      <div dir="rtl" className="mx-auto max-w-xl py-16 text-center">
        <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full border border-accent/30 bg-accent/10">
          <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent" aria-hidden>
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </div>
        <h1 className="mt-5 text-xl font-bold text-white">{t.reportSuccessTitle}</h1>
        <p className="mt-2 text-sm leading-6 text-text-muted">{t.reportSuccessSub}</p>
        <button
          onClick={() => navigate(-1)}
          className="mt-8 rounded-full bg-accent px-10 py-3 text-sm font-bold text-black transition-colors hover:bg-accent-bright"
        >
          {t.reportDone}
        </button>
      </div>
    );
  }

  return (
    <div dir="rtl" className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">{t.reportTitle}</h1>
        <p className="mt-1.5 text-sm leading-6 text-text-muted">{t.reportSub}</p>
      </div>

      <form onSubmit={onSubmit} className="space-y-5">
        <div className="space-y-2">
          <p className="text-xs font-bold text-text-muted">{t.reportCategory}</p>
          <div className="flex flex-wrap gap-2">
            {CATEGORIES.map((cat) => (
              <button
                key={cat.key}
                type="button"
                onClick={() => setCategory(cat.key)}
                className={`rounded-full border px-4 py-2 text-[13px] font-bold transition-colors ${
                  category === cat.key
                    ? "border-accent bg-accent text-black"
                    : "border-white/10 bg-surface text-text-secondary hover:border-white/25 hover:text-white"
                }`}
              >
                {cat.label}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <label htmlFor="report-message" className="text-xs font-bold text-text-muted">{t.reportMessageLabel}</label>
          <textarea
            id="report-message"
            rows={7}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={t.reportMessagePlaceholder}
            className="w-full resize-y rounded-xl border border-white/10 bg-surface p-4 text-sm leading-6 text-white placeholder:text-text-muted focus:border-accent focus:outline-none"
          />
        </div>

        <div className="space-y-2">
          <p className="text-xs font-bold text-text-muted">{t.reportScreenshot}</p>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          {file ? (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-surface px-4 py-3">
              <span className="min-w-0 truncate text-sm text-white" dir="ltr">{file.name}</span>
              <button
                type="button"
                onClick={removeFile}
                className="shrink-0 text-xs font-bold text-red-400 transition-colors hover:text-red-300"
              >
                {t.reportScreenshotRemove}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="flex h-12 w-full items-center justify-center rounded-xl border border-dashed border-accent/40 bg-accent/5 text-sm font-bold text-accent transition-colors hover:bg-accent/10"
            >
              {t.reportScreenshot}
            </button>
          )}
        </div>

        <div className="space-y-2">
          <label htmlFor="report-email" className="text-xs font-bold text-text-muted">{t.reportEmailLabel}</label>
          <input
            id="report-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t.emailPlaceholder}
            dir="ltr"
            className="h-12 w-full rounded-xl border border-white/10 bg-surface px-4 text-sm text-white placeholder:text-text-muted focus:border-accent focus:outline-none"
          />
        </div>

        {err ? <p className="text-sm font-semibold text-red-400">{err}</p> : null}

        <button
          type="submit"
          disabled={busy}
          className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-accent text-sm font-bold text-black transition-colors hover:bg-accent-bright disabled:opacity-60"
        >
          {busy && <span className="h-4 w-4 animate-spin rounded-full border-2 border-black/30 border-t-transparent" />}
          {busy ? t.reportSending : t.reportSubmit}
        </button>
      </form>
    </div>
  );
}
