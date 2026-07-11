import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import {
  createRoom,
  joinRoom,
  leaveRoom,
  subscribeRoom,
  subscribeMembers,
  subscribeState,
  type PartyMember,
  type PartyRole,
} from "../lib/watchParty";
import { t } from "../lib/i18n";

function Avatars({ members, meId }: { members: PartyMember[]; meId?: string }) {
  return (
    <div className="mt-3 flex flex-col gap-2">
      {members.map((m) => {
        const initial = (m.name || "?").trim().charAt(0).toUpperCase();
        return (
          <div
            key={m.userId}
            className="flex items-center justify-between rounded-lg border border-white/10 bg-surface px-3 py-2.5"
          >
            <div className="flex flex-col items-end">
              <span className="text-sm font-bold text-white">
                {m.name}{m.userId === meId ? ` · ${t.wpYou}` : ""}
              </span>
              {m.isHost ? <span className="text-[11px] font-semibold text-accent">{t.wpHost}</span> : null}
            </div>
            <div className="relative">
              {m.avatarUrl ? (
                <img src={m.avatarUrl} alt="" className="h-11 w-11 rounded-full object-cover" />
              ) : (
                <div className={`flex h-11 w-11 items-center justify-center rounded-full text-base font-bold ${m.isHost ? "bg-accent text-black" : "bg-white/10 text-white"}`}>
                  {initial}
                </div>
              )}
              {m.isHost ? (
                <span className="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full border-2 border-surface bg-accent text-[8px] text-black">★</span>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function WatchPartyPage() {
  const { user, ready } = useAuth();
  const navigate = useNavigate();

  const [roomInfo, setRoomInfo] = useState<{ code: string; role: PartyRole } | null>(null);
  const [members, setMembers] = useState<PartyMember[]>([]);
  const [codeInput, setCodeInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => subscribeRoom(setRoomInfo), []);
  useEffect(() => subscribeMembers(setMembers), []);

  // Client: the instant the host broadcasts an episode, follow into the player.
  useEffect(() => {
    if (roomInfo?.role !== "client") return;
    let navigated = false;
    return subscribeState((st) => {
      if (st.episode && !navigated) {
        navigated = true;
        const qs = new URLSearchParams({ ...st.params, auto: "1" }).toString();
        navigate(`/watch/${encodeURIComponent(st.episode)}${qs ? `?${qs}` : ""}`);
      }
    });
  }, [roomInfo?.role, navigate]);

  const onCreate = useCallback(async () => {
    if (!user) { setErr(t.wpSignInRequired); return; }
    setBusy(true); setErr(null);
    try { await createRoom(user); } catch { setErr(t.signInFailed); }
    setBusy(false);
  }, [user]);

  const onJoin = useCallback(async () => {
    if (!user) { setErr(t.wpSignInRequired); return; }
    const code = codeInput.trim().toUpperCase();
    if (code.length < 4) { setErr(t.wpInvalidCode); return; }
    setBusy(true); setErr(null);
    try { await joinRoom(code, user); } catch { setErr(t.wpInvalidCode); }
    setBusy(false);
  }, [user, codeInput]);

  if (!ready) return null;

  return (
    <div dir="rtl" className="mx-auto max-w-xl space-y-5">
      <h1 className="text-2xl font-bold text-white">{t.wpTitle}</h1>

      {roomInfo ? (
        /* ── In a room: waiting area ── */
        <>
          <div className="rounded-2xl border border-accent/25 bg-surface p-6 text-center">
            <p className="text-xs font-semibold text-text-muted">{t.wpRoomCode}</p>
            <p className="mt-1.5 text-5xl font-bold tracking-[0.3em] text-accent" dir="ltr">{roomInfo.code}</p>
            <p className="mt-3 text-xs text-text-muted">
              {roomInfo.role === "host" ? t.wpShareHint : t.wpHostPicking}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-green-400" />
            <span className="text-sm font-bold text-white">
              {members.length > 1 ? t.wpInRoom(members.length) : t.wpWaiting}
            </span>
          </div>

          <Avatars members={members} meId={user?.id} />

          {roomInfo.role === "host" ? (
            <>
              <button
                onClick={() => navigate("/")}
                className="flex w-full items-center justify-center gap-2 rounded-full bg-accent py-3 text-sm font-bold text-black transition-colors hover:bg-accent-bright"
              >
                {t.wpStartWatching}
              </button>
              <p className="text-center text-xs text-text-muted">{t.wpStartWatchingHint}</p>
            </>
          ) : (
            <div className="flex items-center justify-center gap-3 rounded-lg border border-white/10 bg-surface p-3.5 text-sm text-text-muted">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
              {t.wpHostPicking}
            </div>
          )}

          <button
            onClick={() => leaveRoom()}
            className="flex w-full items-center justify-center gap-2 py-2 text-sm font-semibold text-red-400 transition hover:text-red-300"
          >
            {t.wpLeave}
          </button>
        </>
      ) : (
        /* ── Not in a room: create / join ── */
        <>
          <p className="text-sm leading-7 text-text-muted">{t.wpSub}</p>

          <button
            onClick={onCreate}
            disabled={busy}
            className="flex w-full items-center justify-center gap-2 rounded-full bg-accent py-3 text-sm font-bold text-black transition-colors hover:bg-accent-bright disabled:opacity-60"
          >
            {busy ? t.wpCreating : t.wpCreate}
          </button>

          <div className="flex items-center gap-3">
            <span className="h-px flex-1 bg-white/10" />
            <span className="text-xs text-text-muted">{t.or}</span>
            <span className="h-px flex-1 bg-white/10" />
          </div>

          <div className="flex items-center gap-2.5">
            <input
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value.toUpperCase())}
              placeholder={t.wpJoinPlaceholder}
              maxLength={6}
              dir="ltr"
              className="h-12 flex-1 rounded-lg border border-white/15 bg-surface text-center text-lg font-bold tracking-[0.25em] text-white outline-none focus:border-accent"
            />
            <button
              onClick={onJoin}
              disabled={busy}
              className="h-12 rounded-lg border border-accent/40 bg-white/5 px-6 text-sm font-bold text-white transition hover:bg-white/10 disabled:opacity-60"
            >
              {t.wpJoin}
            </button>
          </div>

          {err ? <p className="text-center text-sm font-semibold text-red-400">{err}</p> : null}
        </>
      )}
    </div>
  );
}
