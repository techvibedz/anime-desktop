// Manga detail — cover plate, read-progress signal, collapsible synopsis,
// read/continue + library actions, and the merged cross-source chapter list
// (mobile app/manga/[id].tsx parity, laid out as two columns for desktop).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { t } from "../../lib/i18n";
import { normFuzzy } from "../../lib/fuzzy";
import { chapterNumberKey, fetchMergedDetail, readCachedMergedDetail } from "../../lib/manga/aggregate";
import { decodeMangaRef, type MergedChapter, type MergedMangaDetail } from "../../lib/manga/types";
import { upgradeMangaCover } from "../../lib/manga/cover";
import {
  mangaChapterReadKey,
  setMangaChapterRead,
  toggleMangaLibrary,
  useInMangaLibrary,
  useMangaProgress,
  useReadChapters,
} from "../../lib/manga/store";
import { mangaReaderPath } from "../../lib/manga/nav";
import { ChapterRow, ICONS, MangaCover, MangaPage, MangaSkeleton, MangaState, MIcon } from "../../components/manga/MangaUI";

const CHAPTER_PAGE = 120;

export function MangaDetailPage() {
  const { ref = "" } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const decoded = useMemo(() => decodeMangaRef(ref), [ref]);
  const source = decoded?.source ?? "asq";
  const nativeId = decoded?.id ?? "";
  const titleParam = params.get("title") ?? "";
  const coverParam = params.get("cover") ?? "";

  const [chapterQuery, setChapterQuery] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [detail, setDetail] = useState<MergedMangaDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [newestFirst, setNewestFirst] = useState(true);
  const [synopsisOpen, setSynopsisOpen] = useState(false);
  const [visible, setVisible] = useState(CHAPTER_PAGE);
  const loadSeq = useRef(0);

  const saved = useInMangaLibrary(source, nativeId);
  const progress = useMangaProgress(source, nativeId);
  const readIds = useReadChapters(source, nativeId);
  const readSet = useMemo(() => new Set(readIds), [readIds]);

  const load = useCallback(async (force = false) => {
    if (!decoded) return;
    const seq = ++loadSeq.current;
    const current = () => loadSeq.current === seq;
    setError(false);
    setLoading(true);
    // Stale-while-revalidate: the persisted merged detail paints instantly,
    // then the network pass repaints with the anchor source's chapters and
    // finally with the cross-source union (onUpdate).
    let hadCache = false;
    try {
      const cached = await readCachedMergedDetail(decoded.source, decoded.id);
      if (cached && current()) {
        hadCache = true;
        setDetail(cached);
        setLoading(false);
      }
    } catch {}
    try {
      const merged = await fetchMergedDetail(decoded.source, decoded.id, {
        force,
        onUpdate: (next) => { if (current()) setDetail(next); },
      });
      if (current()) { setDetail(merged); setError(false); }
    } catch {
      if (current() && !hadCache) setError(true);
    } finally {
      if (current()) setLoading(false);
    }
  }, [decoded]);

  useEffect(() => {
    setDetail(null);
    setChapterQuery("");
    setUnreadOnly(false);
    setVisible(CHAPTER_PAGE);
    void load();
    return () => { loadSeq.current++; };
  }, [load]);

  const ordered = useMemo(() => {
    if (!detail) return [];
    const query = normFuzzy(chapterQuery);
    const number = chapterNumberKey(chapterQuery);
    const chapters = detail.chapters.filter((chapter) =>
      (!unreadOnly || !readSet.has(mangaChapterReadKey(chapter.source, chapter.id))) &&
      (!chapterQuery.trim() || (number && chapterNumberKey(chapter.number).includes(number)) || (query && normFuzzy(chapter.title ?? "").includes(query))));
    return newestFirst ? chapters : [...chapters].reverse();
  }, [detail, newestFirst, chapterQuery, unreadOnly, readSet]);

  useEffect(() => { setVisible(CHAPTER_PAGE); }, [chapterQuery, unreadOnly, newestFirst]);

  const completedChapters = useMemo(() => {
    if (!detail) return 0;
    let count = 0;
    for (const chapter of detail.chapters) if (readSet.has(mangaChapterReadKey(chapter.source, chapter.id))) count += 1;
    return count;
  }, [detail, readSet]);
  const totalChapters = detail?.chapters.length ?? 0;
  const readPercent = totalChapters > 0 ? Math.round((completedChapters / totalChapters) * 100) : 0;

  const openChapter = useCallback((chapter: MergedChapter) => {
    if (!detail) return;
    navigate(mangaReaderPath({
      source: detail.source,
      mangaId: detail.id,
      mangaTitle: detail.title,
      chapter: { source: chapter.source, mangaId: chapter.mangaId, id: chapter.id, number: chapter.number },
      cover: detail.cover,
    }));
  }, [detail, navigate]);

  const onPrimary = useCallback(() => {
    if (!detail || detail.chapters.length === 0) return;
    if (progress?.chapterId) {
      // The saved chapter may now be served by another source; resolve it by
      // native id + owning source, then by chapter number.
      const chapterSource = progress.chapterSource ?? detail.source;
      const match =
        detail.chapters.find((c) => c.id === progress.chapterId && c.source === chapterSource) ??
        (progress.chapterNumber ? detail.chapters.find((c) => c.number === progress.chapterNumber) : undefined);
      if (match) { openChapter(match); return; }
    }
    openChapter(detail.chapters[detail.chapters.length - 1]);
  }, [detail, progress, openChapter]);

  if (!decoded) {
    return (
      <MangaPage>
        <MangaState icon={ICONS.alert} variant="error" title={t.mangaLoadError} message={t.mangaLoadErrorSub}
          primary={{ label: t.back, onClick: () => navigate(-1), icon: ICONS.back }} />
      </MangaPage>
    );
  }

  const title = detail?.title ?? titleParam;
  const coverUrl = upgradeMangaCover(detail?.cover ?? coverParam) ?? "";
  const canRead = !!detail && detail.chapters.length > 0;
  const primaryLabel = progress ? `${t.mangaContinue} • الفصل ${progress.chapterNumber}` : t.mangaStartReading;

  return (
    <MangaPage>
      <div className="mx-auto max-w-[1400px]">
        <div className="mb-6 flex items-center gap-3">
          <button type="button" onClick={() => navigate(-1)} aria-label={t.back}
            className="flex h-11 w-11 items-center justify-center rounded border border-m-line bg-m-sheet text-m-ink hover:border-m-ink">
            <MIcon d={ICONS.back} />
          </button>
          <span className="font-mono text-xs font-bold tracking-[0.18em] text-m-muted" dir="ltr">MANGA / STORY</span>
          <span className="text-sm font-bold text-m-muted">دليل العمل</span>
        </div>

        <div className="grid gap-10 lg:grid-cols-[320px_1fr]">
          {/* ── side: cover + actions ── */}
          <aside className="lg:sticky lg:top-6 lg:self-start">
            {loading && !detail && !titleParam ? (
              <MangaSkeleton className="aspect-[2/3] w-full max-w-[320px]" />
            ) : (
              <MangaCover uri={coverUrl} label={title} displayWidth={320} className="aspect-[2/3] w-full max-w-[320px] border border-m-line shadow-md" />
            )}
            <div className="mt-5 flex gap-2">
              <button type="button" onClick={onPrimary} disabled={!canRead}
                className="flex h-12 flex-1 items-center justify-center gap-2 rounded bg-m-accent px-4 text-sm font-bold text-m-sheet transition-opacity hover:opacity-90 disabled:opacity-40">
                <MIcon d={ICONS.book} size={17} />{primaryLabel}
              </button>
              <button type="button" onClick={() => { if (detail) void toggleMangaLibrary(detail); }} disabled={!detail}
                aria-pressed={!!saved} aria-label={saved ? "إزالة من المكتبة" : "حفظ في المكتبة"}
                className={`flex h-12 items-center gap-1.5 rounded border px-4 text-sm font-bold transition-colors disabled:opacity-40 ${saved ? "border-m-read bg-m-read-wash text-m-read" : "border-m-line bg-m-sheet text-m-ink hover:border-m-ink"}`}>
                <MIcon d={ICONS.bookmark} size={18} />{saved ? "محفوظ" : "حفظ"}
              </button>
            </div>
            {detail && (
              <div className="mt-5 grid grid-cols-3 divide-x divide-x-reverse divide-m-line rounded border border-m-line bg-m-sheet text-center">
                <Stat value={totalChapters} label="فصل متاح" />
                <Stat value={completedChapters} label="فصل مقروء" />
                <Stat value={`${readPercent}%`} label="من القصة" tone="text-m-read" />
              </div>
            )}
          </aside>

          {/* ── main: meta + chapters ── */}
          <main className="min-w-0">
            <h1 className="text-[32px] font-bold leading-snug">{title || <MangaSkeleton className="h-9 w-2/3" />}</h1>
            {detail?.author && <div className="mt-1 text-sm font-semibold text-m-muted">{t.mangaAuthor}: {detail.author}</div>}
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm font-semibold text-m-muted">
              {detail?.type && <span className="text-m-accent">{detail.type}</span>}
              {detail?.status && <span>{detail.status}</span>}
              {detail?.year && <span dir="ltr">{detail.year}</span>}
              {detail?.rating && <span className="flex items-center gap-1 text-m-rating"><MIcon d={ICONS.star} size={13} />{detail.rating}</span>}
            </div>
            {detail && detail.genres.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-2">
                {detail.genres.slice(0, 12).map((genre) => (
                  <span key={genre} className="rounded border border-m-line bg-m-sheet px-3 py-1 text-xs font-bold text-m-ink">{genre}</span>
                ))}
              </div>
            )}
            {detail?.synopsis && (
              <section className="mt-6">
                <h2 className="mb-2 text-sm font-bold text-m-muted">{t.mangaSynopsis}</h2>
                <p className={`whitespace-pre-line text-[15px] leading-8 text-m-ink ${synopsisOpen ? "" : "line-clamp-4"}`}>{detail.synopsis}</p>
                {detail.synopsis.length > 220 && (
                  <button type="button" onClick={() => setSynopsisOpen((v) => !v)} className="mt-1 text-sm font-bold text-m-accent hover:underline">
                    {synopsisOpen ? t.mangaShowLess : t.mangaShowMore}
                  </button>
                )}
              </section>
            )}

            <div className="my-7 border-t border-m-line" />

            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="text-xl font-bold">{t.mangaChapters}{detail && <span className="text-m-muted"> ({detail.chapters.length})</span>}</h2>
                {progress?.chapterNumber && <div className="mt-0.5 text-xs font-semibold text-m-accent">{t.mangaContinueReading} · الفصل {progress.chapterNumber}</div>}
              </div>
              <button type="button" onClick={() => setNewestFirst((v) => !v)}
                className="flex items-center gap-1.5 rounded border border-m-line bg-m-sheet px-3 py-2 text-xs font-bold text-m-muted hover:text-m-ink">
                <MIcon d={ICONS.swap} size={14} />{newestFirst ? t.mangaSortNewest : t.mangaSortOldest}
              </button>
            </div>

            {completedChapters > 0 && (
              <div className="mt-4 flex items-center gap-3">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-m-wash"><div className="h-full bg-m-read" style={{ width: `${readPercent}%` }} /></div>
                <span className="text-xs font-bold text-m-muted">{t.mangaRead} {completedChapters} / {totalChapters}</span>
              </div>
            )}

            {detail && detail.chapters.length > 0 && (
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <label className="flex h-11 min-w-[240px] flex-1 items-center gap-2 rounded border border-m-line bg-m-sheet px-3 focus-within:border-m-ink">
                  <MIcon d={ICONS.search} size={18} className="text-m-muted" />
                  <input value={chapterQuery} onChange={(e) => setChapterQuery(e.target.value)} placeholder={t.mangaChapterFilter} aria-label={t.mangaChapterFilter}
                    className="h-full flex-1 bg-transparent text-sm outline-none placeholder:text-m-muted" />
                  {chapterQuery && <button type="button" onClick={() => setChapterQuery("")} aria-label={t.cancel} className="text-m-muted hover:text-m-ink"><MIcon d={ICONS.close} size={18} /></button>}
                </label>
                <div className="flex gap-2">
                  {[{ label: "كل الفصول", value: false }, { label: "لم أقرأها", value: true }].map((tab) => (
                    <button key={tab.label} type="button" onClick={() => setUnreadOnly(tab.value)} aria-pressed={unreadOnly === tab.value}
                      className={`h-11 rounded border px-4 text-sm font-bold ${unreadOnly === tab.value ? "border-m-accent bg-m-accent-wash text-m-accent" : "border-m-line bg-m-sheet text-m-muted hover:text-m-ink"}`}>
                      {tab.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-4 grid gap-2 xl:grid-cols-2">
              {ordered.slice(0, visible).map((chapter) => {
                const read = readSet.has(mangaChapterReadKey(chapter.source, chapter.id));
                return (
                  <ChapterRow key={`${chapter.source}:${chapter.id}`} number={chapter.number} title={chapter.title} date={chapter.date} read={read}
                    active={progress?.chapterId === chapter.id && (progress.chapterSource ?? source) === chapter.source}
                    onClick={() => openChapter(chapter)}
                    onToggleRead={() => void setMangaChapterRead(source, nativeId, mangaChapterReadKey(chapter.source, chapter.id), !read)} />
                );
              })}
            </div>
            {ordered.length > visible && (
              <div className="flex justify-center py-6">
                <button type="button" onClick={() => setVisible((v) => v + CHAPTER_PAGE * 2)}
                  className="h-11 rounded border border-m-accent px-6 text-sm font-bold text-m-accent hover:bg-m-accent-wash">
                  {t.mangaLoadMore} ({ordered.length - visible})
                </button>
              </div>
            )}

            {ordered.length === 0 && (
              loading ? (
                <div className="mt-4 grid gap-2 xl:grid-cols-2">{[0, 1, 2, 3, 4, 5].map((i) => <MangaSkeleton key={i} className="h-[72px] w-full" />)}</div>
              ) : error ? (
                <MangaState icon={ICONS.offline} variant="error" title={t.mangaLoadError} message={t.mangaLoadErrorSub}
                  primary={{ label: t.retry, onClick: () => void load(true), icon: ICONS.refresh }} />
              ) : (
                <p className="py-10 text-center text-sm font-semibold text-m-muted">{chapterQuery || unreadOnly ? "لا توجد فصول مطابقة" : t.mangaNoChapters}</p>
              )
            )}
          </main>
        </div>
      </div>
    </MangaPage>
  );
}

function Stat({ value, label, tone = "text-m-ink" }: { value: number | string; label: string; tone?: string }) {
  return (
    <div className="px-2 py-3">
      <div className={`font-mono text-xl font-bold ${tone}`} dir="ltr">{value}</div>
      <div className="text-[11px] font-semibold text-m-muted">{label}</div>
    </div>
  );
}
