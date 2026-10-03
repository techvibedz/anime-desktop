// Per-user daily usage + full watch history (admin only). Ported from the
// mobile app (app/user/[id].tsx). Header identity comes in via query params
// from the users list; the numbers come from the admin-only RPCs in lib/usage.

import { useCallback, useEffect, useState } from "react";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import { isAdmin } from "../../lib/presence";
import {
  fetchUserDaily,
  fetchUserWatchHistory,
  type AdminWatchEntry,
  type DailyRow,
} from "../../lib/usage";
import { adminOpenChat } from "../../lib/adminChat";
import { usePosterImage } from "../../lib/posters";
import { t } from "../../lib/i18n";

function fmtDuration(totalSeconds: number): string {
  if (totalSeconds <= 0) return t.usersNever;
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

function dayLabel(day: string): string {
  const [y, m, d] = day.split("-").map((n) => parseInt(n, 10));
  if (!y || !m || !d) return day;
  const date = new Date(y, m - 1, d);
  const today = new Date();
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const diffDays = Math.round((t0.getTime() - date.getTime()) / 86400000);
  if (diffDays === 0) return t.userToday;
  if (diffDays === 1) return t.userYesterday;
  return `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}/${y}`;
}

function historyDate(iso: string): string {
  const date = new Date(iso);
  return isNaN(date.getTime()) ? "" : date.toLocaleString("ar");
}

function Summary({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="border-b border-white/5 px-2 py-4">
      <p className="text-[11px] text-text-muted">{label}</p>
      <p className={`mt-1 truncate text-lg font-extrabold ${strong ? "text-accent" : "text-white"}`}>{value}</p>
    </div>
  );
}

function HistoryPoster({ image, href }: { image: string; href: string }) {
  const poster = usePosterImage(image, href);
  return (
    <div className="h-[82px] w-[62px] shrink-0 overflow-hidden rounded-lg bg-bg">
      {poster.src ? (
        <img src={poster.src} alt="" className="h-full w-full object-cover" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={poster.onError} />
      ) : poster.repairing ? (
        <div className="h-full w-full shimmer" />
      ) : (
        <div className="h-full w-full bg-raised" />
      )}
    </div>
  );
}

type ProfileTab = "usage" | "history";

export function AdminUserDetailPage() {
  const { user, ready } = useAuth();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const userId = id ?? "";
  const name = params.get("name") || params.get("email") || "";
  const email = params.get("email") || "";
  const avatar = params.get("avatar") || "";
  const lastSeen = params.get("last") || "";

  const [days, setDays] = useState<DailyRow[]>([]);
  const [history, setHistory] = useState<AdminWatchEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const [activeTab, setActiveTab] = useState<ProfileTab>("usage");
  const [refreshing, setRefreshing] = useState(false);
  const [chatOpening, setChatOpening] = useState(false);

  const admin = isAdmin(user?.email);

  const load = useCallback(async () => {
    if (!userId) return;
    setHistoryError(false);
    const [nextDays, nextHistory] = await Promise.all([
      fetchUserDaily(userId),
      fetchUserWatchHistory(userId),
    ]);
    setDays(nextDays);
    if (nextHistory.ok) setHistory(nextHistory.entries);
    else setHistoryError(true);
    setLoaded(true);
    setHistoryLoaded(true);
  }, [userId]);

  useEffect(() => {
    if (admin) load();
  }, [admin, load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  const onOpenChat = useCallback(async () => {
    if (chatOpening || !userId) return;
    setChatOpening(true);
    const chat = await adminOpenChat(userId);
    setChatOpening(false);
    if (!chat) return;
    const qs = new URLSearchParams({ name, email, avatar }).toString();
    navigate(`/admin/chats/${encodeURIComponent(chat.id)}?${qs}`);
  }, [chatOpening, userId, name, email, avatar, navigate]);

  if (!ready) return null;
  if (!admin) return <Navigate to="/" replace />;

  const totalSeconds = days.reduce((s, d) => s + d.seconds, 0);
  const totalOpens = days.reduce((s, d) => s + d.opens, 0);
  const activeDays = days.length;
  const avgSeconds = activeDays ? Math.round(totalSeconds / activeDays) : 0;
  const maxSeconds = days.reduce((m, d) => Math.max(m, d.seconds), 0);
  const completedEpisodes = history.filter((entry) => entry.completed).length;
  const initial = (name || email || "?").trim().charAt(0).toUpperCase();

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-white">{t.userDailyTitle}</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate(-1)}
            className="rounded-full border border-white/15 bg-bg px-3 py-1.5 text-xs font-semibold text-white transition hover:border-white/30"
          >
            {t.back}
          </button>
          <button
            onClick={onRefresh}
            disabled={refreshing}
            className="rounded-full border border-white/15 bg-bg px-3 py-1.5 text-xs font-semibold text-white transition hover:border-white/30 disabled:opacity-50"
          >
            {t.refresh}
          </button>
        </div>
      </div>

      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-surface p-6 shadow-card">
        <div className="absolute inset-0 bg-gradient-to-bl from-accent/10 to-transparent" />
        <div className="relative flex items-center gap-4">
          <div className="shrink-0">
            {avatar ? (
              <img src={avatar} alt="" className="h-[60px] w-[60px] rounded-full object-cover" />
            ) : (
              <div className="flex h-[60px] w-[60px] items-center justify-center rounded-full border border-white/10 bg-raised text-2xl font-extrabold text-white">
                {initial}
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-lg font-bold text-white">{name}</p>
            <p className="truncate text-xs text-text-secondary">{email}</p>
            {lastSeen && (
              <p className="mt-2 text-[11px] text-text-muted">
                {t.usersLastSeen}: {timeAgo(lastSeen)}
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-6 sm:grid-cols-3">
        <Summary label={t.userTotalTime} value={fmtDuration(totalSeconds)} strong />
        <Summary label={t.userTotalOpens} value={String(totalOpens)} />
        <Summary label={t.userActiveDays} value={String(activeDays)} />
        <Summary label={t.userAvgPerDay} value={fmtDuration(avgSeconds)} />
        <Summary label={t.usersEpisodesStarted} value={String(history.length)} />
        <Summary label={t.usersEpisodesCompleted} value={String(completedEpisodes)} strong />
      </div>

      <button
        onClick={onOpenChat}
        disabled={chatOpening}
        className="w-full rounded-xl bg-accent py-3.5 text-sm font-bold text-black transition hover:bg-accent-bright disabled:opacity-60"
      >
        {chatOpening ? t.chatSending : t.chatOpenBtn}
      </button>

      <div className="flex border-b border-white/10">
        {([
          { key: "usage" as const, label: t.userUsageTab },
          { key: "history" as const, label: t.userHistoryTab },
        ]).map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`relative flex-1 py-3 text-sm font-semibold transition ${
              activeTab === tab.key ? "text-white" : "text-text-muted hover:text-white"
            }`}
          >
            {tab.label}
            {activeTab === tab.key && <span className="absolute inset-x-4 -bottom-px h-0.5 rounded-full bg-accent" />}
          </button>
        ))}
      </div>

      {activeTab === "usage" && (
        <div>
          {!loaded ? (
            <div className="flex justify-center py-16">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
            </div>
          ) : days.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/10 p-12 text-center">
              <p className="font-semibold text-white">{t.userNoDays}</p>
              <p className="mt-1 text-sm text-text-muted">{t.userNoDaysSub}</p>
            </div>
          ) : (
            <div>
              {days.map((d) => {
                const pct = maxSeconds > 0 ? Math.max(0.06, d.seconds / maxSeconds) : 0;
                return (
                  <div key={d.day} className="border-b border-white/5 py-4">
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate text-sm font-bold text-accent">{fmtDuration(d.seconds)}</span>
                      <span className="truncate text-sm font-bold text-white">{dayLabel(d.day)}</span>
                    </div>
                    <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-white/10">
                      <div className="h-full rounded-full bg-accent" style={{ width: `${Math.round(pct * 100)}%` }} />
                    </div>
                    <p className="mt-2 text-end text-[11px] text-text-muted">{t.userDayOpens(d.opens)}</p>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {activeTab === "history" && (
        <div>
          {!historyLoaded ? (
            <div className="flex justify-center py-16">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
            </div>
          ) : historyError ? (
            <div className="rounded-2xl border border-dashed border-white/10 p-12 text-center">
              <p className="font-semibold text-white">{t.userHistoryError}</p>
              <button onClick={load} className="mt-3 rounded-full border border-accent/30 bg-accent/10 px-4 py-1.5 text-xs font-bold text-accent transition hover:border-accent/60">
                {t.retry}
              </button>
            </div>
          ) : history.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/10 p-12 text-center">
              <p className="font-semibold text-white">{t.userHistoryEmpty}</p>
              <p className="mt-1 text-sm text-text-muted">{t.userHistoryEmptySub}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {history.map((entry) => {
                const percent = Math.round(entry.progress * 100);
                return (
                  <button
                    key={entry.episodeHref || `${entry.animeTitle}-${entry.updatedAt}`}
                    disabled={!entry.animeTitle}
                    onClick={() => navigate(`/search?q=${encodeURIComponent(entry.animeTitle)}`)}
                    className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-surface p-2.5 text-start transition enabled:hover:border-white/30 disabled:cursor-default"
                  >
                    <HistoryPoster image={entry.image} href={entry.animeHref || entry.episodeHref} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold text-white">{entry.animeTitle}</p>
                      <p className="truncate text-xs text-text-secondary">{entry.episodeTitle}</p>
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <span className={`text-[11px] font-bold ${entry.completed ? "text-green" : "text-accent"}`}>
                          {entry.completed ? t.userHistoryCompleted : t.userHistoryProgress(percent)}
                        </span>
                        <span className="truncate text-[10px] text-text-muted">{historyDate(entry.updatedAt)}</span>
                      </div>
                      <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10">
                        <div
                          className={`h-full rounded-full ${entry.completed ? "bg-green" : "bg-accent"}`}
                          style={{ width: `${entry.completed ? 100 : percent}%` }}
                        />
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
