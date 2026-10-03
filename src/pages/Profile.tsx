import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { getHistory, isCompleted, type WatchEntry } from "../lib/history";
import { countCompletedAnime } from "../lib/completion";
import { getFavorites, toAnimeUrl } from "../lib/favorites";
import { updateProfile } from "../lib/profile";
import { usePosterImage } from "../lib/posters";
import { extractEpisodeNumber } from "../lib/episode-utils";
import { t } from "../lib/i18n";

interface Stats {
  episodesWatched: number;
  watchHours: number;
  watchMins: number;
  animeInList: number;
  watching: number;
  planned: number;
  completedAnime: number;
  recent: WatchEntry[];
}

const EMPTY: Stats = {
  episodesWatched: 0, watchHours: 0, watchMins: 0, animeInList: 0,
  watching: 0, planned: 0, completedAnime: 0, recent: [],
};

function arMonthYear(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  try {
    return d.toLocaleDateString("ar", { month: "long", year: "numeric" });
  } catch {
    return `${d.getMonth() + 1}/${d.getFullYear()}`;
  }
}

function RecentRow({ entry, onOpen }: { entry: WatchEntry; onOpen: (entry: WatchEntry) => void }) {
  const poster = usePosterImage(entry.image, entry.animeHref || entry.episodeHref);
  const done = isCompleted(entry);
  return (
    <button
      onClick={() => onOpen(entry)}
      className="flex w-full items-center gap-3 py-3.5 text-start transition-colors hover:bg-white/[0.03]"
    >
      <div className="h-14 w-[88px] shrink-0 overflow-hidden rounded-md bg-bg">
        {poster.src ? (
          <img src={poster.src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={poster.onError} className="h-full w-full object-cover" />
        ) : poster.repairing ? (
          <div className="h-full w-full shimmer" />
        ) : (
          <div className="h-full w-full bg-raised" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="line-clamp-1 text-[13px] font-semibold text-white">{entry.episodeTitle || entry.animeTitle}</p>
        <p className="mt-0.5 line-clamp-1 text-[11px] text-text-muted">{entry.animeTitle}</p>
      </div>
      {done && (
        <svg className="shrink-0 text-green" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="12" cy="12" r="9" />
          <path d="m8.5 12.5 2.5 2.5 4.5-5" />
        </svg>
      )}
    </button>
  );
}

export function ProfilePage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [stats, setStats] = useState<Stats>(EMPTY);

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [bio, setBio] = useState("");
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [avatarError, setAvatarError] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getHistory(), getFavorites(), countCompletedAnime()])
      .then(([history, favs, completedAnime]) => {
        if (cancelled) return;
        const totalMin = Math.floor(history.reduce((sum, e) => sum + (e.positionMs || 0), 0) / 60000);
        setStats({
          episodesWatched: history.filter(isCompleted).length,
          watchHours: Math.floor(totalMin / 60),
          watchMins: totalMin % 60,
          animeInList: favs.length,
          watching: favs.filter((f) => f.list === "watching").length,
          planned: favs.filter((f) => f.list === "planned").length,
          completedAnime,
          recent: history.slice(0, 6),
        });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const displayName =
    user?.user_metadata?.full_name ||
    user?.user_metadata?.name ||
    (user?.email ? user.email.split("@")[0] : t.guest);
  const bioText = (user?.user_metadata?.bio as string) || "";
  const avatarUrl = user?.user_metadata?.avatar_url || user?.user_metadata?.picture || null;
  const initial = (displayName || "?").trim().charAt(0).toUpperCase();
  const since = arMonthYear(user?.created_at);
  const shownAvatar = avatarPreview || avatarUrl;

  useEffect(() => {
    if (!editing) {
      setName(displayName === t.guest ? "" : displayName);
      setBio(bioText);
    }
  }, [displayName, bioText, editing]);

  useEffect(() => { setAvatarError(false); }, [shownAvatar]);

  useEffect(() => () => {
    if (avatarPreview) URL.revokeObjectURL(avatarPreview);
  }, [avatarPreview]);

  const beginEdit = useCallback(() => {
    setName(displayName === t.guest ? "" : displayName);
    setBio(bioText);
    setAvatarFile(null);
    setAvatarPreview(null);
    setEditing(true);
  }, [displayName, bioText]);

  const cancelEdit = useCallback(() => {
    setAvatarFile(null);
    setAvatarPreview(null);
    setEditing(false);
  }, []);

  const pickAvatar = useCallback((file: File | null) => {
    if (!file) return;
    setAvatarFile(file);
    setAvatarPreview(URL.createObjectURL(file));
    setAvatarError(false);
  }, []);

  const onSave = useCallback(async () => {
    if (saving) return;
    if (!name.trim()) {
      alert(t.profileNameRequired);
      return;
    }
    setSaving(true);
    try {
      const r = await updateProfile({ name, bio, avatarFile });
      if (r.ok) {
        setAvatarFile(null);
        setAvatarPreview(null);
        setEditing(false);
      } else {
        alert(t.profileSaveError);
      }
    } finally {
      setSaving(false);
    }
  }, [saving, name, bio, avatarFile]);

  const resume = useCallback((entry: WatchEntry) => {
    const params = new URLSearchParams();
    if (entry.image) params.set("img", entry.image);
    if (entry.url4up) params.set("up4", entry.url4up);
    const rawAnime = entry.animeHref || entry.episodeHref;
    const animeUrl = rawAnime?.includes("/anime/") ? rawAnime : toAnimeUrl(rawAnime) ?? "";
    if (animeUrl) params.set("anime", animeUrl);
    const num = entry.epNum ?? extractEpisodeNumber(entry.episodeTitle, entry.episodeHref);
    if (num != null) params.set("ep", String(num));
    const qs = params.toString();
    navigate(`/watch/${encodeURIComponent(entry.episodeHref)}${qs ? `?${qs}` : ""}`);
  }, [navigate]);

  const bigStats = [
    { value: String(stats.episodesWatched), label: t.statsEpisodesWatched, color: "text-accent" },
    { value: t.watchTimeValue(stats.watchHours, stats.watchMins), label: t.statsWatchTime, color: "text-violet" },
    { value: String(stats.animeInList), label: t.statsAnimeInList, color: "text-gold" },
  ];
  const miniStats = [
    { value: stats.watching, label: t.statsWatching, color: "text-green" },
    { value: stats.planned, label: t.statsPlanned, color: "text-violet" },
    { value: stats.completedAnime, label: t.statsCompleted, color: "text-green" },
  ];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">{editing ? t.editProfileTitle : t.profileTitle}</h1>
        <div className="flex items-center gap-2">
          {editing ? (
            <button
              onClick={cancelEdit}
              title={t.cancel}
              className="rounded-lg border border-white/10 bg-surface p-2 text-text-muted transition hover:border-white/25 hover:text-white"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          ) : user ? (
            <>
              <button
                onClick={beginEdit}
                title={t.editProfileTitle}
                className="rounded-lg border border-white/10 bg-surface p-2 text-text-muted transition hover:border-white/25 hover:text-white"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                </svg>
              </button>
              <button
                onClick={() => navigate("/settings")}
                title={t.settingsTitle}
                className="rounded-lg border border-white/10 bg-surface p-2 text-text-muted transition hover:border-white/25 hover:text-white"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h.1a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
                </svg>
              </button>
            </>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col items-center pb-4 pt-2">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={!editing}
          className="relative rounded-full bg-gradient-to-br from-accent to-violet p-[3px] disabled:cursor-default"
        >
          <span className="flex h-24 w-24 items-center justify-center overflow-hidden rounded-full bg-bg">
            {shownAvatar && !avatarError ? (
              <img src={shownAvatar} alt="" className="h-full w-full object-cover" onError={() => setAvatarError(true)} />
            ) : (
              <span className="text-4xl font-extrabold text-white">{initial}</span>
            )}
          </span>
          {editing && (
            <span className="pointer-events-none absolute -bottom-1 -left-1 flex h-8 w-8 items-center justify-center rounded-full border-2 border-bg bg-accent text-black shadow-glow">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14.5 4h-5L8 6H4v14h16V6h-4l-1.5-2Z" />
                <circle cx="12" cy="13" r="3.5" />
              </svg>
            </span>
          )}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            pickAvatar(e.target.files?.[0] ?? null);
            e.target.value = "";
          }}
        />

        {editing ? (
          <div className="mt-6 w-full max-w-md space-y-4">
            <label className="block">
              <span className="mb-2 block text-xs font-semibold text-text-secondary">{t.profileNameLabel}</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={40}
                placeholder={t.profileNamePlaceholder}
                className="h-12 w-full rounded-xl border border-white/10 bg-surface px-4 text-sm text-text outline-none transition focus:border-accent/60"
              />
            </label>
            <label className="block">
              <span className="mb-2 block text-xs font-semibold text-text-secondary">{t.profileBioLabel}</span>
              <textarea
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                maxLength={160}
                rows={3}
                placeholder={t.profileBioPlaceholder}
                className="w-full resize-none rounded-xl border border-white/10 bg-surface p-4 text-sm leading-6 text-text outline-none transition focus:border-accent/60"
              />
            </label>
            <div className="flex items-center gap-2.5 pt-1">
              <button
                onClick={onSave}
                disabled={saving}
                className="h-12 flex-1 rounded-xl bg-accent text-sm font-bold text-black transition hover:bg-accent-bright disabled:opacity-60"
              >
                {saving ? t.profileSaving : t.profileSave}
              </button>
              <button
                onClick={cancelEdit}
                disabled={saving}
                className="h-12 rounded-xl border border-white/15 bg-surface px-6 text-sm font-bold text-text-secondary transition hover:border-white/30 hover:text-white"
              >
                {t.cancel}
              </button>
            </div>
          </div>
        ) : (
          <>
            <h2 className="mt-4 text-center text-2xl font-bold text-white">{displayName}</h2>
            {user?.email && <p className="mt-1 text-xs text-text-secondary" dir="ltr">{user.email}</p>}
            {bioText && <p className="mt-3 max-w-xl text-center text-sm leading-6 text-text-secondary">{bioText}</p>}
            {since && (
              <span className="mt-3 rounded-full border border-violet/40 bg-violet/10 px-3 py-1.5 text-xs font-semibold text-text-secondary">
                {t.memberSince(since)}
              </span>
            )}
          </>
        )}
      </div>

      {!editing && (
        <>
          <div className="overflow-hidden rounded-xl border border-white/10 bg-surface">
            <div className="grid grid-cols-3 divide-x divide-white/10 py-5">
              {bigStats.map((s) => (
                <div key={s.label} className="flex flex-col items-center px-2">
                  <span className={`text-lg font-extrabold ${s.color}`}>{s.value}</span>
                  <span className="mt-1 text-center text-[11px] text-text-muted">{s.label}</span>
                </div>
              ))}
            </div>
            <div className="h-px bg-white/10" />
            <div className="grid grid-cols-3 divide-x divide-white/10 py-3.5">
              {miniStats.map((s) => (
                <div key={s.label} className="flex flex-col items-center px-2">
                  <span className={`text-base font-extrabold ${s.color}`}>{s.value}</span>
                  <span className="mt-0.5 text-center text-[10px] text-text-muted">{s.label}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="pt-3">
            <h2 className="text-lg font-bold text-white">{t.recentActivity}</h2>
            {stats.recent.length === 0 ? (
              <div className="flex flex-col items-center py-10 text-center">
                <div className="flex h-16 w-16 items-center justify-center rounded-full border border-white/10 bg-surface text-text-muted">
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="4" width="18" height="16" rx="2" />
                    <path d="m9 8.5 6 3.5-6 3.5v-7Z" />
                  </svg>
                </div>
                <p className="mt-3 text-sm text-text-muted">{t.noActivity}</p>
              </div>
            ) : (
              <div className="divide-y divide-white/5">
                {stats.recent.map((e) => <RecentRow key={e.episodeHref} entry={e} onOpen={resume} />)}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
