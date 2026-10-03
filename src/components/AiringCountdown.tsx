// Live "next episode in …" countdown for the anime detail header. Ported from
// the mobile app (components/AiringCountdown.tsx).
//
// Fetches the next airing time once (cached — see lib/airing) and then ticks
// locally every second, so it paints the moment the page's data arrives and
// never re-hits the network. Renders nothing for finished/non-airing anime, so
// it's safe to drop in unconditionally without reserving layout.

import { useEffect, useRef, useState } from "react";
import { fetchNextAiring, type NextAiring } from "../lib/airing";
import { t } from "../lib/i18n";

function parts(msLeft: number) {
  const s = Math.max(0, Math.floor(msLeft / 1000));
  return {
    days: Math.floor(s / 86400),
    hours: Math.floor((s % 86400) / 3600),
    mins: Math.floor((s % 3600) / 60),
    secs: s % 60,
  };
}

export function AiringCountdown({ title, lastEpisode }: { title: string | null | undefined; lastEpisode?: number | null }) {
  const [info, setInfo] = useState<NextAiring | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Resolve the next airing episode for this title.
  useEffect(() => {
    if (!title) { setInfo(null); return; }
    let cancelled = false;
    fetchNextAiring(title).then((n) => { if (!cancelled) setInfo(n); });
    return () => { cancelled = true; };
  }, [title]);

  // Once the target time passes, re-resolve: the just-aired episode rolls over
  // to the one after it instead of sticking on the old number.
  const aired = !!info && info.airingAt * 1000 <= now;
  useEffect(() => {
    if (!title || !aired) return;
    let cancelled = false;
    const refetch = setTimeout(() => {
      fetchNextAiring(title).then((n) => { if (!cancelled) setInfo(n); });
    }, 2000);
    return () => { cancelled = true; clearTimeout(refetch); };
  }, [title, aired]);

  // Tick every second while we have an upcoming episode. Stops once it airs so
  // we don't keep a needless interval alive in the background.
  //
  // Battery: a 1s interval that keeps firing while the window is hidden (or
  // minimized) wakes the JS thread every second for a digit nobody can see. Run
  // the interval ONLY while the window is visible — pause it on hide and resync
  // on show (a single setNow snaps the digits back instantly).
  useEffect(() => {
    if (!info) return;
    const target = info.airingAt * 1000;
    const tick = () => setNow(Date.now());

    const start = () => {
      if (timer.current || Date.now() >= target) return;
      tick();
      timer.current = setInterval(() => {
        if (Date.now() >= target && timer.current) {
          clearInterval(timer.current);
          timer.current = null;
        }
        tick();
      }, 1000);
    };
    const stop = () => {
      if (timer.current) { clearInterval(timer.current); timer.current = null; }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") { tick(); start(); }
      else stop();
    };
    if (document.visibilityState === "visible") start();
    else tick();

    document.addEventListener("visibilitychange", onVisibility);
    return () => { stop(); document.removeEventListener("visibilitychange", onVisibility); };
  }, [info]);

  if (!info) return null;
  // Never advertise an episode the page already carries (a season-mismatched
  // AniList entry used to show a wrong/lower number here).
  if (lastEpisode != null && lastEpisode > 0 && info.episode <= lastEpisode) return null;

  const msLeft = info.airingAt * 1000 - now;

  if (msLeft <= 0) {
    return (
      <div className="mt-4 flex items-center gap-2 rounded-xl border border-accent/30 bg-accent/10 px-3.5 py-2.5">
        <span className="h-2 w-2 rounded-full bg-accent" />
        <span className="text-[13px] font-bold text-accent">{t.airingNow(info.episode)}</span>
      </div>
    );
  }

  const { days, hours, mins, secs } = parts(msLeft);
  const segs = [
    ...(days > 0 ? [{ value: days, unit: t.cdDays }] : []),
    { value: hours, unit: t.cdHours },
    { value: mins, unit: t.cdMins },
    ...(days === 0 ? [{ value: secs, unit: t.cdSecs }] : []),
  ];

  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-surface px-3.5 py-4">
      <div className="flex items-center gap-1.5 text-violet">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
        <span className="text-xs font-bold">{t.nextEpIn(info.episode)}</span>
      </div>
      <div className="flex items-center gap-1.5">
        {segs.map((s, i) => (
          <div key={i} className="min-w-[34px] px-1.5 py-1 text-center">
            <div className="text-xl font-bold tabular-nums text-text">{String(s.value).padStart(2, "0")}</div>
            <div className="mt-0.5 text-[9px] font-semibold text-text-muted">{s.unit}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
