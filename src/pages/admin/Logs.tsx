// Remote device logs (admin only) — errors/warnings/info shipped by clients
// via lib/remoteLog. Always fetched unfiltered, filtered client-side so the
// summary counts stay correct; auto-refreshes every 60s. Ported from the
// mobile app (app/admin/logs.tsx).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import { isAdmin } from "../../lib/presence";
import { fetchAdminLogs, type AdminLogRow } from "../../lib/remoteLog";
import { t } from "../../lib/i18n";

type Level = "error" | "warn" | "info";
type Filter = Level | "all";

const FILTERS: { key: Filter; label: () => string }[] = [
  { key: "all", label: () => t.logsFilterAll },
  { key: "error", label: () => t.logsFilterErrors },
  { key: "warn", label: () => t.logsFilterWarnings },
  { key: "info", label: () => t.logsFilterInfo },
];

const LEVEL_TINT: Record<string, string> = {
  error: "bg-red-500/15 text-red-400",
  warn: "bg-amber-400/15 text-amber-400",
  info: "bg-accent/15 text-accent",
};

function when(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (isNaN(ms)) return iso;
  if (ms < 60000) return t.liveJustNow;
  if (ms < 3600000) return t.liveSince(t.liveMinutes(Math.floor(ms / 60000)));
  if (ms < 86400000) return t.liveSince(t.liveHours(Math.floor(ms / 3600000)));
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// Cheap change-detection for the 60s poll: skip setRows when the newest id and
// row count didn't move.
function rowsSignature(rows: AdminLogRow[]): string {
  return `${rows.length}:${rows[0]?.id ?? ""}`;
}

function LogCard({ row, open, onToggle }: { row: AdminLogRow; open: boolean; onToggle: (id: string) => void }) {
  const tint = LEVEL_TINT[row.level] ?? LEVEL_TINT.info;
  return (
    <button
      onClick={() => onToggle(row.id)}
      className="w-full rounded-xl border border-white/10 bg-surface p-4 text-start transition hover:border-white/20"
    >
      <div className="flex items-center gap-2">
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide ${tint}`}>{row.level}</span>
        <span className="rounded-full bg-raised px-2 py-0.5 text-[11px] font-semibold text-text-secondary">{row.tag}</span>
        <span className="ms-auto text-[11px] text-text-muted">{when(row.created_at)}</span>
      </div>

      <p className={`mt-2.5 text-sm leading-relaxed text-text-secondary ${open ? "" : "line-clamp-2"}`}>{row.message}</p>

      {(row.email || row.device || row.app_version) && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {row.email && (
            <span className="max-w-[220px] truncate rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-semibold text-accent">{row.email}</span>
          )}
          {row.device && (
            <span className="max-w-[260px] truncate rounded-full bg-raised px-2 py-0.5 text-[11px] text-text-secondary">
              {row.device} · {row.platform}
            </span>
          )}
          {row.app_version && (
            <span className="rounded-full bg-raised px-2 py-0.5 text-[11px] text-text-secondary">v{row.app_version}</span>
          )}
        </div>
      )}

      {open && row.context && (
        <div className={`mt-3 space-y-1 rounded-lg p-3 text-[11px] ${tint.split(" ")[0]}`}>
          {Object.entries(row.context).map(([k, v]) => (
            <div key={k} className="flex gap-2">
              <span className="min-w-[75px] font-bold text-white">{k}</span>
              <span className="min-w-0 flex-1 break-all text-text-secondary">
                {typeof v === "object" ? JSON.stringify(v) : String(v)}
              </span>
            </div>
          ))}
        </div>
      )}
    </button>
  );
}

export function AdminLogsPage() {
  const { user, ready } = useAuth();
  const [rows, setRows] = useState<AdminLogRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const sigRef = useRef("");

  const admin = isAdmin(user?.email);

  const load = useCallback(async () => {
    if (!admin) return;
    try {
      const next = await fetchAdminLogs(200, null);
      const sig = rowsSignature(next);
      if (sig !== sigRef.current) {
        sigRef.current = sig;
        setRows(next);
      }
    } finally {
      setLoaded(true);
      setRefreshing(false);
    }
  }, [admin]);

  useEffect(() => {
    if (admin) void load();
  }, [admin, load]);

  // Auto-refresh every 60s while the screen is open.
  useEffect(() => {
    if (!admin) return;
    const iv = setInterval(() => void load(), 60000);
    return () => clearInterval(iv);
  }, [admin, load]);

  const counts = useMemo(() => {
    let error = 0, warn = 0, info = 0;
    for (const r of rows) {
      if (r.level === "error") error++;
      else if (r.level === "warn") warn++;
      else if (r.level === "info") info++;
    }
    return { error, warn, info };
  }, [rows]);

  const visible = useMemo(
    () => (filter === "all" ? rows : rows.filter((r) => r.level === filter)),
    [rows, filter],
  );

  if (!ready) return null;
  if (!admin) return <Navigate to="/" replace />;

  const healthy = counts.error + counts.warn === 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-white">{t.logsTitle}</h1>
        <button
          onClick={() => { setRefreshing(true); void load(); }}
          disabled={refreshing}
          className="rounded-full border border-white/15 bg-bg px-3 py-1.5 text-xs font-semibold text-white transition hover:border-white/30 disabled:opacity-50"
        >
          {t.refresh}
        </button>
      </div>

      <div className="relative flex min-h-[72px] flex-wrap items-center gap-5 overflow-hidden rounded-2xl border border-white/10 bg-surface px-4 py-3.5 shadow-card">
        <div className="absolute inset-0 bg-gradient-to-bl from-accent/10 to-transparent" />
        <span className="relative flex items-center gap-2">
          <span className="text-lg font-extrabold text-red-400">{counts.error}</span>
          <span className="text-xs font-semibold text-text-secondary">{t.logsFilterErrors}</span>
        </span>
        <span className="relative flex items-center gap-2">
          <span className="text-lg font-extrabold text-amber-400">{counts.warn}</span>
          <span className="text-xs font-semibold text-text-secondary">{t.logsFilterWarnings}</span>
        </span>
        <span className="relative flex items-center gap-2">
          <span className="text-lg font-extrabold text-accent">{counts.info}</span>
          <span className="text-xs font-semibold text-text-secondary">{t.logsFilterInfo}</span>
        </span>
        {healthy && (
          <span className="relative ms-auto rounded-full bg-green/15 px-2.5 py-1 text-[11px] font-bold text-green">{t.logsHealthy}</span>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => {
          const active = filter === f.key;
          const n = f.key === "all" ? rows.length : counts[f.key as Level] ?? 0;
          return (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`flex items-center gap-2 rounded-xl border px-4 py-2 text-sm font-semibold transition ${
                active ? "border-accent bg-accent/10 text-accent" : "border-white/10 bg-surface text-text-secondary hover:border-white/30 hover:text-white"
              }`}
            >
              {f.label()}
              <span className="text-[11px] font-bold text-text-muted">{n}</span>
            </button>
          );
        })}
      </div>

      {!loaded ? (
        <div className="flex justify-center py-16">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/10 p-12 text-center">
          <p className="font-semibold text-white">{t.logsEmptyTitle}</p>
          <p className="mt-1 text-sm text-text-muted">{t.logsEmptySub}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map((row) => (
            <LogCard
              key={row.id}
              row={row}
              open={openId === row.id}
              onToggle={(id) => setOpenId((cur) => (cur === id ? null : id))}
            />
          ))}
        </div>
      )}
    </div>
  );
}
