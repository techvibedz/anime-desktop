// "Continue the story in the manga" card (anime detail page + end of the
// last episode in the player). Desktop port of the mobile component.
//
// Shows where this season ends in its source manga and opens the reader at
// the next chapter. Users can correct the chapter (one vote each); enough
// agreeing votes override the AI's answer for everyone.

import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { t } from "../lib/i18n";
import { openBridgeChapter, prefetchBridgeManga, voteMangaBridge, type BridgeInfo } from "../lib/mangaBridge";

function BookIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z" />
      <path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z" />
    </svg>
  );
}

function Spinner({ dark }: { dark?: boolean }) {
  return (
    <span
      className={`h-4 w-4 shrink-0 animate-spin rounded-full border-2 ${dark ? "border-black/25 border-t-black" : "border-white/30 border-t-white"}`}
      aria-hidden
    />
  );
}

export function MangaBridgeCard({
  info,
  animeTitle,
  onVoted,
  compact = false,
  beforeOpen,
}: {
  info: BridgeInfo;
  animeTitle: string;
  /** Called after a successful vote so the parent can re-fetch. */
  onVoted?: () => void;
  /** Player overlay variant: one line + the read button, no editor. */
  compact?: boolean;
  /** Hook to pause/clean up before navigating (player). */
  beforeOpen?: () => void;
}) {
  const navigate = useNavigate();
  const { payload, view } = info;
  const novel = payload.source === "light_novel" || payload.source === "web_novel";
  const [opening, setOpening] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [editing, setEditing] = useState(view.endChapter == null && !novel && !compact);
  const [value, setValue] = useState(view.endChapter != null ? String(view.endChapter) : "");
  const [sending, setSending] = useState(false);

  const open = useCallback(async () => {
    if (opening) return;
    setOpening(true);
    setMsg(null);
    const res = await openBridgeChapter(payload, animeTitle, view.continueChapter);
    setOpening(false);
    if (res.kind === "notfound") {
      setMsg(t.bridgeNotFound);
      return;
    }
    beforeOpen?.();
    if (res.kind === "detail" && view.continueChapter != null) setMsg(t.bridgeChapterMissing(view.continueChapter));
    navigate(res.path);
  }, [opening, payload, animeTitle, view.continueChapter, beforeOpen, navigate]);

  const submit = useCallback(async () => {
    const n = parseFloat(
      value.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[^\d.]/g, ""),
    );
    if (!(n > 0) || n >= 10000) {
      setMsg(t.bridgeInvalid);
      return;
    }
    setSending(true);
    const ok = await voteMangaBridge(info.key, n);
    setSending(false);
    if (ok) {
      setEditing(false);
      setMsg(t.bridgeThanks);
      onVoted?.();
    } else {
      setMsg(t.companionError);
    }
  }, [value, info.key, onVoted]);

  const canRead = view.continueChapter != null && (!novel || !!payload.mangaTitle);
  const willOpen = canRead || view.coversAll;

  // Resolve the manga in the sources while the user reads the card, so the
  // click opens the reader almost instantly instead of searching from scratch.
  useEffect(() => {
    if (!willOpen) return;
    const timer = setTimeout(() => prefetchBridgeManga(payload, animeTitle), 1200);
    return () => clearTimeout(timer);
  }, [willOpen, payload, animeTitle]);

  if (compact) {
    if (!canRead) return null;
    return (
      <div className="flex items-center gap-3 rounded-[14px] border border-mint/35 bg-black/85 p-3 backdrop-blur-md">
        <div className="min-w-0 flex-1">
          <p className="line-clamp-1 text-[13px] font-bold text-white">{t.bridgeAnimeEnded}</p>
          <p className="line-clamp-1 text-xs font-semibold text-mint">{t.bridgeContinueFrom(view.continueChapter!)}</p>
          {msg && <p className="mt-1 line-clamp-2 text-xs text-text-secondary">{msg}</p>}
        </div>
        <button
          type="button"
          onClick={open}
          disabled={opening}
          className="flex h-10 shrink-0 items-center gap-1.5 rounded-xl bg-mint px-4 text-[13px] font-bold text-on-accent transition hover:brightness-110 disabled:opacity-70"
        >
          {opening ? <Spinner dark /> : <BookIcon size={14} />}
          {t.bridgeRead}
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-mint/25 bg-mint/[0.06] p-4">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-mint/15 text-mint">
          <BookIcon size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-bold leading-6 text-white">{novel ? t.bridgeNovelTitle : t.bridgeTitle}</h3>
          {view.endChapter != null ? (
            <p className="text-xs font-medium leading-5 text-text-secondary">
              {view.coversAll ? t.bridgeCoversAll(view.endChapter) : t.bridgeEndsAt(view.endChapter)}
              {view.continueChapter != null ? ` · ${t.bridgeContinueFrom(view.continueChapter)}` : ""}
            </p>
          ) : novel && view.endVolume != null ? (
            <p className="text-xs font-medium leading-5 text-text-secondary">{t.bridgeEndsAtVolume(view.endVolume)}</p>
          ) : (
            <p className="text-xs font-medium leading-5 text-text-secondary">{t.bridgeUnknown}</p>
          )}
          {novel && view.endVolume != null && view.endChapter != null && (
            <p className="text-[11px] font-medium text-text-muted">{t.bridgeEndsAtVolume(view.endVolume)}</p>
          )}
        </div>
      </div>

      {(view.basis === "community" || view.uncertain || payload.airing) && view.endChapter != null && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {view.basis === "community" && (
            <span className="rounded-full border border-white/10 bg-white/[0.06] px-2 py-0.5 text-[10px] font-semibold text-text-secondary">
              {t.bridgeConfirmed(view.agree)}
            </span>
          )}
          {view.uncertain && (
            <span className="rounded-full border border-gold/30 bg-gold/10 px-2 py-0.5 text-[10px] font-semibold text-gold">
              {t.bridgeEstimate}
            </span>
          )}
          {payload.airing && (
            <span className="rounded-full border border-white/10 bg-white/[0.06] px-2 py-0.5 text-[10px] font-semibold text-text-secondary">
              {t.bridgeAiring}
            </span>
          )}
        </div>
      )}

      {payload.note && <p className="mt-2 text-xs leading-5 text-text-muted">{payload.note}</p>}

      {editing ? (
        <form
          className="mt-3 flex items-center gap-2"
          onSubmit={(e) => { e.preventDefault(); void submit(); }}
        >
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            inputMode="decimal"
            placeholder={t.bridgeChapterPlaceholder}
            aria-label={t.bridgeChapterPlaceholder}
            className="h-11 min-w-0 flex-1 rounded-xl border border-white/10 bg-raised px-3 font-display text-sm text-white outline-none placeholder:text-text-muted focus:border-mint/60"
          />
          <button
            type="submit"
            disabled={sending}
            className="flex h-11 min-w-[72px] items-center justify-center rounded-xl bg-mint px-4 text-[13px] font-bold text-on-accent disabled:opacity-70"
          >
            {sending ? <Spinner dark /> : t.bridgeSend}
          </button>
        </form>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {(canRead || view.coversAll) && (
            <button
              type="button"
              onClick={open}
              disabled={opening}
              className="flex h-11 max-w-full items-center gap-1.5 rounded-xl bg-mint px-4 text-[13px] font-bold text-on-accent transition hover:brightness-110 disabled:opacity-80"
            >
              {opening ? <Spinner dark /> : <BookIcon size={14} />}
              <span className="truncate">
                {opening ? t.bridgeSearching : canRead ? t.bridgeReadFrom(view.continueChapter!) : t.bridgeOpenManga}
              </span>
            </button>
          )}
          {!novel && (
            <button
              type="button"
              onClick={() => { setEditing(true); setMsg(null); }}
              className="flex h-11 items-center gap-1 px-3 text-xs font-semibold text-text-secondary transition hover:text-white"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4Z" /></svg>
              <span className="truncate">{info.mine != null ? t.bridgeYourVote(info.mine) : t.bridgeFix}</span>
            </button>
          )}
        </div>
      )}
      {msg && <p className="mt-2 text-xs leading-5 text-text-secondary">{msg}</p>}
    </div>
  );
}
