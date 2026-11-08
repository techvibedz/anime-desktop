// Pantoufa Wrapped — the user's anime year as a shareable story card (mobile
// app/wrapped.tsx + components/WrappedCard.tsx parity). Stats are computed on
// this device; only the summary is published, and only when the user shares.
// Desktop shares the public web card link (copied to the clipboard).

import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { fetchTopGenres, GENRE_AR, loadWrapped, publishWrapped, toPublicPayload, type WrappedStats } from "../lib/wrapped";
import { t } from "../lib/i18n";

const PERSONALITY_GLYPH: Record<string, string> = {
  night_owl: "🦉", marathoner: "🏃", completer: "🏆", explorer: "🧭", loyal: "💞", weekend: "🎉", fan: "✨",
};
const AR_MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];

function displayName(user: ReturnType<typeof useAuth>["user"]): string {
  const m = (user?.user_metadata ?? {}) as Record<string, string | undefined>;
  return m.custom_name || m.full_name || m.name || (user?.email ? user.email.split("@")[0] : "");
}

function Tile({ glyph, n, label, tint }: { glyph: string; n: number; label: string; tint: string }) {
  return (
    <div className="flex flex-1 items-center gap-3 rounded-2xl border border-white/[0.09] bg-white/[0.06] p-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-base" style={{ background: `${tint}26`, color: tint }}>
        {glyph}
      </span>
      <div className="min-w-0">
        <p className="font-display text-[22px] font-extrabold leading-7 text-white">{n}</p>
        <p className="truncate text-[11px] font-semibold text-white/60">{label}</p>
      </div>
    </div>
  );
}

