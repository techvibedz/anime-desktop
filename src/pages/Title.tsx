// AniList title detail — used for Upcoming anime (and their relations), which
// aren't on our sources yet, so everything here comes from AniList: banner,
// synopsis (translated to Arabic on the fly), studios, air date, genres and the
// relation graph. "ابحث في مصادرنا" jumps to Search pre-filled; a related card
// opens that title's own AniList detail.
// Ported from the mobile app (app/title/[id].tsx).

import { useEffect, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { fetchAniListDetail, type AniListDetail } from "../lib/seasons";
import { translateToArabic } from "../lib/translate";
import { arGenre, arFormat } from "../lib/anilistLabels";
import { Shimmer } from "../components/Shimmer";
import { t } from "../lib/i18n";

const STATUS_AR: Record<string, string> = {
  RELEASING: t.statusReleasing,
  FINISHED: t.statusFinished,
  NOT_YET_RELEASED: t.statusNotYet,
  CANCELLED: t.statusCancelled,
  HIATUS: t.statusHiatus,
};

function fmtDate(unixSec: number | null): string | null {
  if (!unixSec) return null;
  try {
    return new Date(unixSec * 1000).toLocaleDateString("ar", { year: "numeric", month: "long", day: "numeric" });
  } catch {
    return null;
  }
}

export function TitlePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const numId = Number(id);
  const [detail, setDetail] = useState<AniListDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [story, setStory] = useState<string>("");
  const [translating, setTranslating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setStory("");
    setDetail(null);
    fetchAniListDetail(numId)
      .then(async (d) => {
        if (cancelled) return;
        setDetail(d);
        setLoading(false);
        if (d?.description) {
          setTranslating(true);
          const ar = await translateToArabic(d.description).catch(() => d.description);
          if (!cancelled) { setStory(ar); setTranslating(false); }
        }
      })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [numId]);

  if (loading) {
    return (
      <div className="space-y-6">
        <Shimmer className="h-[280px] w-full rounded-2xl" />
        <Shimmer className="h-6 w-1/2" />
        <Shimmer className="h-24 w-full" />
      </div>
    );
  }

  if (!detail) {
    return <p className="py-20 text-center text-text-muted">{t.notFound}</p>;
  }

  const airDate = fmtDate(detail.startAt);
  const details: { label: string; value: string }[] = [];
  if (detail.studios.length) details.push({ label: t.titleStudio, value: detail.studios.join("، ") });
  if (detail.status) details.push({ label: t.titleStatus, value: STATUS_AR[detail.status] || detail.status });
  if (detail.format) details.push({ label: t.titleFormat, value: arFormat(detail.format) || detail.format });
  if (airDate) details.push({ label: t.titleAirDate, value: airDate });
  if (detail.episodes) details.push({ label: t.episodes, value: t.titleEpisodes(detail.episodes) });
  if (detail.duration) details.push({ label: "المدة", value: t.titleDuration(detail.duration) });

  return (
    <div className="space-y-8">
      {/* Banner */}
      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-surface">
        {detail.banner && (
          <img src={detail.banner} alt="" className="h-[280px] w-full object-cover" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-bg via-bg/40 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 flex items-end gap-4 p-5">
          {detail.cover && (
            <img src={detail.cover} alt={detail.title} className="hidden h-40 w-28 shrink-0 rounded-lg border border-white/10 object-cover shadow-card sm:block" />
          )}
          <div className="min-w-0">
            <h1 className="font-display text-2xl font-extrabold text-white drop-shadow">{detail.title}</h1>
            {detail.titleEnglish && detail.titleEnglish !== detail.title && (
              <p className="text-sm text-text-secondary">{detail.titleEnglish}</p>
            )}
            {detail.score != null && detail.score > 0 && (
              <span className="mt-2 inline-block rounded-md bg-black/50 px-2 py-0.5 text-xs font-bold text-amber-300">★ {(detail.score / 10).toFixed(1)}</span>
            )}
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-3">
        <button
          onClick={() => navigate(`/search?q=${encodeURIComponent(detail.title)}`)}
          className="rounded-full bg-accent px-5 py-2 text-sm font-bold text-white shadow-glow transition hover:bg-accent/80"
        >
          {t.searchOnSources}
        </button>
        {detail.trailerYoutube && (
          <button
            onClick={() => window.pantoufa.openExternal?.(`https://www.youtube.com/watch?v=${detail.trailerYoutube}`)}
            className="rounded-full border border-white/15 bg-surface px-5 py-2 text-sm font-semibold text-white transition hover:border-white/30"
          >
            {t.watchTrailer}
          </button>
        )}
      </div>

      {/* Genres */}
      {detail.genres.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {detail.genres.map((g) => (
            <span key={g} className="rounded-full border border-white/10 bg-surface px-3 py-1 text-xs text-text-secondary">{arGenre(g)}</span>
          ))}
        </div>
      )}

      {/* Story */}
      {(story || translating) && (
        <section className="space-y-2">
          <h2 className="font-display text-lg font-bold text-white">{t.titleStory}</h2>
          {translating && !story ? (
            <p className="text-sm text-text-muted">{t.translating}</p>
          ) : (
            <p className="whitespace-pre-line leading-relaxed text-text-secondary">{story}</p>
          )}
        </section>
      )}

      {/* Details */}
      {details.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-display text-lg font-bold text-white">{t.titleDetails}</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {details.map((d) => (
              <div key={d.label} className="rounded-lg border border-white/10 bg-surface p-3">
                <p className="text-[11px] uppercase tracking-wider text-text-muted">{d.label}</p>
                <p className="text-sm font-semibold text-white">{d.value}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Related */}
      {detail.relations.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-display text-lg font-bold text-white">{t.titleRelated}</h2>
          <div className="grid grid-cols-6 gap-4">
            {detail.relations.map((r) => (
              <Link key={r.id} to={`/title/${r.id}`} className="group block">
                <div className="relative aspect-[2/3] overflow-hidden rounded-lg bg-surface">
                  {r.image ? (
                    <img src={r.image} alt={r.title} className="h-full w-full object-cover transition group-hover:scale-105" loading="lazy" />
                  ) : <div className="h-full w-full shimmer" />}
                  <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/85 to-transparent" />
                  <div className="absolute inset-x-0 bottom-0 p-2">
                    <h3 className="line-clamp-2 text-[12px] font-semibold text-white">{r.title}</h3>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
