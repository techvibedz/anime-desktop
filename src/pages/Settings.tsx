// Settings — desktop port of the mobile app's app/settings.tsx. Notification
// preferences (master switch, scope, local test notification), playback toggles,
// data cleanup and update check. The mobile admin-only OTA section and the
// rewarded-ad preview are intentionally omitted: electron-updater + UpdateBanner
// handle updates on desktop. Hidden entry to /scraper-debug: tap the version 7×.

import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { t } from "../lib/i18n";
import { APP_VERSION } from "../lib/appVersion";
import {
  clearContentCache,
  getAutoSkipIntro,
  getAutoplayNext,
  getDailyAnimeNotif,
  getNotificationScope,
  getNotificationsEnabled,
  getPrefetchNext,
  setAutoSkipIntro,
  setAutoplayNext,
  setDailyAnimeNotif,
  setNotificationScope,
  setNotificationsEnabled,
  setPrefetchNext,
  type NotificationScope,
} from "../lib/settings";
import { pullHistoryFromCloud } from "../lib/history";
import { storage } from "../lib/storage";

type IconName =
  | "bell" | "globe" | "heart" | "send" | "playNext" | "skipIntro"
  | "download" | "sparkles" | "trash" | "clock" | "cloudDown";

const ICONS: Record<IconName, string> = {
  bell: "M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9|M13.7 21a2 2 0 0 1-3.4 0",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z|M3 12h18|M12 3c2.5 2.5 3.9 5.6 3.9 9s-1.4 6.5-3.9 9c-2.5-2.5-3.9-5.6-3.9-9S9.5 5.5 12 3Z",
  heart: "M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8Z",
  send: "m22 2-7 20-4-9-9-4Z|M22 2 11 13",
  playNext: "m6 4 12 8-12 8V4Z|M20 5v14",
  skipIntro: "m5 4 10 8-10 8V4Z|M19 5v14",
  download: "M12 3v12|m7 10 5 5 5-5|M5 21h14",
  sparkles: "m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z|M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15Z",
  trash: "M4 6h16|M9 6V4h6v2|M6 6v14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6|M10 11v6|M14 11v6",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z|M12 7v5l3 3",
  cloudDown: "M20 17.6A4.4 4.4 0 0 0 17.5 10h-1.3A7 7 0 1 0 5 16.7|M12 12v8|m8.5 16.5 3.5 3.5 3.5-3.5",
};

function Icon({ name }: { name: IconName }) {
  return (
    <svg
      width="18" height="18" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden
    >
      {ICONS[name].split("|").map((p, i) => <path key={i} d={p} />)}
    </svg>
  );
}

function RowIcon({ name, danger }: { name: IconName; danger?: boolean }) {
  return (
    <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${danger ? "bg-red-500/10 text-red-400" : "bg-white/5 text-text-secondary"}`}>
      <Icon name={name} />
    </span>
  );
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button" role="switch" aria-checked={checked} aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? "bg-accent" : "bg-white/15"}`}
    >
      <span
        className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all"
        style={{ insetInlineStart: checked ? "1.375rem" : "0.125rem" }}
      />
    </button>
  );
}

function ToggleRow({ icon, title, desc, checked, onChange }: {
  icon: IconName; title: string; desc: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-4 px-4 py-3.5">
      <RowIcon name={icon} />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-white">{title}</span>
        <span className="mt-0.5 block text-xs leading-5 text-text-muted">{desc}</span>
      </span>
      <Switch checked={checked} onChange={onChange} label={title} />
    </div>
  );
}

function ActionRow({ icon, title, desc, onPress, danger, busy, testId }: {
  icon: IconName; title: string; desc: string; onPress: () => void;
  danger?: boolean; busy?: boolean; testId?: string;
}) {
  return (
    <button
      type="button" onClick={onPress} disabled={busy} data-testid={testId}
      className="flex w-full items-center gap-4 px-4 py-3.5 text-start transition-colors hover:bg-white/[0.03] disabled:opacity-60"
    >
      <RowIcon name={icon} danger={danger} />
      <span className="min-w-0 flex-1">
        <span className={`block text-sm font-semibold ${danger ? "text-red-400" : "text-white"}`}>{title}</span>
        <span className="mt-0.5 block text-xs leading-5 text-text-muted">{desc}</span>
      </span>
      {busy ? (
        <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-white/20 border-t-accent" />
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-text-muted" aria-hidden>
          <path d="m14 6-6 6 6 6" />
        </svg>
      )}
    </button>
  );
}

