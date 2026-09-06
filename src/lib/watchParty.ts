// Watch Party — synchronized "watch together" rooms over Supabase Realtime.
//
// One Realtime channel per room ("watch-party-<CODE>") carries BOTH:
//   • Presence  → who's in the room (avatar row in the overlay/lobby).
//   • Broadcast → the host's player state (episode, position, play/pause).
//
// The host broadcasts its <video> state on a fixed 1.5s heartbeat; clients
// reconcile each beat against their local player (see computeSync). That single
// periodic message covers play, pause AND seek with no per-event wiring. The
// drift tolerance (DRIFT_TOLERANCE_MS) is the "buffer window" so clients don't
// stutter chasing exact milliseconds.
//
// Lifecycle: the socket exists ONLY while in a room. The player's unmount
// schedules a debounced leave so an episode-hop navigation keeps the room,
// while a real exit ends it. Mirrors the mobile app's lib/watchParty.ts.
//
// Position sync only works for direct (HLS/MP4) playback through the <video>
// element. Iframe-embed servers can't be read/seeked cross-origin, so those
// degrade to episode-sync only (everyone on the same episode, not the same ms).

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { RealtimeChannel, User } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { computeSync, genCode, type PartyState } from "./watchPartySync";

export type { PartyState } from "./watchPartySync";
export { computeSync, DRIFT_TOLERANCE_MS } from "./watchPartySync";

export type PartyRole = "host" | "client";

export interface PartyMember {
  userId: string;
  name: string;
  avatarUrl: string | null;
  isHost: boolean;
}

const HEARTBEAT_MS = 1500;
const DETACH_LEAVE_MS = 2000; // grace so an episode-hop remount keeps the room

// ── Channel state (one room at a time) ────────────────────────────
let channel: RealtimeChannel | null = null;
let room: { code: string; role: PartyRole; user: User } | null = null;
let leaveTimer: ReturnType<typeof setTimeout> | null = null;

let lastMembers: PartyMember[] = [];
let lastState: PartyState | null = null;
// Last episode a client navigated to, so the immediate state replay on (re)mount
// can't re-fire navigate() and spin into an infinite remount loop.
let lastNavTarget: string | null = null;
const memberListeners = new Set<(m: PartyMember[]) => void>();
const stateListeners = new Set<(s: PartyState) => void>();
const controlListeners = new Set<(p: { episode: string; playing: boolean }) => void>();
const roomListeners = new Set<(r: { code: string; role: PartyRole } | null) => void>();

function computeMembers(): PartyMember[] {
  if (!channel) return [];
  const state = channel.presenceState<{
    user_id: string;
    name: string;
    avatar_url: string | null;
    is_host: boolean;
  }>();
  const out: PartyMember[] = [];
  for (const presences of Object.values(state)) {
    if (!presences.length) continue;
    const p = presences[0];
    out.push({
      userId: p.user_id,
      name: p.name,
      avatarUrl: p.avatar_url ?? null,
      isHost: !!p.is_host,
    });
  }
  return out.sort((a, b) => (a.isHost === b.isHost ? a.name.localeCompare(b.name) : a.isHost ? -1 : 1));
}

function emitMembers() {
  lastMembers = computeMembers();
  for (const cb of memberListeners) cb(lastMembers);
}

function emitRoom() {
  const snap = room ? { code: room.code, role: room.role } : null;
  for (const cb of roomListeners) cb(snap);
}

