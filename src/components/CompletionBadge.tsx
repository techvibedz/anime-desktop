// Poster-card badge marking an anime the user has finished or caught up on.
//   • finished  → emerald "مكتمل" pill (watched the real finale)
//   • caught up → cyan "آخر حلقة" pill (watched the latest available episode)
// Reads the shared completion lookup (lib/completion); renders nothing when the
// anime isn't tracked, so it's safe to drop onto every card.

import { useAnimeCompletion } from "../lib/completion";
import { t } from "../lib/i18n";

export function CompletionBadge({
  hrefs,
  titles,
  className = "absolute bottom-2 end-2",
}: {
  hrefs?: (string | null | undefined)[];
  titles?: (string | null | undefined)[];
  className?: string;
}) {
  const rec = useAnimeCompletion(hrefs, titles);
  if (!rec || (!rec.finished && !rec.caughtUp)) return null;
  const finished = rec.finished;
  return (
    <span
      className={`z-10 flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold text-white shadow ${
        finished ? "bg-emerald-500" : "bg-cyan-500"
      } ${className}`}
    >
      <span aria-hidden>{finished ? "✓✓" : "✓"}</span>
      {finished ? t.completedBadge : t.caughtUpBadge}
    </span>
  );
}
