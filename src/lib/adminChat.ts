// Admin↔user chat client API.
//
// Mirrors lib/usage.ts: thin typed wrappers around Postgres RPCs (security
// definer inside the DB enforces the admin email from lib/presence.ts). The
// invariant we enforce server-side:
//   • only an admin can open / close / reopen a thread
//   • a message can only be sent by a participant of an OPEN thread
//   • no thread exists unless the admin created it, so a user has no path to
//     ever direct-message another user — only the admin they're talking to.
//
// Realtime: supabase-js channels on the two tables fan live updates to the
// admin inbox and the conversation thread screens. Closed-app push is fully
// server-side (pg_net trigger in supabase/admin-chat.sql → Expo push API), so
// the client here only renders messages and routes thread state.

import { supabase, isSupabaseConfigured } from "./supabase";

// Photos are sent as regular messages whose body is `img:<public URL>`. The UI
// detects this prefix and renders an <img> bubble instead of text. Storing the
// URL inline (not a separate column) keeps the schema unchanged and the
// Realtime payload tiny.
export const PHOTO_PREFIX = "img:";
export function isPhotoBody(body: string): boolean {
  return body.startsWith(PHOTO_PREFIX);
}
export function photoUrlFromBody(body: string): string {
  return body.slice(PHOTO_PREFIX.length);
}

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/^data:[^,]+,/, "").replace(/[^A-Za-z0-9+/=]/g, "");
  return Uint8Array.from(atob(clean), (c) => c.charCodeAt(0));
}

/**
 * Upload a picked image under the sender's uid, then send a chat message with
 * body = `img:<public URL>`. Reuses the existing `report-screenshots` bucket
 * (already public-read, authenticated-write) so no new SQL migration is needed.
 * Path shape mirrors lib/reports.ts: `{senderId}/{timestamp}.jpg`. Accepts a
 * desktop File or a base64 string (with or without data: prefix).
 */
export async function sendChatPhoto(
  chatId: string,
  image: File | string,
  senderId: string,
): Promise<ChatMessage | null> {
  if (!isSupabaseConfigured || !chatId || !image || !senderId) return null;
  try {
    let body: File | Uint8Array;
    if (typeof image === "string") {
      body = base64ToBytes(image);
      if (!body.length) return null;
    } else {
      body = image;
    }
    const path = `${senderId}/${Date.now()}.jpg`;
    const { error: upErr } = await supabase.storage
      .from("report-screenshots")
      .upload(path, body, {
        contentType: typeof image === "string" ? "image/jpeg" : image.type || "image/jpeg",
        upsert: false,
      });
    if (upErr) return null;
    const { data } = supabase.storage.from("report-screenshots").getPublicUrl(path);
    const url = data?.publicUrl;
    if (!url) return null;
    return await sendChatMessage(chatId, `${PHOTO_PREFIX}${url}`);
  } catch {
    return null;
  }
}

export type ChatStatus = "open" | "closed";

export interface Chat {
  id: string;
  adminId: string;
  userId: string;
  status: ChatStatus;
  createdAt: string;
  closedAt: string | null;
  lastMessageAt: string | null;
  lastMessageBody: string | null;
}

export interface AdminChatSummary extends Chat {
  userEmail: string;
  userName: string;
  userAvatar: string | null;
}

export interface ChatMessage {
  id: string;
  chatId: string;
  senderId: string;
  body: string;
  createdAt: string;
}

