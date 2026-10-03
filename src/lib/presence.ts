// Live presence — who is using the app right now.
//
// Uses Supabase Realtime "Presence". Every signed-in device joins a shared
// channel ("online-users") and `track()`s a small payload. Presence is
// ephemeral: when a device disconnects (app closed / network drop) Supabase
// removes it automatically, so the online list is always live — no table, no
// migration, no cleanup job. Desktop and mobile share the channel name, so
// each platform sees the other's users too.
//
// The admin live screen reads the same channel's presence state and re-renders
// on every sync/join/leave. Only the admin UI renders it; this module just
// keeps one channel alive per signed-in user.

import type { RealtimeChannel, User } from "@supabase/supabase-js";
import { supabase, isSupabaseConfigured } from "./supabase";

/** Accounts allowed to see the live-users screen. */
export const ADMIN_EMAILS = ["zlabia66@gmail.com"];

export function isAdmin(email?: string | null): boolean {
  return !!email && ADMIN_EMAILS.includes(email.toLowerCase().trim());
}

export interface OnlineUser {
  userId: string;
  name: string;
  avatarUrl: string | null;
  /** ISO time this user first came online in the current session. */
  onlineAt: string;
  /** How many of this user's devices are connected right now. */
  devices: number;
}

const CHANNEL = "online-users";

let channel: RealtimeChannel | null = null;
let trackedUserId: string | null = null;
let lastUsers: OnlineUser[] = [];
const listeners = new Set<(users: OnlineUser[]) => void>();

function computeUsers(): OnlineUser[] {
  if (!channel) return [];
  // presenceState() → { presenceKey: [ {payload…}, … ] }. We key by user id,
  // so each key is one user and the array length is their connected devices.
  const state = channel.presenceState<{
    user_id: string;
    name: string;
    avatar_url: string | null;
    online_at: string;
  }>();

  const users: OnlineUser[] = [];
  for (const presences of Object.values(state)) {
    if (!presences.length) continue;
    // Earliest online_at across this user's devices = when they came online.
    const sorted = [...presences].sort((a, b) => (a.online_at < b.online_at ? -1 : 1));
    const p = sorted[0];
    users.push({
      userId: p.user_id,
      name: p.name,
      avatarUrl: p.avatar_url ?? null,
      onlineAt: p.online_at,
      devices: presences.length,
    });
  }
  // Most recently arrived first.
  return users.sort((a, b) => (a.onlineAt < b.onlineAt ? 1 : -1));
}

function emit() {
  lastUsers = computeUsers();
  for (const cb of listeners) cb(lastUsers);
}

/**
 * Begin advertising this device as online. Idempotent per user — calling again
 * for the same user is a no-op; calling for a different user re-tracks.
 */
export async function startPresence(user: User): Promise<void> {
  if (!isSupabaseConfigured) return;
  if (channel && trackedUserId === user.id) return;
  await stopPresence();
  trackedUserId = user.id;

  const meta = user.user_metadata ?? {};
  const name =
    meta.full_name || meta.name || (user.email ? user.email.split("@")[0] : "User");
  const avatarUrl = meta.avatar_url || meta.picture || null;

  channel = supabase.channel(CHANNEL, {
    config: { presence: { key: user.id } },
  });

  channel
    .on("presence", { event: "sync" }, emit)
    .on("presence", { event: "join" }, emit)
    .on("presence", { event: "leave" }, emit)
    .subscribe(async (status) => {
      if (status === "SUBSCRIBED" && channel) {
        try {
          await channel.track({
            user_id: user.id,
            name,
            avatar_url: avatarUrl,
            online_at: new Date().toISOString(),
          });
        } catch {
          // Offline / transient Realtime errors are non-fatal.
        }
      }
    });
}

/** Stop advertising this device and tear down the channel. */
export async function stopPresence(): Promise<void> {
  if (channel) {
    try {
      await channel.untrack();
    } catch {}
    try {
      await supabase.removeChannel(channel);
    } catch {}
  }
  channel = null;
  trackedUserId = null;
  lastUsers = [];
  emit();
}

/**
 * Subscribe to the live online-users list. Fires immediately with the current
 * snapshot, then on every join/leave/sync. Returns an unsubscribe function.
 */
export function subscribeOnlineUsers(cb: (users: OnlineUser[]) => void): () => void {
  listeners.add(cb);
  cb(lastUsers);
  return () => {
    listeners.delete(cb);
  };
}
