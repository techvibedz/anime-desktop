// "مقترح لك حسب ذوقك" — taste-based recommendations (mobile app/for-you.tsx
// parity). Learned from what the user finishes, binges and drops; every pick
// explains itself. Filters and "not interested" re-rank locally (lib/taste).

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { arFormat, arGenre, arTag } from "../lib/anilistLabels";
import { resolveSourceUrl } from "../lib/schedule";
import { t } from "../lib/i18n";
import {
  computeTaste,
  hideRecommendation,
  preferredLength,
  readTasteBundle,
  topAffinities,
  unhideRecommendation,
  viewFromBundle,
  type ScoredCandidate,
  type TasteBundle,
  type TasteFilter,
  type TastePhase,
  type TasteReason,
  type TasteView,
} from "../lib/taste";

const FILTERS: { key: TasteFilter; label: string }[] = [
  { key: "all", label: t.tasteFilterAll },
  { key: "short", label: t.tasteFilterShort },
  { key: "finished", label: t.tasteFilterFinished },
  { key: "movie", label: t.tasteFilterMovie },
  { key: "airing", label: t.tasteFilterAiring },
];

function reasonText(r: TasteReason): string | null {
  switch (r.kind) {
    case "because": return t.tasteBecause(r.verdict, r.seed);
    case "genres": return t.tasteReasonGenres(r.genres.map(arGenre));
    case "theme": {
      const label = arTag(r.tag);
      return label ? t.tasteReasonTheme(label) : null;
    }
    case "length": return t.tasteReasonLength(r.bucket);
    case "studio": return t.tasteReasonStudio(r.studio);
    case "acclaimed": return t.tasteReasonAcclaimed((r.score / 10).toFixed(1));
  }
}

const REASON_ICON: Record<TasteReason["kind"], string> = {
  because: "♥", genres: "◆", theme: "✦", length: "◷", studio: "▣", acclaimed: "★",
};

function Fingerprint({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
      <path d="M12 11c0 3.5-.5 6.5-2 9M8 6.8A6 6 0 0 1 18 11c0 1.5-.1 3-.4 4.4M6 9.5A6 6 0 0 0 6 11c0 2-.4 3.8-1.2 5.3M15.5 13.5c-.2 2.4-.8 4.6-1.8 6.5M12 7a4 4 0 0 0-4 4c0 1.3-.1 2.6-.4 3.8M16 11a4 4 0 0 0-1.3-2.9" />
    </svg>
  );
}

