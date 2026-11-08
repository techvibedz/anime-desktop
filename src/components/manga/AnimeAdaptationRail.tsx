// Manga detail: "adapted as anime" rail (reverse of the anime → manga bridge).
// AniList maps the manga to its anime adaptations; cards open through the
// AniList → source resolution like every other AniList poster.

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { findAnimeAdaptations, type AnimeAdaptation } from "../../lib/mangaAdaptations";
import { resolveSourceUrl } from "../../lib/schedule";
import { t } from "../../lib/i18n";

export function AnimeAdaptationRail({ titles }: { titles: string[] }) {
  const navigate = useNavigate();
  const [items, setItems] = useState<AnimeAdaptation[]>([]);
  const [busyId, setBusyId] = useState<number | null>(null);
  const titlesKey = titles.join("|");
  useEffect(() => {
    let alive = true;
    setItems([]);
    void (async () => {
      for (const title of titles) {
        const found = await findAnimeAdaptations(title);
        if (!alive) return;
        if (found.length) {
          setItems(found);
          return;
        }
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [titlesKey]);

  const open = async (it: AnimeAdaptation) => {
    if (busyId != null) return;
    setBusyId(it.anilistId);
    try {
      const href = await resolveSourceUrl(it.title).catch(() => null)
        ?? (it.titleEnglish ? await resolveSourceUrl(it.titleEnglish).catch(() => null) : null);
      navigate(href ? `/anime/${encodeURIComponent(href)}` : `/title/${it.anilistId}`);
    } finally {
      setBusyId(null);
    }
  };

  if (!items.length) return null;
  return (
    <section className="mt-6">
      <h2 className="mb-3 flex items-center gap-1.5 text-sm font-bold text-m-ink">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-m-accent" aria-hidden><rect x="2" y="7" width="20" height="14" rx="2" /><path d="m17 2-5 5-5-5" /></svg>
        {t.adaptedAsAnime}
      </h2>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {items.map((it) => (
          <button
            key={it.anilistId}
            type="button"
            onClick={() => void open(it)}
            disabled={busyId === it.anilistId}
            className="group w-[112px] shrink-0 text-start"
          >
            <div className="relative aspect-[2/3] overflow-hidden rounded border border-m-line bg-m-wash">
              {it.image && <img src={it.image} alt="" loading="lazy" className="h-full w-full object-cover transition duration-300 group-hover:scale-105" />}
              {busyId === it.anilistId && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/45">
                  <span className="h-6 w-6 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                </div>
              )}
            </div>
            <p className="mt-1.5 line-clamp-2 text-xs font-bold leading-5 text-m-ink">{it.title}</p>
            <p className="line-clamp-1 text-[10px] font-medium text-m-muted">
              {[it.year, it.episodes ? t.episodeCount(it.episodes) : null].filter(Boolean).join(" · ")}
            </p>
            {it.endChapter ? <p className="line-clamp-1 text-[10px] font-semibold text-m-accent">{t.adaptationUpTo(it.endChapter)}</p> : null}
          </button>
        ))}
      </div>
    </section>
  );
}