function ScopeRow({ scope, onChange }: { scope: NotificationScope; onChange: (v: NotificationScope) => void }) {
  return (
    <div className="flex items-center gap-4 px-4 py-3.5">
      <RowIcon name="bell" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-white">{t.settingsNotifScope}</span>
        <span className="mt-0.5 block text-xs leading-5 text-text-muted">{t.settingsNotifScopeDesc}</span>
      </span>
      <div className="flex w-56 shrink-0 gap-1.5 rounded-xl bg-bg p-1">
        {(["all", "mylist"] as NotificationScope[]).map((key) => {
          const active = scope === key;
          return (
            <button
              key={key} type="button" onClick={() => onChange(key)}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-bold transition-colors ${active ? "bg-accent text-black" : "text-text-secondary hover:text-white"}`}
            >
              <Icon name={key === "all" ? "globe" : "heart"} />
              {key === "all" ? t.scopeAll : t.scopeMyList}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2.5">
      <h2 className="px-1 text-xs font-bold uppercase tracking-wider text-text-muted">{label}</h2>
      <div className="divide-y divide-white/5 overflow-hidden rounded-2xl border border-white/10 bg-surface shadow-card">
        {children}
      </div>
    </section>
  );
}

type TestState = "idle" | "sending" | "sent" | "failed";

export function SettingsPage() {
  const navigate = useNavigate();
  const [notifs, setNotifs] = useState(true);
  const [autoplay, setAutoplay] = useState(true);
  const [autoSkip, setAutoSkip] = useState(false);
  const [scope, setScope] = useState<NotificationScope>("all");
  const [prefetch, setPrefetch] = useState(true);
  const [dailyAnime, setDailyAnime] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testState, setTestState] = useState<TestState>("idle");
  const [checking, setChecking] = useState(false);
  const [updateDesc, setUpdateDesc] = useState(`${t.settingsVersion} v${APP_VERSION}`);
  const [notice, setNotice] = useState<string | null>(null);
  const [verTaps, setVerTaps] = useState(0);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [n, a, s, sc, p, d] = await Promise.all([
        getNotificationsEnabled(),
        getAutoplayNext(),
        getAutoSkipIntro(),
        getNotificationScope(),
        getPrefetchNext(),
        getDailyAnimeNotif(),
      ]);
      if (!alive) return;
      setNotifs(n); setAutoplay(a); setAutoSkip(s); setScope(sc); setPrefetch(p); setDailyAnime(d);
    })();
    return () => { alive = false; };
  }, []);

  const toggleNotifs = useCallback((value: boolean) => {
    setNotifs(value);
    void setNotificationsEnabled(value);
  }, []);

  const changeScope = useCallback((value: NotificationScope) => {
    setScope(value);
    void setNotificationScope(value);
  }, []);

  const toggleAutoplay = useCallback((value: boolean) => {
    setAutoplay(value);
    void setAutoplayNext(value);
  }, []);

  const toggleAutoSkip = useCallback((value: boolean) => {
    setAutoSkip(value);
    void setAutoSkipIntro(value);
  }, []);

  const togglePrefetch = useCallback((value: boolean) => {
    setPrefetch(value);
    void setPrefetchNext(value);
  }, []);

  const toggleDailyAnime = useCallback((value: boolean) => {
    setDailyAnime(value);
    void setDailyAnimeNotif(value);
  }, []);

  // Desktop has no push permission to request — the OS notification fires while
  // the app runs (notifications.ts) and notify() reports success directly.
  const onSendTest = useCallback(async () => {
    if (testing) return;
    setTesting(true);
    setTestState("sending");
    try {
      const ok = await window.pantoufa?.notify?.({ title: t.testNotifTitle, body: t.testNotifBody });
      setTestState(ok ? "sent" : "failed");
    } catch {
      setTestState("failed");
    } finally {
      setTesting(false);
    }
  }, [testing]);

  const onClearCache = useCallback(async () => {
    const n = await clearContentCache();
    setNotice(t.cacheCleared(n));
  }, []);

  const onClearHistory = useCallback(async () => {
    if (!confirm(t.confirmClearHistory)) return;
    await storage.removeItem("watch_history");
    await storage.removeItem("watch_history_dismissed_desktop");
    setNotice(t.historyCleared);
    // ponytail: history.ts has no clear-all export; cloud rows re-merge on pull.
    void pullHistoryFromCloud().catch(() => {});
  }, []);

  const onCheckUpdate = useCallback(async () => {
    if (checking) return;
    setChecking(true);
    setUpdateDesc(t.updateChecking);
    try {
      const res = await window.pantoufa?.checkForUpdates?.();
      setUpdateDesc(res?.ok ? t.updateCheckDone : t.updateCheckFailed);
    } catch {
      setUpdateDesc(t.updateCheckFailed);
    } finally {
      setChecking(false);
    }
  }, [checking]);

  const onVersionTap = useCallback(() => {
    setVerTaps((n) => {
      const next = n + 1;
      if (next >= 7) { navigate("/scraper-debug"); return 0; }
      return next;
    });
  }, [navigate]);

  const testDesc =
    testState === "sending" ? t.testNotifSending
    : testState === "sent" ? t.testNotifSent
    : testState === "failed" ? t.testNotifFailed
    : t.settingsTestNotifDesc;

  return (
    <div dir="rtl" className="mx-auto max-w-2xl space-y-6 pb-10">
      <h1 className="text-2xl font-bold text-white">{t.settingsTitle}</h1>

      {notice && (
        <div className="rounded-xl border border-accent/30 bg-accent/10 px-4 py-3 text-sm font-semibold text-accent">
          {notice}
        </div>
      )}

      <Section label={t.settingsGeneral}>
        <ToggleRow icon="bell" title={t.settingsNotifications} desc={t.settingsNotificationsDesc} checked={notifs} onChange={toggleNotifs} />
        {notifs && (
          <>
            <ScopeRow scope={scope} onChange={changeScope} />
            <ActionRow
              icon="send" title={t.settingsTestNotif} desc={testDesc}
              onPress={onSendTest} busy={testing} testId="test-notification"
            />
          </>
        )}
        <ToggleRow icon="playNext" title={t.settingsAutoplay} desc={t.settingsAutoplayDesc} checked={autoplay} onChange={toggleAutoplay} />
        <ToggleRow icon="skipIntro" title={t.settingsAutoSkipIntro} desc={t.settingsAutoSkipIntroDesc} checked={autoSkip} onChange={toggleAutoSkip} />
        <ToggleRow icon="download" title={t.settingsPrefetchNext} desc={t.settingsPrefetchNextDesc} checked={prefetch} onChange={togglePrefetch} />
        {notifs && (
          <ToggleRow icon="sparkles" title={t.settingsDailyAnime} desc={t.settingsDailyAnimeDesc} checked={dailyAnime} onChange={toggleDailyAnime} />
        )}
      </Section>

      <Section label={t.settingsData}>
        <ActionRow icon="trash" title={t.settingsClearCache} desc={t.settingsClearCacheDesc} onPress={onClearCache} />
        <ActionRow icon="clock" title={t.settingsClearHistory} desc={t.settingsClearHistoryDesc} onPress={onClearHistory} danger />
      </Section>

      <Section label={t.settingsAbout}>
        <ActionRow
          icon="cloudDown" title={t.settingsCheckUpdate} desc={updateDesc}
          onPress={onCheckUpdate} busy={checking} testId="check-updates"
        />
      </Section>

      <div className="flex flex-col items-center gap-1 pt-8">
        <img src="./logo.png" alt="" className="mb-2 h-12 w-12 rounded-2xl" />
        <p className="text-lg font-extrabold text-white">{t.settingsAppName}</p>
        <p className="text-xs text-text-secondary">{t.settingsTagline}</p>
        <button
          type="button" onClick={onVersionTap} title={t.settingsVersion}
          className="mt-1 select-none text-[11px] text-text-muted transition-colors hover:text-text-secondary"
        >
          v{APP_VERSION}
        </button>
      </div>
    </div>
  );
}
