import { useEffect, useRef, useState } from "react";
import { askCompanion } from "../lib/companion";
import { t } from "../lib/i18n";

// رفيق الأنمي — spoiler-safe AI companion drawer, ported from the mobile
// watch screen's CompanionSheet. Purely presentational + self-contained: the
// parent (Watch page) passes the episode identity and mounts it conditionally,
// keyed by episode so the chat resets per episode.

type Msg = { role: "user" | "ai"; text: string };

export function CompanionPanel({
  title,
  spoilerBound,
  episodeTitle,
  seasonNumber,
  altTitle,
  onClose,
}: {
  title: string;
  /** Episode number the answers are capped at (strictly no spoilers past it). */
  spoilerBound: number;
  episodeTitle?: string;
  seasonNumber?: number;
  altTitle?: string;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false); // synchronous double-send guard
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  const reasonText = (reason: string) => {
    switch (reason) {
      case "signin": return t.companionSignIn;
      case "rate_limited": return t.companionRateLimited;
      case "unavailable": return t.companionUnavailable;
      default: return t.companionError;
    }
  };

  const send = async (mode: "chat" | "recap") => {
    if (busyRef.current || spoilerBound < 1) return;
    const question = input.trim();
    if (mode === "chat" && !question) return;
    // Snapshot BEFORE appending this turn so the model continues the thread.
    const history = messages
      .slice(-8)
      .map((m) => ({ role: m.role, text: m.text.slice(0, 400) }));
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setMessages((m) => [...m, { role: "user", text: mode === "recap" ? t.companionRecap : question }]);
    setInput("");
    try {
      const res = await askCompanion({
        mode,
        animeTitle: title || t.companion,
        epNum: spoilerBound,
        question: mode === "chat" ? question : undefined,
        episodeTitle: episodeTitle || undefined,
        seasonNumber: seasonNumber || undefined,
        altTitle: altTitle || undefined,
        history: mode === "chat" ? history : undefined,
      });
      if (res.ok) setMessages((m) => [...m, { role: "ai", text: res.answer }]);
      else setError(reasonText(res.reason));
    } catch {
      setError(t.companionError);
    }
    busyRef.current = false;
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-[10000] flex justify-end bg-black/60" onClick={onClose}>
      <div
        dir="rtl"
        role="dialog"
        aria-modal="true"
        aria-label={t.companion}
        className="flex h-full w-[min(420px,94vw)] flex-col border-l border-white/10 bg-bg p-4 shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-accent/30 bg-accent/15 text-accent">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.9 5.7L19.6 9.6l-5.7 1.9L12 17.2l-1.9-5.7L4.4 9.6l5.7-1.9L12 2zm6.5 12l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9.9-2.6z" /></svg>
            </span>
            <div>
              <p className="text-sm font-bold text-white">{t.companion}</p>
              <p className="text-[11px] text-text-muted">{t.companionSpoilerNote(spoilerBound)}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            title={t.cancel}
            className="rounded-lg p-1.5 text-text-muted transition hover:bg-white/10 hover:text-white"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" /></svg>
          </button>
        </div>

        {/* Messages */}
        <div ref={bodyRef} className="mt-3 flex-1 overflow-y-auto pe-1">
          {messages.length === 0 ? (
            <p className="py-4 text-sm leading-relaxed text-text-secondary">
              {t.companionWelcome(title)}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {messages.map((m, i) => (
                <div
                  key={`${m.role}-${i}`}
                  className={`max-w-[92%] whitespace-pre-line rounded-xl border px-3 py-2 text-sm leading-relaxed ${
                    m.role === "user"
                      ? "ml-auto border-accent/30 bg-accent/15 text-white"
                      : "mr-auto border-white/10 bg-surface text-text-secondary"
                  }`}
                >
                  {m.text}
                </div>
              ))}
              {busy && (
                <div className="mr-auto flex max-w-[92%] items-center gap-2 rounded-xl border border-white/10 bg-surface px-3 py-2 text-sm text-text-secondary">
                  <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                  {t.companionThinking}
                </div>
              )}
            </div>
          )}
        </div>

        {error && (
          <p className="mt-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-300">
            {error}
          </p>
        )}

        {/* Recap this episode */}
        <button
          onClick={() => void send("recap")}
          disabled={busy}
          className="mt-3 self-end rounded-full border border-accent/30 bg-accent/10 px-3 py-1.5 text-xs font-semibold text-accent transition hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t.companionRecap}
        </button>

        {/* Ask */}
        <form
          className="mt-2 flex items-center gap-2"
          onSubmit={(e) => { e.preventDefault(); void send("chat"); }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t.companionPlaceholder}
            maxLength={500}
            disabled={busy}
            className="h-11 min-w-0 flex-1 rounded-xl border border-white/10 bg-surface px-3 text-sm text-white placeholder:text-text-muted focus:border-accent/50 focus:outline-none disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            title={t.companionSend}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent text-black transition hover:bg-accent-bright disabled:cursor-not-allowed disabled:opacity-50"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" /></svg>
          </button>
        </form>
      </div>
    </div>
  );
}
