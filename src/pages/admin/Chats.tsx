// Admin chat inbox (admin only) — every admin↔user thread with its last
// message and open/closed status. Ported from the mobile app
// (app/admin/chats.tsx). Re-polls when the window regains focus.

import { useCallback, useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import { isAdmin } from "../../lib/presence";
import { adminListChats, type AdminChatSummary } from "../../lib/adminChat";
import { t } from "../../lib/i18n";

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (isNaN(ms)) return t.liveJustNow;
  const min = Math.floor(ms / 60000);
  if (min < 1) return t.liveJustNow;
  if (min < 60) return t.liveMinutes(min);
  const h = Math.floor(min / 60);
  if (h < 24) return t.liveHours(h);
  return t.usersDays(Math.floor(h / 24));
}

export function AdminChatsPage() {
  const { user, ready } = useAuth();
  const navigate = useNavigate();
  const [rows, setRows] = useState<AdminChatSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const admin = isAdmin(user?.email);

  const load = useCallback(async () => {
    const next = await adminListChats();
    setRows(next);
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (admin) load();
  }, [admin, load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  useEffect(() => {
    if (!admin) return;
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [admin, load]);

  function openChat(c: AdminChatSummary) {
    const qs = new URLSearchParams({
      name: c.userName,
      email: c.userEmail,
      avatar: c.userAvatar ?? "",
    });
    navigate(`/admin/chats/${encodeURIComponent(c.id)}?${qs}`);
  }

  if (!ready) return null;
  if (!admin) return <Navigate to="/" replace />;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-surface p-6 shadow-card">
        <div className="absolute inset-0 bg-gradient-to-bl from-accent/10 to-transparent" />
        <div className="relative flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-white">{t.chatAdminInboxTitle}</h1>
            <p className="mt-2 text-xs leading-relaxed text-text-secondary">{t.chatAdminInboxSub}</p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <span className="text-3xl font-extrabold text-white">{rows.length}</span>
            <button
              onClick={onRefresh}
              disabled={refreshing}
              className="rounded-full border border-white/15 bg-bg px-3 py-1.5 text-xs font-semibold text-white transition hover:border-white/30 disabled:opacity-50"
            >
              {t.refresh}
            </button>
          </div>
        </div>
      </div>

      {!loaded ? (
        <div className="flex justify-center py-16">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/10 p-12 text-center">
          <p className="font-semibold text-white">{t.chatInboxEmpty}</p>
          <p className="mt-1 text-sm text-text-muted">{t.chatInboxEmptySub}</p>
        </div>
      ) : (
        <div className="divide-y divide-white/5">
          {rows.map((c) => {
            const closed = c.status === "closed";
            const initial = (c.userName || c.userEmail || "?").trim().charAt(0).toUpperCase();
            return (
              <button key={c.id} onClick={() => openChat(c)} className="flex w-full items-center gap-4 py-4 text-start transition hover:opacity-80">
                <div className="relative shrink-0">
                  {c.userAvatar ? (
                    <img src={c.userAvatar} alt="" className="h-11 w-11 rounded-full object-cover" />
                  ) : (
                    <div className="flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-raised text-base font-bold text-white">
                      {initial}
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold text-white">{c.userName || c.userEmail}</p>
                  <p className="truncate text-xs text-text-secondary">{c.lastMessageBody || t.chatNoMessages}</p>
                  <div className="mt-2 flex items-center gap-2">
                    {closed ? (
                      <span className="rounded-full border border-white/10 bg-raised px-2 py-0.5 text-[10px] font-bold text-text-muted">
                        {t.chatStatusClosed}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-green/30 bg-green/10 px-2 py-0.5 text-[10px] font-bold text-green">
                        <span className="h-1.5 w-1.5 rounded-full bg-green" />
                        {t.chatStatusOpen}
                      </span>
                    )}
                    {c.lastMessageAt && <span className="text-[11px] text-text-muted">{timeAgo(c.lastMessageAt)}</span>}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
