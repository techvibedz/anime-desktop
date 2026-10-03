// Chat — the signed-in user's private thread with the admin, ported from the
// mobile app (app/chat.tsx). Realtime messages + open/closed status via
// lib/adminChat; photo messages render from the `img:` body prefix. The
// composer is hidden until a thread exists and disabled while it's closed.

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../lib/auth";
import {
  fetchMyThread,
  fetchChatMessages,
  sendChatMessage,
  sendChatPhoto,
  isPhotoBody,
  photoUrlFromBody,
  subscribeChatMessages,
  subscribeChatStatus,
  type Chat,
  type ChatMessage,
} from "../lib/adminChat";
import { t } from "../lib/i18n";

function timeLabel(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function BubbleIcon({ d, size = 20, className = "" }: { d: string; size?: number; className?: string }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      className={className} aria-hidden
    >
      {d.split("|").map((p, i) => <path key={i} d={p} />)}
    </svg>
  );
}

export function ChatPage() {
  const { user, ready } = useAuth();
  const scrollRef = useRef<HTMLDivElement>(null);
  const photoRef = useRef<HTMLInputElement>(null);

  const [thread, setThread] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendingPhoto, setSendingPhoto] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const th = await fetchMyThread();
    setThread(th);
    setMessages(th ? await fetchChatMessages(th.id) : []);
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (ready) void load();
  }, [ready, load]);

  // Realtime on the current thread (if any).
  useEffect(() => {
    if (!thread) return;
    const unsubMsgs = subscribeChatMessages(thread.id, (m) => {
      setMessages((prev) => (prev.some((p) => p.id === m.id) ? prev : [...prev, m]));
    });
    const unsubStatus = subscribeChatStatus(thread.id, (status, closedAt) => {
      setThread((prev) => (prev ? { ...prev, status, closedAt } : prev));
    });
    return () => { unsubMsgs(); unsubStatus(); };
  }, [thread?.id]);

  // Pin to the newest bubble on new content.
  useEffect(() => {
    if (!loaded) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, loaded]);

  const closed = thread?.status === "closed";

  const onSend = useCallback(async () => {
    if (sending || closed || !thread || !draft.trim()) return;
    setSending(true);
    setErr(null);
    const body = draft;
    setDraft("");
    const msg = await sendChatMessage(thread.id, body);
    setSending(false);
    if (!msg) {
      setDraft(body);
      setErr(t.chatFailedToSend);
      return;
    }
    setMessages((prev) => (prev.some((p) => p.id === msg.id) ? prev : [...prev, msg]));
  }, [sending, closed, thread, draft]);

  const onAttachPhoto = useCallback(async (file: File | null) => {
    if (!file || sendingPhoto || closed || !thread || !user) return;
    setSendingPhoto(true);
    setErr(null);
    const msg = await sendChatPhoto(thread.id, file, user.id);
    setSendingPhoto(false);
    if (!msg) {
      setErr(t.chatPhotoFailed);
      return;
    }
    setMessages((prev) => (prev.some((p) => p.id === msg.id) ? prev : [...prev, msg]));
  }, [sendingPhoto, closed, thread, user]);

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void onSend();
    }
  }

  return (
    <div dir="rtl" className="mx-auto flex h-[calc(100vh-3.5rem)] max-w-3xl flex-col">
      <h1 className="text-2xl font-bold text-white">{t.chatUserThreadTitle}</h1>

      <div ref={scrollRef} className="mt-4 flex-1 overflow-y-auto rounded-2xl border border-white/10 bg-surface p-4">
        {!loaded ? (
          <div className="flex h-full items-center justify-center">
            <span className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          </div>
        ) : !thread ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full border border-white/10 bg-raised text-text-muted">
              <BubbleIcon d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" size={28} />
            </div>
            <p className="mt-4 font-bold text-white">{t.chatNoThreadTitle}</p>
            <p className="mt-1.5 max-w-sm text-sm leading-6 text-text-muted">{t.chatNoThreadSub}</p>
          </div>
        ) : (
          <>
            {messages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center text-center">
                <div className="flex h-16 w-16 items-center justify-center rounded-full border border-white/10 bg-raised text-text-muted">
                  <BubbleIcon d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" size={26} />
                </div>
                <p className="mt-4 font-bold text-white">{t.chatNoMessages}</p>
                <p className="mt-1.5 text-sm text-text-muted">{t.chatNoMessagesSub}</p>
              </div>
            ) : (
              <div className="space-y-1">
                {messages.map((m, i) => {
                  const mine = m.senderId === user?.id;
                  const prev = messages[i - 1];
                  const stacked = !!prev && prev.senderId === m.senderId &&
                    new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 60_000;
                  const photo = isPhotoBody(m.body);
                  return (
                    <div key={m.id} className="flex flex-col">
                      <div
                        className={`max-w-[75%] ${
                          mine ? "self-end rounded-2xl rounded-bl-md bg-accent/15" : "self-start rounded-2xl rounded-br-md bg-raised"
                        } ${photo ? "p-1" : "px-4 py-2.5"}`}
                      >
                        {photo ? (
                          <img
                            src={photoUrlFromBody(m.body)}
                            alt=""
                            loading="lazy"
                            className="max-h-64 rounded-xl object-cover"
                          />
                        ) : (
                          <p className="whitespace-pre-wrap text-sm leading-6 text-white">{m.body}</p>
                        )}
                      </div>
                      {!stacked && (
                        <span className={`mt-1 text-[10px] text-text-muted ${mine ? "self-end" : "self-start"}`}>
                          {timeLabel(m.createdAt)}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {closed ? (
              <div className="mt-5 flex justify-center">
                <span className="flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] font-semibold text-text-muted">
                  <BubbleIcon d="M5 11h14v10H5z|M8 11V7a4 4 0 0 1 8 0v4" size={13} />
                  {t.chatClosedByAdmin}
                </span>
              </div>
            ) : null}
          </>
        )}
      </div>

      {loaded && thread ? (
        <div className="mt-3 flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={closed ? t.chatReplyDisabled : t.chatPlaceholder}
            disabled={closed || sending || sendingPhoto}
            rows={1}
            className={`h-12 flex-1 resize-none rounded-xl border bg-surface px-4 py-3 text-sm leading-5 text-white placeholder:text-text-muted focus:border-accent focus:outline-none ${
              closed ? "border-white/5 opacity-60" : "border-white/10"
            }`}
          />
          <input
            ref={photoRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              e.target.value = "";
              void onAttachPhoto(f);
            }}
          />
          <button
            type="button"
            onClick={() => photoRef.current?.click()}
            disabled={closed || sendingPhoto || sending}
            title={t.chatAttachPhoto}
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-surface text-text-secondary transition-colors hover:border-white/25 hover:text-white disabled:opacity-40"
          >
            {sendingPhoto ? (
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
            ) : (
              <BubbleIcon d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z|M16 13a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z" size={22} />
            )}
          </button>
          <button
            type="button"
            onClick={() => void onSend()}
            disabled={closed || sending || sendingPhoto || !draft.trim()}
            title={t.chatSend}
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent text-black transition-colors hover:bg-accent-bright disabled:opacity-40"
          >
            {sending ? (
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-black/30 border-t-transparent" />
            ) : (
              <BubbleIcon d="M22 2 11 13|M22 2 15 22 11 13 2 9 22 2" size={22} />
            )}
          </button>
        </div>
      ) : null}

      {err ? <p className="mt-2 text-center text-xs font-semibold text-red-400">{err}</p> : null}
    </div>
  );
}
