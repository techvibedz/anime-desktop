// All users (admin only) — every registered account with its accumulated
// usage from lib/usage (admin_list_users + admin_watch_summary RPCs), live
// online flags from presence, search / filter / sort. Ported from the mobile
// app (app/users.tsx).

import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import { isAdmin, subscribeOnlineUsers, type OnlineUser } from "../../lib/presence";
import { fetchAllUsage, type UsageRow } from "../../lib/usage";
import { t } from "../../lib/i18n";

type FilterKey = "all" | "online" | "active" | "inactive";
type SortKey = "recent" | "time" | "sessions";

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (isNaN(ms)) return t.liveJustNow;
  const min = Math.floor(ms / 60000);
  if (min < 1) return t.liveJustNow;
  if (min < 60) return t.liveMinutes(min);
  const h = Math.floor(min / 60);
  if (h < 24) return t.liveHours(h);
  return t.usersDays(Math.floor(h / 24));
}

function fmtDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return t.usersSeconds(totalSeconds);
  const min = Math.floor(totalSeconds / 60);
  if (min < 60) return t.liveMinutes(min);
  const h = Math.floor(min / 60);
  if (h < 24) {
    const rm = min % 60;
    return rm ? `${t.liveHours(h)} ${t.liveMinutes(rm)}` : t.liveHours(h);
  }
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${t.usersDays(d)} ${t.liveHours(rh)}` : t.usersDays(d);
}

function fmtDate(iso: string | null): string {
  if (!iso) return t.usersNever;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return t.usersNever;
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

function Chip({ label, active, onClick, small }: { label: string; active: boolean; onClick: () => void; small?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border font-semibold transition ${small ? "px-3 py-1 text-xs" : "px-4 py-1.5 text-sm"} ${
        active
          ? "border-accent bg-accent text-black"
          : "border-white/10 bg-surface text-text-secondary hover:border-white/30 hover:text-white"
      }`}
    >
      {label}
    </button>
  );
}

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-text-muted">{label}</p>
      <p className={`mt-0.5 truncate text-sm font-bold ${strong ? "text-accent" : "text-white"}`}>{value}</p>
    </div>
  );
}