async function openChannel(): Promise<void> {
  if (!room || channel) return;
  const { user, code, role } = room;
  const meta = user.user_metadata ?? {};
  const name =
    meta.full_name || meta.name || (user.email ? user.email.split("@")[0] : "User");
  const avatarUrl = meta.avatar_url || meta.picture || null;

  channel = supabase.channel(`watch-party-${code}`, {
    config: { presence: { key: user.id }, broadcast: { self: false } },
  });

  channel
    .on("presence", { event: "sync" }, emitMembers)
    .on("presence", { event: "join" }, emitMembers)
    .on("presence", { event: "leave" }, emitMembers)
    .on("broadcast", { event: "control" }, ({ payload }) => {
      if (room?.role !== "host" || !payload || typeof payload.episode !== "string" || typeof payload.playing !== "boolean") return;
      for (const cb of controlListeners) cb(payload);
    })
    .on("broadcast", { event: "sync" }, ({ payload }) => {
      if (!payload || typeof payload.episode !== "string" || typeof payload.playing !== "boolean" ||
          !Number.isFinite(payload.positionMs) || payload.positionMs < 0 || !Number.isFinite(payload.at) ||
          !payload.params || Object.values(payload.params).some((v) => typeof v !== "string")) return;
      lastState = { ...payload, params: { ...payload.params,
        url4up: payload.params.url4up || payload.params.up4 || "",
        up4: payload.params.up4 || payload.params.url4up || "",
        url3rb: payload.params.url3rb || payload.params.a3rb || "",
        a3rb: payload.params.a3rb || payload.params.url3rb || "",
        animeTitle: payload.params.animeTitle || payload.params.title || "",
        title: payload.params.title || payload.params.animeTitle || "",
        epNum: payload.params.epNum || payload.params.ep || "",
        ep: payload.params.ep || payload.params.epNum || "",
      } } as PartyState;
      // Mobile route values carry an extra URI-encoding layer.
      if ("url4up" in payload.params || "animeTitle" in payload.params) {
        for (const key of Object.keys(lastState.params)) {
          try { lastState.params[key] = decodeURIComponent(lastState.params[key]); } catch {}
        }
      }
      for (const cb of stateListeners) cb(lastState);
    })
    .subscribe(async (status) => {
      if (status === "SUBSCRIBED" && channel) {
        await channel.track({
          user_id: user.id,
          name,
          avatar_url: avatarUrl,
          is_host: role === "host",
        });
      }
    });
}

async function closeChannel(): Promise<void> {
  if (channel) {
    try { await channel.untrack(); } catch {}
    try { await supabase.removeChannel(channel); } catch {}
  }
  channel = null;
}

// ── Public API ────────────────────────────────────────────────────

export function getRoom(): { code: string; role: PartyRole } | null {
  return room ? { code: room.code, role: room.role } : null;
}

export async function createRoom(user: User): Promise<string> {
  await leaveRoom();
  const code = genCode();
  room = { code, role: "host", user };
  await openChannel();
  emitRoom();
  return code;
}

export async function joinRoom(code: string, user: User): Promise<void> {
  await leaveRoom();
  room = { code: code.trim().toUpperCase(), role: "client", user };
  await openChannel();
  emitRoom();
}

export async function leaveRoom(): Promise<void> {
  if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = null; }
  await closeChannel();
  room = null;
  lastMembers = [];
  lastState = null;
  lastNavTarget = null;
  emitMembers();
  emitRoom();
}

/** Host only — broadcast current player state. No-op if not subscribed. */
export function sendState(state: PartyState): void {
  if (!channel || room?.role !== "host") return;
  channel.send({ type: "broadcast", event: "sync", payload: state });
}

export function subscribeMembers(cb: (m: PartyMember[]) => void): () => void {
  memberListeners.add(cb);
  cb(lastMembers);
  return () => { memberListeners.delete(cb); };
}

export function subscribeState(cb: (s: PartyState) => void): () => void {
  stateListeners.add(cb);
  if (lastState) cb(lastState);
  return () => { stateListeners.delete(cb); };
}

export function subscribeRoom(cb: (r: { code: string; role: PartyRole } | null) => void): () => void {
  roomListeners.add(cb);
  cb(room ? { code: room.code, role: room.role } : null);
  return () => { roomListeners.delete(cb); };
}

function attach(): void {
  if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = null; }
}

function detach(): void {
  if (!room || room.role === "host") return;
  if (leaveTimer) clearTimeout(leaveTimer);
  leaveTimer = setTimeout(() => { void leaveRoom(); }, DETACH_LEAVE_MS);
}

// ── React hook wired into the Watch page ───────────────────────────