// RPCs return columns in snake_case; map once at the boundary so the rest of
// the app keeps camelCase. Cheaper than a runtime lib, and the set is tiny.
function mapChat(r: any): Chat {
  return {
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

function mapSummary(r: any): AdminChatSummary {
  return {
    ...mapChat(r),
    userEmail: r.user_email ?? "",
    userName: r.user_name ?? "",
    userAvatar: r.user_avatar ?? null,
  };
}

function mapMessage(r: any): ChatMessage {
  return {
    id: r.id,
    chatId: r.chat_id,
    senderId: r.sender_id,
    body: r.body,
    createdAt: r.created_at,
  };
}

/** Admin: open (or reopen) a thread with this user. Returns the chat row. */
export async function adminOpenChat(userId: string): Promise<Chat | null> {
  if (!isSupabaseConfigured || !userId) return null;
  const { data, error } = await supabase.rpc("admin_open_chat", { p_user_id: userId });
  if (error || !data) return null;
  return mapChat(data);
}

/** Admin: mark a thread closed (recipient can no longer reply). */
export async function adminCloseChat(chatId: string): Promise<boolean> {
  if (!isSupabaseConfigured || !chatId) return false;
  const { error } = await supabase.rpc("admin_close_chat", { p_chat_id: chatId });
  return !error;
}

/** Admin: reopen a closed thread. */
export async function adminReopenChat(chatId: string): Promise<boolean> {
  if (!isSupabaseConfigured || !chatId) return false;
  const { error } = await supabase.rpc("admin_reopen_chat", { p_chat_id: chatId });
  return !error;
}

/** Admin: inbox — every thread with user profile + last message preview. */
export async function adminListChats(): Promise<AdminChatSummary[]> {
  if (!isSupabaseConfigured) return [];
  const { data, error } = await supabase.rpc("admin_list_chats");
  if (error || !data) return [];
  return (data as any[]).map(mapSummary);
}

interface RawMessageRow {
  id: string;
  chat_id: string;
  sender_id: string;
  body: string;
  created_at: string;
}

/** Both sides: load a thread's messages oldest-first. Empty list if the caller
 *  isn't a participant (server enforces — we just return [] on denial). */
export async function fetchChatMessages(chatId: string): Promise<ChatMessage[]> {
  if (!isSupabaseConfigured || !chatId) return [];
  const { data, error } = await supabase.rpc("chat_fetch_messages", { p_chat_id: chatId });
  if (error || !data) return [];
  // RPC returns setof admin_chat_messages in *column order*, sorted asc by
  // created_at inside the function — keep that order on the client.
  return (data as RawMessageRow[]).map(mapMessage);
}

/** Both sides: send a message. Returns the inserted row or null on denial
 *  (closed thread, not a participant, empty body…). */
export async function sendChatMessage(
  chatId: string,
  body: string,
): Promise<ChatMessage | null> {
  if (!isSupabaseConfigured || !chatId) return null;
  const trimmed = body.trim();
  if (!trimmed) return null;
  const { data, error } = await supabase.rpc("chat_send_message", {
    p_chat_id: chatId,
    p_body: trimmed,
  });
  if (error || !data) return null;
  return mapMessage(data);
}

/** User side: the single thread admin opened with the current user (open
 *  preferred, falls back to newest closed so they can read history). */
export async function fetchMyThread(): Promise<Chat | null> {
  if (!isSupabaseConfigured) return null;
  const { data, error } = await supabase.rpc("chat_my_thread");
  if (error || !data) return null;
  return mapChat(data);
}

// ── Realtime subscriptions ──────────────────────────────────────────────
// Supabase channels filter serverside by the chat_id (just `eq`, cheap).
// Subscribers get INSERT events for new messages and, on the parent row,
// UPDATE events when the admin closes/reopens.

/** Subscribe to INSERTs of new messages inside a specific thread. */
export function subscribeChatMessages(
  chatId: string,
  onInsert: (m: ChatMessage) => void,
): () => void {
  if (!isSupabaseConfigured || !chatId) return () => {};
  const ch = supabase
    .channel(`chat-msgs:${chatId}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "admin_chat_messages", filter: `chat_id=eq.${chatId}` },
      (payload: any) => onInsert(mapMessage(payload.new)),
    )
    .subscribe();
  return () => {
    try { supabase.removeChannel(ch); } catch {}
  };
}

/** Subscribe to status changes (open/closed) on a specific thread. */
export function subscribeChatStatus(
  chatId: string,
  onChange: (status: ChatStatus, closedAt: string | null) => void,
): () => void {
  if (!isSupabaseConfigured || !chatId) return () => {};
  const ch = supabase
    .channel(`chat-status:${chatId}`)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "admin_chats", filter: `id=eq.${chatId}` },
      (payload: any) => onChange(payload.new.status as ChatStatus, payload.new.closed_at ?? null),
    )
    .subscribe();
  return () => {
    try { supabase.removeChannel(ch); } catch {}
  };
}
