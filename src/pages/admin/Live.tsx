// Live users (admin only) — real-time list of everyone currently inside the
// app, from Supabase Realtime presence (lib/presence). Ported from the mobile
// app (app/live.tsx).

import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import { isAdmin, subscribeOnlineUsers, type OnlineUser } from "../../lib/presence";
import { t } from "../../lib/i18n";

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (isNaN(ms)) return t.liveJustNow;
  const min = Math.floor(ms / 60000);
  if (min < 1) return t.liveJustNow;
  if (min < 60) return t.liveMinutes(min);
  return t.liveHours(Math.floor(min / 60));
}

export function AdminLivePage() {
  const { user, ready } = useAuth();
  const [users, setUsers] = useState<OnlineUser[]>([]);
  const [loaded, setLoaded] = useState(false);

  const admin = isAdmin(user?.email);

  // Live subscription to the shared presence channel. Fires immediately with
  // the current snapshot, then on every join/leave/sync.
  useEffect(() => {
    if (!admin) return;
    const unsub = subscribeOnlineUsers((next) => {
      setUsers(next);
      setLoaded(true);
    });
    return unsub;
  }, [admin]);

  if (!ready) return null;
  if (!admin) return <Navigate to="/" replace />;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <h1 className="text-2xl font-bold text-white">{t.liveUsersTitle}</h1>

      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-surface p-6 shadow-card">
        <div className="absolute inset-0 bg-gradient-to-bl from-accent/10 to-transparent" />
        <div className="relative flex items-center justify-between gap-4">
          <div>
            <p className="text-4xl font-extrabold leading-none text-white">{users.length}</p>
            <p className="mt-2 text-sm font-semibold text-text-secondary">{t.liveUsersNow(users.length)}</p>
          </div>
          <span className="flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-3 py-1.5 text-[11px] font-bold tracking-widest text-accent">
            <span className="h-2 w-2 animate-pulse rounded-full bg-green" />
            LIVE
          </span>
        </div>
        <p className="relative mt-4 text-xs leading-relaxed text-text-muted">{t.liveUsersSub}</p>
      </div>

      {!loaded ? (
        <div className="flex justify-center py-16">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        </div>
      ) : users.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/10 p-12 text-center">
          <p className="font-semibold text-white">{t.liveUsersEmpty}</p>
          <p className="mt-1 text-sm text-text-muted">{t.liveUsersEmptySub}</p>
        </div>
      ) : (
        <div className="divide-y divide-white/5">
          {users.map((u) => {
            const isMe = u.userId === user?.id;
            const initial = (u.name || "?").trim().charAt(0).toUpperCase();
            return (
              <div key={u.userId} className="flex items-center gap-4 py-4">
                <div className="relative shrink-0">
                  {u.avatarUrl ? (
                    <img src={u.avatarUrl} alt="" className="h-11 w-11 rounded-full object-cover" />
                  ) : (
                    <div className="flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-raised text-base font-bold text-white">
                      {initial}
                    </div>
                  )}
                  <span className="absolute -bottom-0.5 -end-0.5 h-3.5 w-3.5 rounded-full border-2 border-bg bg-green" />
                </div>
                <p className="min-w-0 flex-1 truncate text-sm font-bold text-white">
                  {u.name}
                  {isMe ? ` · ${t.liveUsersYou}` : ""}
                </p>
                <div className="flex shrink-0 items-center gap-2">
                  {u.devices > 1 && (
                    <span className="rounded-full border border-white/10 bg-raised px-2 py-0.5 text-[11px] font-semibold text-text-secondary">
                      {u.devices}
                    </span>
                  )}
                  <span className="text-[11px] text-text-muted">{t.liveSince(timeAgo(u.onlineAt))}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