export function useWatchPartySync(opts: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  episode: string;
  navParams: Record<string, string>;
  onPaused: (paused: boolean) => void;
}) {
  const navigate = useNavigate();
  const [role, setRole] = useState<PartyRole | null>(() => getRoom()?.role ?? null);
  const [code, setCode] = useState<string | null>(() => getRoom()?.code ?? null);
  const [members, setMembers] = useState<PartyMember[]>([]);
  const [hostPaused, setHostPaused] = useState(false);

  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => { attach(); return () => detach(); }, []);
  useEffect(() => subscribeRoom((r) => { setRole(r?.role ?? null); setCode(r?.code ?? null); }), []);
  useEffect(() => subscribeMembers(setMembers), []);

  // HOST → broadcast the live <video> state every heartbeat.
  useEffect(() => {
    if (role !== "host") return;
    const iv = setInterval(() => {
      const o = optsRef.current;
      const v = o.videoRef.current;
      sendState({
        episode: o.episode,
        params: o.navParams,
        positionMs: v ? Math.round(v.currentTime * 1000) : 0,
        playing: v ? !v.paused : false,
        at: Date.now(),
      });
    }, HEARTBEAT_MS);
    return () => clearInterval(iv);
  }, [role]);

  // HOST → also broadcast IMMEDIATELY on every play/pause/seek, not just on the
  // heartbeat, so clients move in lock-step instead of waiting up to 1.5s (the
  // "no delay" feel). Effects run after DOM commit, so re-keying on `episode`
  // re-attaches once the new <video> element for that episode is mounted; iframe
  // servers have no videoRef and stay heartbeat/episode-sync only.
  useEffect(() => {
    if (role !== "host") return;
    const v = optsRef.current.videoRef.current;
    if (!v) return;
    const pulse = () => {
      const o = optsRef.current;
      const el = o.videoRef.current;
      sendState({
        episode: o.episode,
        params: o.navParams,
        positionMs: el ? Math.round(el.currentTime * 1000) : 0,
        playing: el ? !el.paused : false,
        at: Date.now(),
      });
    };
    v.addEventListener("play", pulse);
    v.addEventListener("pause", pulse);
    v.addEventListener("seeked", pulse);
    return () => {
      v.removeEventListener("play", pulse);
      v.removeEventListener("pause", pulse);
      v.removeEventListener("seeked", pulse);
    };
  }, [role, opts.episode]);

  useEffect(() => {
    if (role !== "host") return;
    const onControl = (p: { episode: string; playing: boolean }) => {
      const o = optsRef.current;
      const v = o.videoRef.current;
      if (p.episode !== o.episode || !v) return;
      o.onPaused(!p.playing);
      if (p.playing) void v.play().catch(() => {});
      else v.pause();
      sendState({ episode: o.episode, params: o.navParams, positionMs: Math.round(v.currentTime * 1000), playing: p.playing, at: Date.now() });
    };
    controlListeners.add(onControl);
    return () => { controlListeners.delete(onControl); };
  }, [role]);

  const requestPlayback = (playing: boolean) => {
    if (role === "client" && channel) void channel.send({ type: "broadcast", event: "control", payload: { episode: optsRef.current.episode, playing } });
  };

  // CLIENT → follow the host on each broadcast.
  useEffect(() => {
    if (role !== "client") return;
    const norm = (u?: string) => {
      if (!u) return "";
      try { return decodeURIComponent(u).replace(/\/+$/, ""); }
      catch { return u.replace(/\/+$/, ""); }
    };
    return subscribeState((s) => {
      const o = optsRef.current;
      setHostPaused(!s.playing);
      // Host moved to a different episode → reopen it locally (room persists).
      const target = norm(s.episode);
      if (target && target !== norm(o.episode)) {
        if (lastNavTarget === target) return; // already navigating there — no loop
        lastNavTarget = target;
        const qs = new URLSearchParams({ ...s.params, auto: "1" }).toString();
        navigate(`/watch/${encodeURIComponent(s.episode)}${qs ? `?${qs}` : ""}`);
        return;
      }
      lastNavTarget = null; // arrived on the right episode
      const v = o.videoRef.current;
      if (!v) return; // iframe server / not ready — can't position-sync
      const { shouldSeekTo, play } = computeSync(s, Math.round(v.currentTime * 1000), Date.now());
      if (shouldSeekTo != null) { try { v.currentTime = shouldSeekTo / 1000; } catch {} }
      o.onPaused(!play);
      if (play && v.paused) v.play().catch(() => {});
      else if (!play && !v.paused) v.pause();
    });
  }, [role, navigate]);

  return { role, code, members, hostPaused, requestPlayback, leaveParty: leaveRoom };
}
