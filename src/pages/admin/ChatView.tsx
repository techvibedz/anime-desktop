// Admin conversation view (admin only) — live thread renders with Supabase
// Realtime, text + photo sending, and close/reopen controls. Ported from the
// mobile app (app/admin/chat/[id].tsx).

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../lib/auth";
import { isAdmin } from "../../lib/presence";
import {
  fetchChatMessages,
  sendChatMessage,
  sendChatPhoto,
  isPhotoBody,
  photoUrlFromBody,
  subscribeChatMessages,
  subscribeChatStatus,
  adminCloseChat,
  adminReopenChat,
  type ChatMessage,
  type ChatStatus,
  type Chat,
} from "../../lib/adminChat";
import { t } from "../../lib/i18n";

function timeLabel(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function AdminChatViewPage() {
  const { user, ready } = useAuth();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const chatId = id ?? "";
  const name = params.get("name") || params.get("email") || "";
  const email = params.get("email") || "";

  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [thread, setThread] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendingPhoto, setSendingPhoto] = useState(false);

  const admin = isAdmin(user?.email);

  // Load thread metadata (status) + messages on mount.
  const load = useCallback(async () => {
    if (!chatId) return;
    let nextThread: Chat | null = null;
    try {
      const { data: row } = await supabase
        .from("admin_chats")
        .select("id,admin_id,user_id,status,created_at,closed_at,last_message_at,last_message_body")
        .eq("id", chatId)
        .single();
      if (row) {
        const r = row as any;
        nextThread = {
          id: r.id,
          adminId: r.admin_id,
          userId: r.user_id,
          status: r.status as ChatStatus,
          createdAt: r.created_at,
          closedAt: r.closed_at ?? null,
          lastMessageAt: r.last_message_at ?? null,
          lastMessageBody: r.last_message_body ?? null,
        };
      }
    } catch {
      nextThread = null;
    }
    setThread(nextThread);
    const msgs = await fetchChatMessages(chatId);
    setMessages(msgs);
    setLoaded(true);
  }, [chatId]);

  useEffect(() => {
    if (admin && chatId) load();
  }, [admin, chatId, load]);

  // Realtime: incoming inserts + thread status (open/closed) changes.
  useEffect(() => {
    if (!admin || !chatId) return;
    const unsubMsgs = subscribeChatMessages(chatId, (m) => {
      setMessages((prev) => (prev.some((p) => p.id === m.id) ? prev : [...prev, m]));
    });
    const unsubStatus = subscribeChatStatus(chatId, (status, closedAt) => {
      setThread((prev) => (prev ? { ...prev, status, closedAt } : prev));
    });
    return () => {
      unsubMsgs();
      unsubStatus();
    };
  }, [admin, chatId]);

  // Keep the freshest message in view.
  useEffect(() => {
    if (!loaded) return;
    requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }));
  }, [messages.length, loaded]);

  const closed = thread?.status === "closed";

  const onSend = useCallback(async () => {
    if (sending || closed || !draft.trim()) return;
    setSending(true);
    const body = draft;
    setDraft("");
    const msg = await sendChatMessage(chatId, body);
    setSending(false);
    if (!msg) {
      // RPC denied — likely closed by another session mid-send. Restore + surface.
      setDraft(body);
      window.alert(t.chatFailedToSend);
      return;
    }
    setMessages((prev) => (prev.some((p) => p.id === msg.id) ? prev : [...prev, msg]));
  }, [sending, closed, draft, chatId]);

  const onCloseToggle = useCallback(() => {
    if (!thread) return;
    if (closed) {
      void adminReopenChat(thread.id).then((ok) => {
        if (ok) {
          setThread({ ...thread, status: "open", closedAt: null });
          window.alert(t.chatReopenedToast);
        }
      });
      return;
    }
    if (!window.confirm(`${t.chatCloseConfirmTitle}\n${t.chatCloseConfirmSub}`)) return;
    void adminCloseChat(thread.id).then((ok) => {
      if (ok) {
        setThread({ ...thread, status: "closed", closedAt: new Date().toISOString() });
        window.alert(t.chatClosedToast);
      }
    });
  }, [thread, closed]);

  const onPickPhoto = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !user || !chatId || sendingPhoto || closed) return;
    setSendingPhoto(true);
    const msg = await sendChatPhoto(chatId, file, user.id);
    setSendingPhoto(false);
    if (!msg) {
      window.alert(t.chatPhotoFailed);
      return;
    }
    setMessages((prev) => (prev.some((p) => p.id === msg.id) ? prev : [...prev, msg]));
  }, [user, chatId, sendingPhoto, closed]);

  if (!ready) return null;
  if (!admin) return <Navigate to="/" replace />;

  const composerDisabled = closed || sending || sendingPhoto;

  return (
    <div className="mx-auto flex h-[calc(100vh-8rem)] max-w-3xl flex-col">
      <div className="flex items-center justify-between gap-3 pb-4">
        <div className="flex min-w-0 items-center gap-2">
          <button
            onClick={() => navigate(-1)}
            className="shrink-0 rounded-full border border-white/15 bg-bg px-3 py-1.5 text-xs font-semibold text-white transition hover:border-white/30"
          >
            {t.back}
          </button>
          <h1 className="truncate text-lg font-bold text-white">{name || email || t.chatAdminOpenWithUser}</h1>
        </div>
        {thread && (
          <button
            onClick={onCloseToggle}
            className={`shrink-0 rounded-full border px-3.5 py-1.5 text-xs font-bold transition ${
              closed
                ? "border-white/15 bg-surface text-text-muted hover:text-white"
                : "border-accent/30 bg-accent/10 text-accent hover:border-accent/60"
            }`}
          >
            {closed ? t.chatReopenBtn : t.chatCloseBtn}
          </button>
        )}
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto rounded-2xl border border-white/10 bg-bg p-4">
        {!loaded ? (
          <div className="flex justify-center py-16">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          </div>
        ) : messages.length === 0 ? (
          <div className="py-14 text-center">
            <p className="font-semibold text-white">{t.chatNoMessages}</p>
            <p className="mt-1 text-sm text-text-muted">{t.chatNoMessagesSub}</p>
          </div>
        ) : (
          <div className="flex flex-col">
            {messages.map((m, i) => {
              const mine = m.senderId === user?.id;
              const prev = messages[i - 1];
              const stacked =
                !!prev &&
                prev.senderId === m.senderId &&
                new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 60_000;
              const photo = isPhotoBody(m.body);
              return (
                <div key={m.id} className={`flex flex-col ${stacked ? "mt-0.5" : "mt-2.5"}`}>
                  <div
                    className={`max-w-[84%] rounded-2xl px-4 py-3 ${
                      mine ? "ms-auto rounded-ee-md bg-accent/15" : "me-auto rounded-es-md bg-surface"
                    } ${photo ? "p-1" : ""}`}
                  >
                    {photo ? (
                      <img src={photoUrlFromBody(m.body)} alt="" className="max-h-64 rounded-xl object-cover" loading="lazy" />
                    ) : (
                      <p className="whitespace-pre-wrap text-sm leading-relaxed text-white">{m.body}</p>
                    )}
                  </div>
                  {!stacked && (
                    <span className={`mt-1 text-[10px] text-text-muted ${mine ? "ms-auto" : "me-auto"}`}>
                      {timeLabel(m.createdAt)}
                    </span>
                  )}
                </div>
              );
            })}
            {closed && (
              <div className="mx-auto mt-5 rounded-full border border-white/10 bg-surface px-3 py-1.5 text-[11px] font-semibold text-text-muted">
                {t.chatClosedByAdmin}
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      <div className="flex items-end gap-2 border-t border-white/10 bg-bg pt-3">
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onPickPhoto} />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={composerDisabled}
          title={t.chatAttachPhoto}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-surface text-text-secondary transition hover:text-white disabled:opacity-35"
        >
          {sendingPhoto ? (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M4 7h3l2-3h6l2 3h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z" />
              <circle cx="12" cy="13" r="3.5" />
            </svg>
          )}
        </button>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void onSend();
            }
          }}
          rows={1}
          disabled={closed || sending}
          placeholder={closed ? t.chatReplyDisabled : t.chatPlaceholder}
          className="max-h-32 min-h-[44px] flex-1 resize-none rounded-xl border border-white/10 bg-surface px-4 py-3 text-sm text-white placeholder:text-text-muted focus:border-accent/50 focus:outline-none disabled:opacity-50"
        />
        <button
          onClick={() => void onSend()}
          disabled={composerDisabled || !draft.trim()}
          title={t.chatSend}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent text-black transition hover:bg-accent-bright disabled:opacity-35"
        >
          {sending ? (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-black/60 border-t-transparent" />
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="-scale-x-100">
              <path d="M2.5 21.5 23 12 2.5 2.5 2.5 10l14 2-14 2z" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}