export function AdminUsersPage() {
  const { user, ready } = useAuth();
  const navigate = useNavigate();
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [onlineIds, setOnlineIds] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [sort, setSort] = useState<SortKey>("recent");

  const admin = isAdmin(user?.email);

  const load = useCallback(async () => {
    const next = await fetchAllUsage();
    setRows(next);
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!admin) return;
    load();
  }, [admin, load]);

  useEffect(() => {
    if (!admin) return;
    return subscribeOnlineUsers((users: OnlineUser[]) => {
      setOnlineIds(new Set(users.map((u) => u.userId)));
    });
  }, [admin]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out = rows.filter((r) => {
      if (q && !r.name.toLowerCase().includes(q) && !r.email.toLowerCase().includes(q)) return false;
      if (filter === "online") return onlineIds.has(r.userId);
      if (filter === "active") return r.totalSeconds > 0;
      if (filter === "inactive") return r.totalSeconds === 0;
      return true;
    });
    return [...out].sort((a, b) => {
      if (sort === "time") return b.totalSeconds - a.totalSeconds;
      if (sort === "sessions") return b.sessions - a.sessions;
      return a.lastSeenAt < b.lastSeenAt ? 1 : -1;
    });
  }, [rows, query, filter, sort, onlineIds]);

  function openUser(u: UsageRow) {
    const params = new URLSearchParams({
      name: u.name,
      email: u.email,
      avatar: u.avatarUrl ?? "",
      last: u.lastSeenAt,
    });
    navigate(`/admin/users/${encodeURIComponent(u.userId)}?${params.toString()}`);
  }

  if (!ready) return null;
  if (!admin) return <Navigate to="/" replace />;

  const totalTime = rows.reduce((sum, r) => sum + r.totalSeconds, 0);
  const filtering = query.trim().length > 0 || filter !== "all";

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold text-white">{t.usersTitle}</h1>

      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-surface p-6 shadow-card">
        <div className="absolute inset-0 bg-gradient-to-bl from-accent/10 to-transparent" />
        <div className="relative flex items-center justify-between gap-4">
          <div>
            <p className="text-4xl font-extrabold leading-none text-white">{rows.length}</p>
            <p className="mt-2 text-sm font-semibold text-text-secondary">{t.usersCount(rows.length)}</p>
          </div>
          <div className="flex items-center gap-3">
            <span className="rounded-full border border-accent/30 bg-accent/10 px-3 py-1.5 text-sm font-bold text-accent">
              {fmtDuration(totalTime)}
            </span>
            <button
              onClick={onRefresh}
              disabled={refreshing}
              className="rounded-full border border-white/15 bg-bg px-3 py-1.5 text-xs font-semibold text-white transition hover:border-white/30 disabled:opacity-50"
            >
              {t.refresh}
            </button>
          </div>
        </div>
        <p className="relative mt-4 text-xs leading-relaxed text-text-muted">{t.usersSub}</p>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-surface px-4">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="shrink-0 text-text-muted">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t.usersSearchPlaceholder}
            className="w-full bg-transparent py-3 text-sm text-white placeholder:text-text-muted focus:outline-none"
          />
          {query.length > 0 && (
            <button onClick={() => setQuery("")} className="text-text-muted transition hover:text-white" aria-label={t.cancel}>
              ×
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Chip label={t.usersFilterAll} active={filter === "all"} onClick={() => setFilter("all")} />
          <Chip label={t.usersFilterOnline} active={filter === "online"} onClick={() => setFilter("online")} />
          <Chip label={t.usersFilterActive} active={filter === "active"} onClick={() => setFilter("active")} />
          <Chip label={t.usersFilterInactive} active={filter === "inactive"} onClick={() => setFilter("inactive")} />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-text-muted">{t.usersSortBy}</span>
          <Chip small label={t.usersSortRecent} active={sort === "recent"} onClick={() => setSort("recent")} />
          <Chip small label={t.usersSortTime} active={sort === "time"} onClick={() => setSort("time")} />
          <Chip small label={t.usersSortSessions} active={sort === "sessions"} onClick={() => setSort("sessions")} />
        </div>

        {filtering && <p className="text-xs text-text-muted">{t.usersShowing(filtered.length, rows.length)}</p>}
      </div>

      {!loaded ? (
        <div className="flex justify-center py-16">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/10 p-12 text-center">
          <p className="font-semibold text-white">{t.usersEmpty}</p>
          <p className="mt-1 text-sm text-text-muted">{t.usersEmptySub}</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/10 p-12 text-center">
          <p className="font-semibold text-white">{t.usersNoMatch}</p>
          <p className="mt-1 text-sm text-text-muted">{t.usersNoMatchSub}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((u) => {
            const isMe = u.userId === user?.id;
            const online = onlineIds.has(u.userId);
            const initial = (u.name || u.email || "?").trim().charAt(0).toUpperCase();
            return (
              <button
                key={u.userId}
                onClick={() => openUser(u)}
                className="w-full rounded-xl border border-white/10 bg-surface p-5 text-start transition hover:border-white/30"
              >
                <div className="flex items-center gap-4">
                  <div className="relative shrink-0">
                    {u.avatarUrl ? (
                      <img src={u.avatarUrl} alt="" className="h-11 w-11 rounded-full object-cover" />
                    ) : (
                      <div className="flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-raised text-base font-bold text-white">
                        {initial}
                      </div>
                    )}
                    {online && <span className="absolute -bottom-0.5 -end-0.5 h-3.5 w-3.5 rounded-full border-2 border-surface bg-green" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-bold text-white">
                      {u.name}
                      {isMe ? ` · ${t.liveUsersYou}` : ""}
                    </p>
                    <p className="truncate text-xs text-text-secondary">{u.email}</p>
                    {online && (
                      <span className="mt-1.5 inline-flex items-center gap-1.5 rounded-full border border-green/30 bg-green/10 px-2 py-0.5 text-[10px] font-bold text-green">
                        <span className="h-1.5 w-1.5 rounded-full bg-green" />
                        {t.usersOnlineNow}
                      </span>
                    )}
                  </div>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3 border-t border-white/10 pt-4 sm:grid-cols-4">
                  <Stat label={t.usersTimeSpent} value={u.totalSeconds > 0 ? fmtDuration(u.totalSeconds) : t.usersNever} strong />
                  <Stat label={t.usersLastSeen} value={timeAgo(u.lastSeenAt)} />
                  <Stat label={t.usersSessions} value={String(u.sessions)} />
                  <Stat label={t.usersRegistered} value={fmtDate(u.createdAt)} />
                  <Stat label={t.usersVersion} value={u.version ? `v${u.version}` : t.usersNever} />
                  <Stat label={t.usersEpisodesStarted} value={String(u.episodesStarted)} />
                  <Stat label={t.usersEpisodesCompleted} value={String(u.episodesCompleted)} strong />
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