export function ForYouPage() {
  const navigate = useNavigate();
  const [bundle, setBundle] = useState<TasteBundle | null>(null);
  const [view, setView] = useState<TasteView | null>(null);
  const [filter, setFilter] = useState<TasteFilter>("all");
  const [phase, setPhase] = useState<TastePhase | null>("reading");
  const [empty, setEmpty] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [undo, setUndo] = useState<ScoredCandidate | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const rerank = useCallback(async (b: TasteBundle, f: TasteFilter) => {
    setView(await viewFromBundle(b, f));
  }, []);

  const recompute = useCallback(async (force: boolean) => {
    const b = await computeTaste({ force, onPhase: (p) => setPhase(p === "done" ? null : p) });
    setPhase(null);
    if (!b) {
      setBundle((cur) => {
        if (!cur) setEmpty(true);
        return cur;
      });
      return;
    }
    setEmpty(false);
    setBundle(b);
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const cached = await readTasteBundle();
      if (!alive) return;
      if (cached) {
        setBundle(cached);
        setPhase(null);
      }
      await recompute(false);
    })();
    return () => { alive = false; };
  }, [recompute]);

  useEffect(() => {
    if (bundle) void rerank(bundle, filter);
  }, [bundle, filter, rerank]);

  useEffect(() => () => { if (undoTimer.current) clearTimeout(undoTimer.current); }, []);

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    await recompute(true);
    setRefreshing(false);
  };

  const onHide = async (item: ScoredCandidate) => {
    await hideRecommendation(item.media);
    if (bundle) await rerank(bundle, filter);
    setUndo(item);
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setUndo(null), 5000);
  };

  const onUndo = async () => {
    if (!undo) return;
    await unhideRecommendation(undo.media.id);
    setUndo(null);
    if (bundle) await rerank(bundle, filter);
  };

  const open = async (item: ScoredCandidate) => {
    if (busyId != null) return;
    setBusyId(item.media.id);
    try {
      const href = await resolveSourceUrl(item.media.title).catch(() => null)
        ?? (item.media.titleEnglish ? await resolveSourceUrl(item.media.titleEnglish).catch(() => null) : null);
      navigate(href ? `/anime/${encodeURIComponent(href)}` : `/title/${item.media.id}`);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-[32px] font-extrabold text-white">
            <span className="text-mint"><Fingerprint size={28} /></span>
            {t.tasteTitle}
          </h1>
          <p className="mt-1 text-sm font-semibold text-text-muted">{t.tasteSubtitle}</p>
        </div>
        {bundle && (
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing || !!phase}
            className="flex h-10 items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 text-xs font-bold text-white transition hover:bg-white/10 disabled:opacity-50"
          >
            {(refreshing || phase)
              ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/25 border-t-white" />
              : <span aria-hidden>↻</span>}
            {t.tasteRefresh}
          </button>
        )}
      </div>

      {!bundle && phase ? (
        <div className="flex flex-col items-center gap-3 py-24 text-center">
          <span className="h-10 w-10 animate-spin rounded-full border-[3px] border-accent/25 border-t-accent" />
          <p className="text-base font-bold text-white">{t.tastePhase(phase)}</p>
          <p className="text-xs text-text-muted">{t.tasteFirstRunHint}</p>
        </div>
      ) : !bundle && empty ? (
        <div className="flex flex-col items-center gap-3 py-24 text-center">
          <span className="text-5xl" aria-hidden>🎬</span>
          <p className="text-lg font-bold text-white">{t.tasteEmptyTitle}</p>
          <p className="text-sm text-text-muted">{t.tasteEmptyHint}</p>
          <button type="button" onClick={() => navigate("/search")} className="mt-2 rounded-full bg-accent px-6 py-2.5 text-sm font-bold text-on-accent hover:bg-accent-bright">
            {t.discover}
          </button>
        </div>
      ) : (
        <>
          {view && <TasteDNA view={view} />}

          <div className="flex flex-wrap gap-2">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                aria-pressed={filter === f.key}
                className={`h-10 rounded-full border px-5 text-[13px] font-bold transition ${
                  filter === f.key ? "border-accent bg-accent text-on-accent" : "border-white/[0.08] bg-surface text-text-secondary hover:border-accent/40"
                }`}
              >
                {f.label}
              </button>
            ))}
            {phase && bundle && (
              <span className="flex items-center gap-2 px-2 text-xs text-text-muted">
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent/25 border-t-accent" />
                {t.tasteUpdating}
              </span>
            )}
          </div>

          {view && view.ranked.length === 0 ? (
            <p className="py-12 text-center text-sm text-text-muted">{t.tasteNoMatch}</p>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {(view?.ranked ?? []).map((item) => (
                <RecCard key={item.media.id} item={item} busy={busyId === item.media.id} onOpen={open} onHide={onHide} />
              ))}
            </div>
          )}
        </>
      )}

      {undo && (
        <div className="fixed bottom-6 left-1/2 z-50 flex w-[min(92vw,460px)] -translate-x-1/2 items-center justify-between gap-4 rounded-2xl border border-white/10 bg-[#14161e]/95 px-5 py-3 shadow-2xl backdrop-blur">
          <span className="truncate text-sm font-semibold text-white">{t.tasteHidden}</span>
          <button type="button" onClick={() => void onUndo()} className="shrink-0 text-sm font-bold text-accent hover:underline">{t.tasteUndo}</button>
        </div>
      )}
    </div>
  );
}

