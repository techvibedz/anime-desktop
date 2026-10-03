// Scraper diagnostics — the desktop port of the mobile app's app/scraper-debug.tsx.
// Three self-contained probes with step-by-step traces: the witanime home direct
// scrape, an anime4up direct search, and a video-URL extraction from a pasted
// embed URL (classified via lib/videoProviders). The build card confirms which
// bundle actually reached this machine (app version + Electron/Chromium from the
// user agent). Every probe fails soft: local try/catch, no crash when offline.

import { useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { APP_VERSION } from "../lib/appVersion";
import { fetchWitHomeDirect, searchAnime4upDirectList } from "../lib/scraper";
import { classifyProvider } from "../lib/videoProviders";
import { t } from "../lib/i18n";

type Status = "idle" | "running" | "ok" | "err";
type Step = { label: string; detail?: string; ok: boolean };
type TestState = { status: Status; ms: number | null; steps: Step[]; summary: string | null };

const IDLE: TestState = { status: "idle", ms: null, steps: [], summary: null };

const SAMPLE_QUERY = "Jujutsu Kaisen";

async function runTest(
  setState: Dispatch<SetStateAction<TestState>>,
  work: (push: (label: string, detail?: string, ok?: boolean) => void) => Promise<string>,
) {
  setState({ status: "running", ms: null, steps: [], summary: null });
  const steps: Step[] = [];
  const push = (label: string, detail?: string, ok = true) => {
    steps.push({ label, detail, ok });
    setState((s) => ({ ...s, steps: [...steps] }));
  };
  const t0 = performance.now();
  try {
    const summary = await work(push);
    setState({ status: "ok", ms: Math.round(performance.now() - t0), steps: [...steps], summary });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    steps.push({ label: t.debugError, detail: message, ok: false });
    setState({ status: "err", ms: Math.round(performance.now() - t0), steps: [...steps], summary: null });
  }
}

function StatusChip({ status }: { status: Status }) {
  const label = status === "ok" ? t.debugPass
    : status === "err" ? t.debugFail
      : status === "running" ? t.debugRunning
        : t.debugIdle;
  const cls = status === "ok" ? "border-green-500/30 bg-green-500/10 text-green-400"
    : status === "err" ? "border-red-500/30 bg-red-500/10 text-red-400"
      : status === "running" ? "border-accent/40 bg-accent/10 text-accent"
        : "border-white/10 bg-bg text-text-muted";
  return <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${cls}`}>{label}</span>;
}

function TraceList({ steps }: { steps: Step[] }) {
  if (steps.length === 0) return null;
  return (
    <ul className="mt-3 space-y-1.5">
      {steps.map((s, i) => (
        <li key={i} className="flex items-start gap-2 text-xs">
          <span className={s.ok ? "text-green-400" : "text-red-400"}>{s.ok ? "✓" : "✗"}</span>
          <span className="text-text-secondary">{s.label}</span>
          {s.detail && <span dir="auto" className="min-w-0 break-all font-mono text-[11px] text-text-muted">{s.detail}</span>}
        </li>
      ))}
    </ul>
  );
}

function TestCard({
  title, subtitle, button, status, state, onRun, children,
}: {
  title: string;
  subtitle: string;
  button: string;
  status: Status;
  state: TestState;
  onRun: () => void;
  children?: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-white/10 bg-surface p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-bold text-white">{title}</h2>
          <p className="mt-1 text-sm leading-relaxed text-text-secondary">{subtitle}</p>
        </div>
        <StatusChip status={status} />
      </div>
      {children}
      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={onRun}
          disabled={status === "running"}
          className="rounded-full bg-accent px-4 py-2 text-sm font-bold text-black transition-colors hover:bg-accent-bright disabled:opacity-50"
        >
          {status === "running" ? t.debugRunning : button}
        </button>
        {state.ms !== null && <span className="text-[11px] text-text-muted">{t.debugDuration(state.ms)}</span>}
      </div>
      <TraceList steps={state.steps} />
      {state.summary && (
        <div className="mt-3 rounded-lg border border-white/10 bg-bg p-3">
          <p className="text-[11px] uppercase tracking-wider text-text-muted">{t.debugFirstResult}</p>
          <p dir="auto" className="mt-0.5 break-all text-sm text-white">{state.summary}</p>
        </div>
      )}
    </section>
  );
}

export function ScraperDebugPage() {
  const [ua] = useState(() => navigator.userAgent);
  const electron = ua.match(/Electron\/([\d.]+)/)?.[1];
  const chromium = ua.match(/(?:Chrome|Chromium)\/([\d.]+)/)?.[1];

  const [home, setHome] = useState<TestState>(IDLE);
  const [search, setSearch] = useState<TestState>(IDLE);
  const [video, setVideo] = useState<TestState>(IDLE);
  const [embedUrl, setEmbedUrl] = useState("");

  const resetAll = () => { setHome(IDLE); setSearch(IDLE); setVideo(IDLE); };

  const runHome = () => runTest(setHome, async (push) => {
    push(t.debugStepFetchHome, "https://witanime.site/");
    const data = await fetchWitHomeDirect();
    if (!data) throw new Error(t.debugNoResult);
    push(t.debugStepParse, `${t.featured}: ${data.featured.length} · ${t.debugAnimes}: ${data.animes.length} · ${t.episodes}: ${data.episodes.length}`);
    return data.featured[0]?.title || data.animes[0]?.title || data.episodes[0]?.title || t.debugNoResult;
  });

  const runSearch = () => runTest(setSearch, async (push) => {
    push(t.debugStepSearch, SAMPLE_QUERY);
    const list = await searchAnime4upDirectList(SAMPLE_QUERY);
    if (!list || list.length === 0) throw new Error(t.debugNoResult);
    push(t.debugStepParse, `${t.debugResults}: ${list.length}`);
    return list[0].title;
  });

  const runVideo = () => {
    const url = embedUrl.trim();
    if (!url) {
      setVideo({ status: "err", ms: null, steps: [{ label: t.debugPasteFirst, ok: false }], summary: null });
      return;
    }
    runTest(setVideo, async (push) => {
      const provider = classifyProvider(url);
      push(t.debugStepClassify, provider);
      const res = await window.pantoufa?.directExtract?.(provider, url).catch(() => null);
      if (!res?.url) throw new Error(t.debugNoResult);
      push(t.debugStepExtract, `${res.type}${res.denied ? " · denied" : ""}`, !res.denied);
      return res.url;
    });
  };

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">{t.debugTitle}</h1>
        <button
          onClick={resetAll}
          className="rounded-full border border-white/15 bg-surface px-4 py-2 text-xs font-semibold text-white transition hover:border-white/30"
        >
          {t.debugReset}
        </button>
      </div>

      <section className="rounded-2xl border border-white/10 bg-surface p-5">
        <h2 className="font-display text-lg font-bold text-white">{t.debugBuild}</h2>
        <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {[
            { label: t.debugAppVersion, value: APP_VERSION },
            { label: t.debugPlatform, value: navigator.platform || "—" },
            { label: t.debugElectron, value: electron || "—" },
            { label: t.debugChromium, value: chromium || "—" },
          ].map((row) => (
            <div key={row.label} className="rounded-lg border border-white/10 bg-bg p-3">
              <dt className="text-[11px] uppercase tracking-wider text-text-muted">{row.label}</dt>
              <dd dir="ltr" className="text-sm font-semibold text-white">{row.value}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-3 rounded-lg border border-white/10 bg-bg p-3">
          <p className="text-[11px] uppercase tracking-wider text-text-muted">{t.debugUserAgent}</p>
          <p dir="ltr" className="mt-0.5 break-all font-mono text-[11px] text-text-secondary">{ua}</p>
        </div>
      </section>

      <TestCard
        title={t.debugTestHome}
        subtitle={t.debugTestHomeSub}
        button={t.debugRunHome}
        status={home.status}
        state={home}
        onRun={runHome}
      />

      <TestCard
        title={t.debugTestSearch}
        subtitle={t.debugTestSearchSub}
        button={t.debugRunSearch}
        status={search.status}
        state={search}
        onRun={runSearch}
      />

      <TestCard
        title={t.debugTestExtract}
        subtitle={t.debugTestExtractSub}
        button={t.debugRunExtract}
        status={video.status}
        state={video}
        onRun={runVideo}
      >
        <input
          value={embedUrl}
          onChange={(e) => setEmbedUrl(e.target.value)}
          placeholder={t.debugEmbedPlaceholder}
          spellCheck={false}
          dir="ltr"
          className="mt-4 w-full rounded-xl border border-white/10 bg-bg px-3 py-2.5 font-mono text-sm text-white placeholder:text-text-muted focus:border-accent focus:outline-none"
        />
      </TestCard>
    </div>
  );
}
