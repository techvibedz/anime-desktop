// Weekly airing calendar. Data is AniList's airingSchedules feed (lib/schedule)
// bucketed by local day. Clicking an item resolves it against our own sources
// (resolveSourceUrl) and opens the detail page, falling back to a search.
// Ported from the mobile app (app/schedule.tsx).

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchWeeklySchedule, resolveSourceUrl, type ScheduleDay, type ScheduleItem } from "../lib/schedule";
import { Shimmer } from "../components/Shimmer";
import { t } from "../lib/i18n";

const WEEKDAY_AR = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

function fmtTime(unixSec: number): string {
  try {
    return new Date(unixSec * 1000).toLocaleTimeString("ar", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

export function SchedulePage() {
  const navigate = useNavigate();
  const [days, setDays] = useState<ScheduleDay[] | null>(null);
  const [selected, setSelected] = useState(0);
  const [resolving, setResolving] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchWeeklySchedule()
      .then((d) => { if (!cancelled) setDays(d); })
      .catch(() => { if (!cancelled) setDays([]); });
    return () => { cancelled = true; };
  }, []);

  const day = useMemo(() => (days ? days[selected] : null), [days, selected]);

  async function openItem(it: ScheduleItem) {
    if (resolving != null) return;
    setResolving(it.id);
    const url = await resolveSourceUrl(it.title).catch(() => null);
    setResolving(null);
    if (url) navigate(`/anime/${encodeURIComponent(url)}`);
    else navigate(`/search?q=${encodeURIComponent(it.title)}`);
  }

  return (
    <div className="space-y-6">
      <h1 className="font-display text-2xl font-extrabold text-white">{t.scheduleTitle}</h1>

      {!days ? (
        <Shimmer className="h-10 w-full rounded-full" />
      ) : (
        <div className="flex flex-wrap gap-2">
          {days.map((d, i) => (
            <button
              key={d.dayStart}
              onClick={() => setSelected(i)}
              className={`rounded-full border px-4 py-1.5 text-sm font-semibold transition ${
                selected === i
                  ? "border-accent bg-accent text-white shadow-glow"
                  : "border-white/10 bg-surface text-text-secondary hover:border-white/30 hover:text-white"
              }`}
            >
              {i === 0 ? t.scheduleToday : WEEKDAY_AR[d.weekday]}
            </button>
          ))}
        </div>
      )}

      {!days ? (
        <div className="space-y-3">
          {Array.from({ length: 6 }).map((_, i) => <Shimmer key={i} className="h-20 w-full rounded-xl" />)}
        </div>
      ) : !day || day.items.length === 0 ? (
        <p className="py-16 text-center text-text-muted">{t.scheduleEmpty}</p>
      ) : (
        <div className="space-y-2">
          {day.items.map((it) => (
            <button
              key={`${it.id}-${it.airingAt}`}
              onClick={() => openItem(it)}
              className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-surface p-2.5 text-start transition hover:border-white/30"
            >
              <div className="relative h-16 w-12 shrink-0 overflow-hidden rounded-md bg-bg">
                {it.image ? <img src={it.image} alt="" className="h-full w-full object-cover" loading="lazy" /> : <div className="h-full w-full shimmer" />}
                {resolving === it.id && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/60">
                    <div className="h-5 w-5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="line-clamp-1 font-semibold text-white">{it.title}</h3>
                <p className="text-xs text-text-muted">
                  {it.episode ? t.scheduleEp(it.episode) : ""}
                  {it.episode ? " · " : ""}
                  {t.scheduleAt(fmtTime(it.airingAt))}
                </p>
              </div>
              {it.score != null && it.score > 0 && (
                <span className="shrink-0 rounded-md bg-black/40 px-2 py-0.5 text-xs font-bold text-amber-300">★ {(it.score / 10).toFixed(1)}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