function WrappedCard({ stats, name, genres }: { stats: WrappedStats; name: string; genres: string[] }) {
  const hours = Math.floor(stats.minutes / 60);
  const showHours = hours > 0;
  const maxMonth = Math.max(1, ...stats.months);
  const p = stats.personality;
  const top = stats.top.slice(0, 3);
  const backdrop = top.find((a) => a.image)?.image;
  return (
    <div className="relative w-full max-w-[420px] overflow-hidden rounded-[28px] bg-bg shadow-lift ring-1 ring-white/[0.06]" style={{ minHeight: 420 * 16 / 9 * 0.9 }}>
      {backdrop && (
        <img src={backdrop} alt="" className="absolute inset-0 h-full w-full scale-110 object-cover opacity-55 blur-2xl" />
      )}
      <div className="absolute inset-0" style={{ background: "linear-gradient(180deg, rgba(24,26,58,0.35) 0%, rgba(10,11,22,0.85) 32%, #08090C 62%, #08090C 100%)" }} />
      <div className="relative flex min-h-full flex-col p-5">
        <div className="flex items-center justify-between">
          <span className="text-[15px] font-bold text-white">بانتوفة</span>
          <span className="rounded-full border border-mint/35 bg-mint/15 px-2.5 py-1 font-display text-[11px] font-bold tracking-[0.15em] text-mint">
            WRAPPED {stats.year}
          </span>
        </div>
        <p className="mt-4 truncate text-sm font-semibold text-white/70">{name ? `سنة ${name} في الأنمي` : t.wrappedTitle}</p>
        <div className="mt-1">
          <p className="font-display text-[88px] font-black leading-[96px] text-white">{showHours ? hours : Math.round(stats.minutes)}</p>
          <p className="text-[17px] font-bold text-[#C9CCFF]">{showHours ? t.wrappedHours : t.wrappedMinutes}</p>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2.5">
          <Tile glyph="▶" n={stats.episodes} label={t.wrappedEpisodes} tint="#8B93FF" />
          <Tile glyph="▦" n={stats.animeCount} label={t.wrappedAnime} tint="#5EEAD4" />
          <Tile glyph="✓" n={stats.completedAnime} label={t.wrappedCompleted} tint="#7CE38B" />
          <Tile glyph="🔥" n={stats.longestStreak} label={t.wrappedStreak} tint="#FFB86B" />
        </div>

        <div className="mt-3.5 flex items-center gap-3 rounded-[20px] border border-accent/30 bg-accent/[0.12] p-3">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-white/[0.08] text-[26px]">{PERSONALITY_GLYPH[p] ?? "✨"}</span>
          <div className="min-w-0">
            <p className="text-[10.5px] font-bold text-mint">شخصيتك كمشاهد</p>
            <p className="truncate text-lg font-bold leading-7 text-white">{t.wrappedPersonality[p] ?? t.wrappedPersonality.fan}</p>
            <p className="line-clamp-2 text-[11.5px] leading-[18px] text-white/70">{t.wrappedPersonalityDesc(p, stats)}</p>
          </div>
        </div>

        {top.length > 0 && (
          <div className="mt-4">
            <p className="mb-2 text-[12.5px] font-bold text-white/60">{t.wrappedTop}</p>
            <div className="grid grid-cols-3 gap-2.5">
              {top.map((a, i) => (
                <div key={a.href || a.title} className="min-w-0">
                  <div className={`relative aspect-[1/1.42] overflow-hidden rounded-[14px] border bg-raised ${i === 0 ? "border-mint" : "border-white/10"}`}>
                    {a.image ? <img src={a.image} alt="" className="absolute inset-0 h-full w-full object-cover" /> : null}
                    <div className="absolute inset-x-0 bottom-0 h-[45%] bg-gradient-to-t from-black/75 to-transparent" />
                    <span className={`absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full font-display text-xs font-black ${i === 0 ? "bg-mint text-on-accent" : "bg-black/80 text-white"}`}>
                      {i + 1}
                    </span>
                    <span className="absolute inset-x-2 bottom-1.5 truncate text-[10px] font-semibold text-white">{t.episodeCount(a.episodes)}</span>
                  </div>
                  <p className="mt-1.5 line-clamp-2 text-[11.5px] font-bold leading-[17px] text-white">{a.title}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {genres.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {genres.slice(0, 4).map((g) => (
              <span key={g} className="rounded-full border border-accent/30 bg-accent/15 px-3 py-0.5 text-[11px] font-semibold text-[#D9DBFF]">{GENRE_AR[g] ?? g}</span>
            ))}
          </div>
        )}

        <div className="min-h-3 flex-1" />

        <div className="mt-3 rounded-[18px] border border-white/[0.08] bg-white/[0.04] p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-bold text-white/60">نشاطك على مدار السنة</span>
            {stats.topMonth != null && <span className="text-[11px] font-bold text-mint">الذروة: {AR_MONTHS[stats.topMonth]}</span>}
          </div>
          <div className="flex h-11 items-end">
            {stats.months.map((m, i) => (
              <div key={i} className="flex h-full flex-1 items-end justify-center">
                <div
                  className="w-[58%] rounded"
                  style={{
                    height: m > 0 ? Math.max(5, (m / maxMonth) * 44) : 3,
                    background: i === stats.topMonth ? "#5EEAD4" : m > 0 ? "rgba(139,147,255,0.7)" : "rgba(255,255,255,0.10)",
                  }}
                />
              </div>
            ))}
          </div>
          <div className="mt-1 flex">
            {stats.months.map((_, i) => (
              <span key={i} className={`flex-1 text-center font-display text-[9px] ${i === stats.topMonth ? "text-mint" : "text-white/40"}`}>{i + 1}</span>
            ))}
          </div>
        </div>

        <div className="mt-3 flex items-center justify-between">
          <span className="text-xs font-bold text-white/85">شاهد معنا على بانتوفة</span>
          <span className="font-display text-[10px] font-semibold text-white/45">pantoufa-join.pages.dev</span>
        </div>
      </div>
    </div>
  );
}

export function WrappedPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const name = displayName(user);
  const [stats, setStats] = useState<WrappedStats | null>(null);
  const [genres, setGenres] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void loadWrapped().then(async (s) => {
      if (!alive) return;
      setStats(s);
      const g = await fetchTopGenres(s);
      if (alive) setGenres(g);
    });
    return () => { alive = false; };
  }, []);

  const shareLink = useCallback(async () => {
    if (!stats || busy) return;
    setBusy(true);
    setMsg(null);
    const url = await publishWrapped(toPublicPayload(stats, name, genres));
    setBusy(false);
    if (!url) {
      setMsg(t.wrappedShareFailed);
      return;
    }
    try {
      await navigator.clipboard.writeText(t.wrappedShareText(stats.year, Math.floor(stats.minutes / 60), url));
      setMsg(t.linkCopied);
    } catch {
      setMsg(url);
    }
  }, [stats, busy, name, genres]);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => navigate(-1)}
          aria-label={t.back}
          className="flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-white/[0.07] text-white hover:bg-white/[0.12]"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden><path d="m9 18 6-6-6-6" /></svg>
        </button>
        <h1 className="text-2xl font-extrabold text-white">{t.wrappedTitle}</h1>
      </div>

      {!stats ? (
        <div className="flex flex-col items-center gap-3 py-24 text-text-muted">
          <span className="h-9 w-9 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          <p className="text-sm">{t.wrappedLoading}</p>
        </div>
      ) : stats.episodes === 0 ? (
        <div className="flex flex-col items-center gap-2 py-24 text-center">
          <span className="text-5xl">✨</span>
          <p className="text-lg font-bold text-white">{t.wrappedEmptyTitle}</p>
          <p className="text-sm text-text-muted">{t.wrappedEmptyHint}</p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-4">
          <WrappedCard stats={stats} name={name} genres={genres} />
          <div className="w-full max-w-[420px] space-y-2">
            <button
              type="button"
              onClick={() => void shareLink()}
              disabled={busy}
              className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-accent text-[15px] font-bold text-on-accent transition hover:bg-accent-bright disabled:opacity-70"
            >
              {busy
                ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-black/25 border-t-black" />
                : <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" /></svg>}
              {t.wrappedShareLink}
            </button>
            {msg && <p className="break-all text-center text-xs font-semibold text-text-secondary">{msg}</p>}
            <p className="text-center text-[11px] text-text-muted">{t.wrappedPrivacy}</p>
          </div>
        </div>
      )}
    </div>
  );
}