const TasteDNA = memo(function TasteDNA({ view }: { view: TasteView }) {
  const { profile } = view;
  const genres = useMemo(
    () => topAffinities(profile.genres, 8).filter((g) => g.name !== "Ecchi" && g.name !== "Hentai").slice(0, 5),
    [profile],
  );
  const themes = useMemo(
    () => topAffinities(profile.tags, 10).map((x) => arTag(x.name)).filter((x): x is string => !!x).slice(0, 5),
    [profile],
  );
  const avoids = profile.avoided.slice(0, 3).map(arGenre);
  const top = genres[0]?.value || 1;
  const s = profile.stats;
  const length = preferredLength(profile);
  const facts: string[] = [];
  if (s.finished + s.dropped >= 2) facts.push(t.tasteFactCompletion(s.completionRate, s.finished));
  if (s.dropAt != null && s.dropped >= 2) facts.push(t.tasteFactDropAt(s.dropAt));
  if (s.pace >= 1.5) facts.push(t.tasteFactPace(s.pace));
  if (length) facts.push(t.tasteFactLength(length));
  if (avoids.length) facts.push(t.tasteFactAvoids(avoids));

  return (
    <section className="grid gap-6 rounded-[22px] border border-mint/25 bg-mint/[0.05] p-6 md:grid-cols-2">
      <div>
        <div className="mb-4 flex items-center gap-2">
          <span className="text-mint"><Fingerprint /></span>
          <h2 className="text-lg font-extrabold text-white">{t.tasteDnaTitle}</h2>
          <span className="ms-auto text-xs text-text-muted">{t.tasteDnaBasis(s.analysed)}</span>
        </div>
        <div className="space-y-2.5">
          {genres.map((g) => (
            <div key={g.name} className="flex items-center gap-3">
              <span className="w-28 shrink-0 truncate text-[13px] font-semibold text-text-secondary">{arGenre(g.name)}</span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
                <div className="h-full rounded-full bg-mint" style={{ width: `${Math.max(8, Math.round((g.value / top) * 100))}%` }} />
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="space-y-3">
        {themes.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {themes.map((th) => (
              <span key={th} className="rounded-full border border-accent/30 bg-accent/[0.14] px-3 py-1 text-xs font-semibold text-[#D9DBFF]">{th}</span>
            ))}
          </div>
        )}
        <ul className="space-y-2">
          {facts.map((f) => (
            <li key={f} className="flex items-start gap-2 text-[13px] leading-6 text-text-secondary">
              <span className="mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full bg-mint" aria-hidden />
              {f}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
});

const RecCard = memo(function RecCard({
  item, busy, onOpen, onHide,
}: {
  item: ScoredCandidate;
  busy: boolean;
  onOpen: (i: ScoredCandidate) => void;
  onHide: (i: ScoredCandidate) => void;
}) {
  const m = item.media;
  const reasons = item.reasons
    .map((r) => ({ r, text: reasonText(r) }))
    .filter((x): x is { r: TasteReason; text: string } => !!x.text)
    .slice(0, 3);
  const meta = [
    m.seasonYear,
    arFormat(m.format),
    m.format !== "MOVIE" && m.episodes ? t.episodeCount(m.episodes) : null,
    m.averageScore ? `★ ${(m.averageScore / 10).toFixed(1)}` : null,
  ].filter(Boolean).join(" · ");
  return (
    <div className="group relative flex gap-4 rounded-2xl border border-white/[0.06] bg-surface p-3 transition hover:border-accent/40 hover:bg-raised">
      <button
        type="button"
        onClick={() => onOpen(item)}
        disabled={busy}
        aria-label={`${m.title}، ${t.tasteMatch(item.match)}`}
        className="absolute inset-0 rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-accent"
      />
      <div className="pointer-events-none relative aspect-[2/3] w-28 shrink-0 overflow-hidden rounded-xl bg-raised">
        {m.image && <img src={m.image} alt="" loading="lazy" className="h-full w-full object-cover transition duration-500 group-hover:scale-105" />}
        <span className="absolute bottom-1.5 start-1.5 rounded-full border border-mint/45 bg-black/80 px-2 py-0.5 text-[11px] font-bold text-mint">{item.match}%</span>
        {busy && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/55">
            <span className="h-6 w-6 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          </div>
        )}
      </div>
      <div className="pointer-events-none min-w-0 flex-1 py-1">
        <p className="line-clamp-2 pe-8 text-[15px] font-bold text-white">{m.title}</p>
        {meta && <p className="mt-0.5 line-clamp-1 text-[11px] font-medium text-text-muted">{meta}</p>}
        <ul className="mt-2 space-y-1">
          {reasons.map(({ r, text }) => (
            <li key={r.kind} className="flex items-start gap-1.5 text-xs leading-5 text-text-secondary">
              <span className={r.kind === "because" ? "text-mint" : "text-accent"} aria-hidden>{REASON_ICON[r.kind]}</span>
              <span className="line-clamp-2">{text}</span>
            </li>
          ))}
        </ul>
      </div>
      <button
        type="button"
        onClick={() => onHide(item)}
        title={t.tasteNotInterested}
        aria-label={t.tasteNotInterested}
        className="absolute end-2 top-2 z-10 flex h-8 w-8 items-center justify-center rounded-full text-text-muted opacity-60 transition hover:bg-white/10 hover:text-white hover:opacity-100"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 4.2A10 10 0 0 1 12 4c5 0 9 4.5 10 8a13 13 0 0 1-3 4.6M6.6 6.6A13 13 0 0 0 2 12c1 3.5 5 8 10 8a10 10 0 0 0 4.4-1" />
        </svg>
      </button>
    </div>
  );
});
