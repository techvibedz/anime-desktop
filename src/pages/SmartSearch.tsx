// Smart (AI) search — its own page, separate from the normal title search
// (mobile app/smart-search.tsx parity). The user describes what they feel like
// watching (any dialect); the companion edge function turns it into real
// titles, resolved via AniList. Cards open through the AniList → source
// resolution, so only titles the sources carry end up playing.

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { aiSearch, type AiSearchEntry } from "../lib/aiSearch";
import { resolveSourceUrl } from "../lib/schedule";
import { t } from "../lib/i18n";

const EXAMPLES = [
  "أنمي رومانسي مدرسي خفيف ومضحك",
  "قتال قوي وبطل يبدأ ضعيفًا ويصبح الأقوى",
  "غموض ونفسي يخليني أفكر",
  "أنمي قصير أكمله في يوم",
  "إيسيكاي فيه نظام لفلات",
];

function Sparkle({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2l1.9 5.7L19.6 9.6l-5.7 1.9L12 17.2l-1.9-5.7L4.4 9.6l5.7-1.9L12 2zm6.5 12l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9.9-2.6z" />
    </svg>
  );
}

export function SmartSearchPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const initial = params.get("q") || "";
  const [text, setText] = useState(initial);
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [items, setItems] = useState<AiSearchEntry[]>([]);
  const [intent, setIntent] = useState("");
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);
  const seq = useRef(0);

  const run = useCallback(async (value?: string) => {
    const q = (value ?? text).trim();
    if (q.length < 2) return;
    if (value != null) setText(value);
    const my = ++seq.current;
    setState("loading");
    setError("");
    const res = await aiSearch(q);
    if (my !== seq.current) return;
    if (res.ok) {
      setItems(res.items);
      setIntent(res.intent);
      setState(res.items.length ? "done" : "error");
      if (!res.items.length) setError(t.aiSearchEmpty);
    } else {
      setError(
        res.reason === "signin" ? t.companionSignIn
          : res.reason === "rate_limited" ? t.companionRateLimited
          : res.reason === "unavailable" ? t.companionUnavailable
          : res.reason === "empty" ? t.aiSearchEmpty
          : t.companionError,
      );
      setState("error");
    }
  }, [text]);

  // Opened from the search bar with a query → run it right away.
  useEffect(() => {
    if (initial.trim().length >= 2) void run(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const open = async (item: AiSearchEntry) => {
    if (busyId != null) return;
    setBusyId(item.anilistId);
    try {
      const href = await resolveSourceUrl(item.title).catch(() => null)
        ?? (item.titleEnglish ? await resolveSourceUrl(item.titleEnglish).catch(() => null) : null);
      navigate(href ? `/anime/${encodeURIComponent(href)}` : `/title/${item.anilistId}`);
    } finally {
      setBusyId(null);
    }
  };

  const canRun = text.trim().length >= 2 && state !== "loading";

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-[32px] font-extrabold text-white">
          <span className="text-accent"><Sparkle size={26} /></span>
          {t.aiSearchTitle}
        </h1>
        <p className="mt-1 text-sm font-semibold leading-6 text-text-muted">{t.smartSearchIntro}</p>
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); void run(); }}
        className="rounded-[20px] border border-accent/30 bg-accent/[0.08] p-4"
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void run(); } }}
          autoFocus
          maxLength={300}
          rows={3}
          placeholder={t.smartSearchPlaceholder}
          aria-label={t.smartSearchPlaceholder}
          className="w-full resize-none bg-transparent text-[15px] leading-7 text-white outline-none placeholder:text-text-muted"
        />
        <button
          type="submit"
          disabled={!canRun}
          className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-full bg-accent text-sm font-bold text-on-accent transition hover:bg-accent-bright disabled:opacity-45"
        >
          {state === "loading"
            ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-black/25 border-t-black" />
            : <Sparkle />}
          {state === "loading" ? t.aiSearchThinking : t.smartSearchRun}
        </button>
      </form>

      {state === "idle" && (
        <div className="space-y-2">
          <p className="text-xs font-bold text-text-muted">{t.smartSearchExamples}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => void run(ex)}
                className="flex h-11 items-center gap-2 rounded-xl border border-white/[0.06] bg-surface px-4 text-start text-[13px] font-medium text-white transition hover:border-accent/40 hover:bg-raised"
              >
                <span className="text-accent"><Sparkle size={14} /></span>
                <span className="truncate">{ex}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {state === "error" && (
        <div className="flex flex-col items-center gap-4 py-12 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-accent/10 text-accent"><Sparkle size={26} /></span>
          <p className="text-sm font-semibold text-text-secondary">{error || t.companionError}</p>
          <button
            type="button"
            onClick={() => void run()}
            className="rounded-full bg-white/10 px-5 py-2 text-sm font-bold text-white hover:bg-white/15"
          >
            {t.retry}
          </button>
        </div>
      )}

      {state === "done" && (
        <section className="space-y-4">
          <div>
            <h2 className="text-base font-bold text-white">{t.aiSearchResults}</h2>
            {intent && <p className="text-xs text-text-muted">{intent}</p>}
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {items.map((item) => (
              <button
                key={item.anilistId}
                type="button"
                onClick={() => void open(item)}
                disabled={busyId === item.anilistId}
                className="group flex gap-4 rounded-2xl border border-white/[0.06] bg-surface p-3 text-start transition hover:border-accent/40 hover:bg-raised"
              >
                <div className="relative aspect-[2/3] w-24 shrink-0 overflow-hidden rounded-xl bg-raised">
                  {item.image && <img src={item.image} alt="" loading="lazy" className="h-full w-full object-cover transition duration-500 group-hover:scale-105" />}
                  {busyId === item.anilistId && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/55">
                      <span className="h-6 w-6 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1 py-1">
                  <p className="line-clamp-2 text-[15px] font-bold text-white">{item.title}</p>
                  <p className="mt-0.5 line-clamp-1 text-[11px] font-medium text-text-muted">
                    {[item.year, item.score ? `★ ${(item.score / 10).toFixed(1)}` : null, item.episodes ? t.episodeCount(item.episodes) : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  {item.reason && <p className="mt-2 line-clamp-4 text-xs leading-5 text-text-secondary">{item.reason}</p>}
                </div>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
