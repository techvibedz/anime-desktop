// Manga hub — one combined feed for every source (mobile app/(tabs)/manga.tsx
// parity). No source tabs and no source names anywhere: home rails, search and
// genre browse all fan out to every source and merge by normalized title, so a
// work appears once with the best cover/metadata, and the reader later pulls
// each chapter from the highest-resolution source that has it.
//
// Search state lives in the URL (?search=1&q=…&g=…&type=…&status=…&sort=…) so
// opening a work and coming back restores the exact results.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { t } from "../../lib/i18n";
import {
  browseMergedAll,
  browseMergedGenre,
  fetchMergedHome,
  filterMangaCards,
  mergeCards,
  readCachedMergedHome,
  searchMergedManga,
  type MangaFilters,
  type MangaStatusFilter,
  type MangaTypeFilter,
} from "../../lib/manga/aggregate";
import { MANGA_GENRES } from "../../lib/manga/genres";
import { normFuzzy } from "../../lib/fuzzy";
import { removeMangaProgress, useContinueReading, type MangaProgress } from "../../lib/manga/store";
import { mangaPosterUrl, upgradeMangaCover } from "../../lib/manga/cover";
import { MANGA_LIBRARY_PATH, mangaDetailPath, mangaReaderPath } from "../../lib/manga/nav";
import type { MangaCard, MangaHome, MangaSort } from "../../lib/manga/types";
import { useCardLayout, type CardLayout } from "../../lib/cardLayout";
import { CardLayoutControl } from "../../components/CardLayoutControl";
import { ChoiceChip, ICONS, MangaCardTile, MangaCover, MangaPage, MangaSkeleton, MangaState, MIcon } from "../../components/manga/MangaUI";

const MAX_GENRES = 3;
const RAIL_W = 168;
const TYPES = ["مانجا", "مانهوا", "مانها"] as const;
const STATUSES = ["مستمر", "مكتمل", "معلق"] as const;

export const MANGA_GRID: Record<CardLayout, string> = {
  comfortable: "grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6",
  compact: "grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-7 xl:grid-cols-8",
  list: "grid grid-cols-1 gap-x-8 lg:grid-cols-2",
};

function readFilters(params: URLSearchParams): { filters: MangaFilters; genres: string[] } {
  const type = params.get("type");
  const status = params.get("status");
  const sort = params.get("sort");
  return {
    filters: {
      type: (TYPES as readonly string[]).includes(type ?? "") ? (type as MangaTypeFilter) : null,
      status: (STATUSES as readonly string[]).includes(status ?? "") ? (status as MangaStatusFilter) : null,
      sort: sort === "latest" || sort === "title" ? (sort as MangaSort) : "default",
    },
    genres: (params.get("g") ?? "").split(",").filter((g) => MANGA_GENRES.some((x) => x.label === g)).slice(0, MAX_GENRES),
  };
}

export function MangaHubPage() {
  const [params, setParams] = useSearchParams();
  const searchOpen = params.get("search") === "1";
  const query = params.get("q") ?? "";
  const { filters, genres } = useMemo(() => readFilters(params), [params]);
  const filtersKey = JSON.stringify([filters, genres]);

  const patchParams = useCallback((patch: Record<string, string | null>, replace = true) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [key, value] of Object.entries(patch)) {
        if (value == null || value === "") next.delete(key);
        else next.set(key, value);
      }
      return next;
    }, { replace });
  }, [setParams]);

  const openSearch = useCallback((genre?: string) => {
    patchParams({ search: "1", g: genre ?? null }, false);
  }, [patchParams]);

  // ── home ──
  const [home, setHome] = useState<MangaHome | null>(null);
  const homeRef = useRef<MangaHome | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const continueReading = useContinueReading(10);

  const loadHome = useCallback(async (force: boolean) => {
    if (!force && homeRef.current) return;
    // Stale-while-revalidate: the merged disk caches paint the first frame,
    // then the network pass replaces them (progressively, source by source).
    if (!force && !homeRef.current) {
      const cached = await readCachedMergedHome();
      if (cached) {
        homeRef.current = cached;
        setHome(cached);
      }
    }
    setError(false);
    setRefreshing(force);
    setLoading(!homeRef.current);
    try {
      const merged = await fetchMergedHome({
        force,
        onPartial: (partial) => {
          homeRef.current = partial;
          setHome(partial);
        },
      });
      homeRef.current = merged;
      setHome(merged);
    } catch {
      if (!homeRef.current) setError(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void loadHome(false); }, [loadHome]);

  // ── search ──
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [results, setResults] = useState<MangaCard[]>([]);
  const [canLoadMore, setCanLoadMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [browsePage, setBrowsePage] = useState(1);
  const [draft, setDraft] = useState(query);
  const searchSeqRef = useRef(0);
  const rawResultsRef = useRef<MangaCard[]>([]);
  const pagingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setDraft(query); }, [query]);
  // Typing updates the URL after a short pause so history isn't spammed.
  useEffect(() => {
    if (draft === query) return;
    const timer = setTimeout(() => patchParams({ q: draft || null }), 350);
    return () => clearTimeout(timer);
  }, [draft, query, patchParams]);

  const runSearch = useCallback(async (q: string, selectedGenres: string[], active: MangaFilters, page = 1) => {
    const seq = page === 1 ? ++searchSeqRef.current : searchSeqRef.current;
    const trimmed = q.trim();
    if (page === 1) {
      rawResultsRef.current = [];
      setResults([]);
      setBrowsePage(1);
      setCanLoadMore(false);
      setSearching(true);
      setSearched(true);
    }
    const options = { ...active, genres: selectedGenres, page };
    const emit = (cards: MangaCard[]) => {
      if (seq !== searchSeqRef.current) return;
      // Search streams are cumulative and ranked; keep their latest ordering.
      rawResultsRef.current = trimmed && page === 1 ? cards : mergeCards([...rawResultsRef.current, ...cards]);
      setResults(rawResultsRef.current);
    };
    try {
      const batches = trimmed
        ? [await searchMergedManga(trimmed, options, emit)]
        : selectedGenres.length
          ? await Promise.all(selectedGenres.map((genre) => browseMergedGenre(genre, page, options, emit)))
          : [await browseMergedAll(page, options, emit)];
      if (seq !== searchSeqRef.current) return;
      const incoming = mergeCards(batches.flat());
      emit(incoming);
      setBrowsePage(page);
      setCanLoadMore(incoming.length > 0);
    } finally {
      if (seq === searchSeqRef.current) {
        setSearching(false);
        setLoadingMore(false);
        pagingRef.current = false;
      }
    }
  }, []);

  useEffect(() => {
    if (!searchOpen) return;
    searchSeqRef.current++;
    pagingRef.current = false;
    setLoadingMore(false);
    setSearching(true);
    void runSearch(query, genres, filters);
    return () => { searchSeqRef.current++; };
    // filtersKey covers filters + genres
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, filtersKey, searchOpen, runSearch]);

  useEffect(() => { if (searchOpen) inputRef.current?.focus(); }, [searchOpen]);

  const loadMore = useCallback(async () => {
    if (pagingRef.current || searching) return;
    pagingRef.current = true;
    setLoadingMore(true);
    await runSearch(query, genres, filters, browsePage + 1);
  }, [query, genres, filters, browsePage, searching, runSearch]);

  const shown = useMemo(() => filterMangaCards(results, filters), [results, filters]);
  const metrics = useCardLayout("manga-search");

  // ── filter sheet ──
  const [filterOpen, setFilterOpen] = useState(false);
  const [draftFilters, setDraftFilters] = useState<MangaFilters>(filters);
  const [draftGenres, setDraftGenres] = useState<string[]>(genres);
  const [genreQuery, setGenreQuery] = useState("");
  const matchingGenres = useMemo(() => MANGA_GENRES.filter((genre) =>
    normFuzzy([genre.label, genre.asq, genre.mangalik, genre.mangawy].filter(Boolean).join(" ")).includes(normFuzzy(genreQuery))), [genreQuery]);

  const openFilters = () => {
    setGenreQuery("");
    setDraftFilters(filters);
    setDraftGenres(genres);
    setFilterOpen(true);
  };
  const applyFilters = () => {
    patchParams({
      type: draftFilters.type,
      status: draftFilters.status,
      sort: draftFilters.sort === "default" ? null : draftFilters.sort,
      g: draftGenres.join(",") || null,
    });
    setFilterOpen(false);
  };
  const toggleDraftGenre = (label: string) => setDraftGenres((prev) =>
    prev.includes(label) ? prev.filter((g) => g !== label) : prev.length >= MAX_GENRES ? prev : [...prev, label]);

  const activeFilterCount = (filters.type ? 1 : 0) + (filters.status ? 1 : 0) + (filters.sort !== "default" ? 1 : 0) + genres.length;

  const removeContinue = useCallback((item: MangaProgress) => {
    if (window.confirm(`${t.mangaRemoveContinueConfirm}\n${item.title}`)) void removeMangaProgress(item.source, item.id);
  }, []);

  useEffect(() => {
    if (!filterOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFilterOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filterOpen]);

  const footer = canLoadMore ? (
    <div className="flex justify-center py-8">
      <button type="button" onClick={() => void loadMore()} disabled={loadingMore || searching}
        className="flex min-h-[48px] min-w-[180px] items-center justify-center rounded border border-m-accent px-6 text-sm font-bold text-m-accent transition-colors hover:bg-m-accent-wash disabled:opacity-60">
        {loadingMore ? <span className="h-5 w-5 animate-spin rounded-full border-2 border-m-accent border-t-transparent" /> : t.mangaLoadMore}
      </button>
    </div>
  ) : null;

  return (
    <MangaPage>
      {searchOpen ? (
        <div className="mx-auto max-w-[1500px]">
          <div className="mb-5 flex items-center gap-3">
            <button type="button" onClick={() => patchParams({ search: null, q: null, g: null, type: null, status: null, sort: null }, false)}
              aria-label={t.back} className="flex h-11 w-11 items-center justify-center rounded border border-m-line bg-m-sheet text-m-ink hover:border-m-ink">
              <MIcon d={ICONS.back} />
            </button>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-bold tracking-[0.18em] text-m-muted" dir="ltr">PANTOUFA / MANGA</div>
              <h1 className="text-2xl font-bold">اكتشف قصتك التالية</h1>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <label className="flex h-12 flex-1 items-center gap-3 rounded border border-m-line bg-m-sheet px-4 focus-within:border-m-ink">
              <MIcon d={ICONS.search} className="text-m-muted" />
              <input ref={inputRef} value={draft} onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") patchParams({ q: draft || null }); }}
                placeholder={t.mangaSearchPlaceholder} aria-label={t.mangaSearchPlaceholder}
                className="h-full flex-1 bg-transparent text-base text-m-ink outline-none placeholder:text-m-muted" />
              {draft && <button type="button" onClick={() => { setDraft(""); patchParams({ q: null }); }} aria-label="مسح البحث" className="text-m-muted hover:text-m-ink"><MIcon d={ICONS.close} /></button>}
            </label>
            <button type="button" onClick={openFilters} aria-label={t.mangaFilter}
              className={`relative flex h-12 items-center gap-2 rounded border px-4 text-sm font-bold transition-colors ${activeFilterCount ? "border-m-accent bg-m-accent-wash text-m-accent" : "border-m-line bg-m-sheet text-m-ink hover:border-m-ink"}`}>
              <MIcon d={ICONS.filter} />{t.mangaFilter}
              {activeFilterCount > 0 && <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-m-accent px-1.5 text-[11px] text-m-sheet">{activeFilterCount}</span>}
            </button>
            <CardLayoutControl layout={metrics.layout} onChange={metrics.setLayout} />
          </div>

          {activeFilterCount > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {filters.type && <FilterPill label={filters.type} onRemove={() => patchParams({ type: null })} />}
              {filters.status && <FilterPill label={filters.status} onRemove={() => patchParams({ status: null })} />}
              {filters.sort !== "default" && <FilterPill label={filters.sort === "latest" ? t.mangaSortNewest : t.mangaSortTitle} onRemove={() => patchParams({ sort: null })} />}
              {genres.map((genre) => <FilterPill key={genre} label={genre} onRemove={() => patchParams({ g: genres.filter((g) => g !== genre).join(",") || null })} />)}
            </div>
          )}

          <div className="mb-4 mt-5 flex items-center gap-3 text-sm font-semibold text-m-muted">
            {searching && <span className="h-4 w-4 animate-spin rounded-full border-2 border-m-accent border-t-transparent" />}
            {searching ? t.loading : `${shown.length} نتيجة`}
          </div>

          {shown.length > 0 ? (
            <>
              <div className={MANGA_GRID[metrics.layout]}>
                {shown.map((card) => <MangaCardTile key={`${card.source}:${card.id}`} card={card} layout={metrics.layout} />)}
              </div>
              {footer}
            </>
          ) : searching ? (
            <GridSkeleton />
          ) : searched ? (
            <>
              <MangaState icon={ICONS.search} title={t.mangaNoResults} message={t.mangaNoResultsSub}
                primary={{ label: t.mangaFilter, onClick: openFilters, icon: ICONS.filter }} />
              {footer}
            </>
          ) : (
            <MangaState icon={ICONS.book} title={t.mangaSearchHint} message={t.mangaSearchHintSub} />
          )}
        </div>
      ) : (
        <div className="mx-auto max-w-[1500px]">
          <header className="flex items-start justify-between gap-6">
            <div>
              <div className="text-xs font-bold tracking-[0.18em] text-m-muted" dir="ltr">PANTOUFA / MANGA</div>
              <div className="mt-1 flex items-center gap-3">
                <h1 className="text-[34px] font-bold leading-tight">عالم المانجا</h1>
                <span className="rounded border border-m-accent px-2 py-0.5 text-xs font-bold text-m-accent">{t.mangaBeta}</span>
              </div>
              <p className="mt-1 text-sm font-medium text-m-muted">قصص تستحق أن تقلب صفحاتها.</p>
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => void loadHome(true)} disabled={refreshing} aria-label={t.refresh}
                className="flex h-11 w-11 items-center justify-center rounded border border-m-line bg-m-sheet text-m-ink hover:border-m-ink disabled:opacity-60">
                <MIcon d={ICONS.refresh} size={18} className={refreshing ? "animate-spin" : ""} />
              </button>
              <Link to={MANGA_LIBRARY_PATH} className="flex h-11 items-center gap-2 rounded border border-m-line bg-m-sheet px-4 text-sm font-bold text-m-ink hover:border-m-ink">
                <MIcon d={ICONS.bookmark} size={18} />مكتبتي
              </Link>
            </div>
          </header>

          <button type="button" onClick={() => openSearch()}
            className="mt-6 flex h-14 w-full items-center gap-3 rounded border border-m-line bg-m-sheet px-5 text-start text-m-muted transition-colors hover:border-m-ink">
            <MIcon d={ICONS.search} />
            <span className="flex-1 text-base">{t.mangaSearchPlaceholder}</span>
            <MIcon d={ICONS.filter} className="text-m-accent" />
          </button>
          <div className="mt-3 flex flex-wrap gap-2">
            {MANGA_GENRES.slice(0, 10).map((genre) => <ChoiceChip key={genre.label} label={genre.label} active={false} onClick={() => openSearch(genre.label)} />)}
          </div>

          {continueReading.length > 0 && (
            <section className="mt-9">
              <SectionHeader title={t.mangaContinueReading} />
              <Rail>
                {continueReading.map((item) => <ContinueCard key={`${item.source}:${item.id}`} item={item} onRemove={removeContinue} />)}
              </Rail>
            </section>
          )}

          {loading && !home ? (
            <HubSkeleton />
          ) : error && !home ? (
            <MangaState icon={ICONS.offline} variant="error" title={t.mangaLoadError} message={t.mangaLoadErrorSub}
              primary={{ label: t.retry, onClick: () => void loadHome(true), icon: ICONS.refresh }} />
          ) : home ? (
            <>
              {home.featured[0] && <HeroBanner card={home.featured[0]} />}
              {home.sections.map((section, i) => (
                <section key={section.id} className="mt-9">
                  <SectionHeader title={section.title} index={i + 1} />
                  <Rail>
                    {section.items.map((item, index) => (
                      <MangaCardTile key={`${section.id}:${item.source}:${item.id}`} card={item} width={RAIL_W}
                        subtitle={section.kind === "latest" ? item.latest || item.type || undefined : undefined}
                        rank={section.kind === "ranked" ? index + 1 : undefined} />
                    ))}
                  </Rail>
                </section>
              ))}
            </>
          ) : null}
        </div>
      )}

      {filterOpen && (
        <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/50 p-6" onClick={() => setFilterOpen(false)}>
          <div dir="rtl" role="dialog" aria-modal="true" aria-label={t.mangaFiltersTitle} onClick={(e) => e.stopPropagation()}
            className="flex max-h-[86vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-m-line bg-m-paper text-m-ink shadow-2xl">
            <div className="flex items-center justify-between border-b border-m-line px-6 py-4">
              <h2 className="text-lg font-bold">{t.mangaFiltersTitle}</h2>
              <button type="button" onClick={() => setFilterOpen(false)} aria-label={t.cancel} className="text-m-muted hover:text-m-ink"><MIcon d={ICONS.close} /></button>
            </div>
            <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
              <FilterBlock label={t.mangaFilterType}>
                <ChoiceChip label={t.mangaFilterAll} active={draftFilters.type === null} onClick={() => setDraftFilters((p) => ({ ...p, type: null }))} />
                {TYPES.map((type) => <ChoiceChip key={type} label={type} active={draftFilters.type === type} onClick={() => setDraftFilters((p) => ({ ...p, type }))} />)}
              </FilterBlock>
              <FilterBlock label={t.mangaFilterStatus}>
                <ChoiceChip label={t.mangaFilterAll} active={draftFilters.status === null} onClick={() => setDraftFilters((p) => ({ ...p, status: null }))} />
                {STATUSES.map((status) => <ChoiceChip key={status} label={status} active={draftFilters.status === status} onClick={() => setDraftFilters((p) => ({ ...p, status }))} />)}
              </FilterBlock>
              <FilterBlock label={t.mangaFilterSort}>
                <ChoiceChip label={t.mangaSortDefault} active={draftFilters.sort === "default"} onClick={() => setDraftFilters((p) => ({ ...p, sort: "default" }))} />
                <ChoiceChip label={t.mangaSortNewest} active={draftFilters.sort === "latest"} onClick={() => setDraftFilters((p) => ({ ...p, sort: "latest" }))} />
                <ChoiceChip label={t.mangaSortTitle} active={draftFilters.sort === "title"} onClick={() => setDraftFilters((p) => ({ ...p, sort: "title" }))} />
              </FilterBlock>
              <div>
                <div className="mb-2.5 text-sm font-bold text-m-muted">{`${t.mangaFilterGenres} · ${draftGenres.length} / ${MAX_GENRES}`}</div>
                <label className="mb-3 flex h-11 items-center gap-2 rounded border border-m-line bg-m-sheet px-3 focus-within:border-m-ink">
                  <MIcon d={ICONS.search} size={18} className="text-m-muted" />
                  <input value={genreQuery} onChange={(e) => setGenreQuery(e.target.value)} placeholder="ابحث عن تصنيف…" aria-label="البحث في التصنيفات"
                    className="h-full flex-1 bg-transparent text-sm outline-none placeholder:text-m-muted" />
                </label>
                <div className="flex flex-wrap gap-2">
                  {matchingGenres.map((genre) => (
                    <ChoiceChip key={genre.label} label={genre.label} active={draftGenres.includes(genre.label)}
                      disabled={draftGenres.length >= MAX_GENRES && !draftGenres.includes(genre.label)}
                      onClick={() => toggleDraftGenre(genre.label)} />
                  ))}
                </div>
                {matchingGenres.length === 0 && <p className="mt-2 text-xs text-m-muted">لا توجد تصنيفات مطابقة</p>}
                <p className="mt-2 text-xs text-m-muted">النتائج تطابق أحد التصنيفات المختارة</p>
                {draftGenres.length >= MAX_GENRES && <p className="mt-1 text-xs font-semibold text-m-accent">{t.mangaFilterGenreLimit}</p>}
              </div>
            </div>
            <div className="flex gap-3 border-t border-m-line px-6 py-4">
              <button type="button" onClick={applyFilters} className="h-12 flex-1 rounded bg-m-accent text-sm font-bold text-m-sheet hover:opacity-90">{t.mangaApply}</button>
              <button type="button" onClick={() => { setDraftFilters({ type: null, status: null, sort: "default" }); setDraftGenres([]); }}
                className="h-12 rounded border border-m-line px-6 text-sm font-bold text-m-ink hover:border-m-ink">{t.mangaClearFilters}</button>
            </div>
          </div>
        </div>
      )}
    </MangaPage>
  );
}

// ── pieces ───────────────────────────────────────────────────────────────────

function SectionHeader({ title, index }: { title: string; index?: number }) {
  return (
    <div className="mb-4 flex items-center gap-3 border-b border-m-line pb-2.5">
      {index != null
        ? <span className="font-mono text-sm font-bold text-m-accent" dir="ltr">{String(index).padStart(2, "0")}</span>
        : <MIcon d={ICONS.bookmark} size={18} className="text-m-accent" />}
      <h2 className="text-xl font-bold">{title}</h2>
    </div>
  );
}

function Rail({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // RTL scroller: "next" moves toward the end (left), scrollLeft is negative.
  const scrollBy = (dir: 1 | -1) => ref.current?.scrollBy({ left: -dir * ref.current.clientWidth * 0.8, behavior: "smooth" });
  return (
    <div className="group/rail relative">
      <div ref={ref} className="flex gap-4 overflow-x-auto pb-3 [scrollbar-width:thin]">{children}</div>
      <button type="button" aria-label="السابق" onClick={() => scrollBy(-1)}
        className="absolute -start-4 top-[40%] z-rail hidden h-10 w-10 items-center justify-center rounded-full border border-m-line bg-m-sheet text-m-ink shadow-md group-hover/rail:flex">
        <MIcon d={ICONS.back} />
      </button>
      <button type="button" aria-label="التالي" onClick={() => scrollBy(1)}
        className="absolute -end-4 top-[40%] z-rail hidden h-10 w-10 items-center justify-center rounded-full border border-m-line bg-m-sheet text-m-ink shadow-md group-hover/rail:flex">
        <MIcon d={ICONS.forward} />
      </button>
    </div>
  );
}

function HeroBanner({ card }: { card: MangaCard }) {
  const cover = upgradeMangaCover(card.cover);
  return (
    <Link to={mangaDetailPath(card)} className="relative mt-9 flex min-h-[260px] items-center gap-8 overflow-hidden rounded-lg bg-m-ink p-8 transition-opacity hover:opacity-95">
      {cover && <img src={mangaPosterUrl(cover, 160) ?? cover} alt="" aria-hidden className="absolute inset-0 h-full w-full scale-110 object-cover opacity-60 blur-2xl" />}
      <div className="absolute inset-0 bg-gradient-to-l from-[rgba(34,35,31,0.25)] to-[rgba(34,35,31,0.9)]" />
      <MangaCover uri={cover} alts={card.coverAlts?.map(upgradeMangaCover)} label={card.title} displayWidth={180}
        className="relative aspect-[2/3] w-[150px] shrink-0 border border-white/20 shadow-xl" />
      <div className="relative min-w-0 flex-1 text-m-sheet">
        <div className="text-xs font-bold text-m-night-accent">على رفّ الاختيارات</div>
        <div className="mt-2 flex gap-2">
          {card.type && <span className="rounded border border-white/30 px-2 py-0.5 text-xs font-bold">{card.type}</span>}
          {card.status && <span className="rounded border border-white/30 px-2 py-0.5 text-xs font-bold">{card.status}</span>}
        </div>
        <h2 className="mt-3 line-clamp-3 text-3xl font-bold leading-snug">{card.title}</h2>
        {card.latest && <div className="mt-1 text-sm text-m-night-muted">{card.latest}</div>}
        <div className="mt-5 inline-flex items-center gap-2 rounded bg-m-accent px-5 py-2.5 text-sm font-bold">اكتشف العمل<MIcon d={ICONS.arrowLeft} size={18} /></div>
      </div>
    </Link>
  );
}

function ContinueCard({ item, onRemove }: { item: MangaProgress; onRemove: (item: MangaProgress) => void }) {
  const navigate = useNavigate();
  const progress = item.total > 0 ? Math.min(1, (item.page + 1) / item.total) : 0;
  // Progress pulled from the account has a chapter number but no native id —
  // the detail page resolves it ("متابعة" there opens the right chapter).
  const open = () => navigate(!item.chapterId ? mangaDetailPath({ source: item.source, id: item.id, title: item.title, cover: item.cover }) : mangaReaderPath({
    source: item.source,
    mangaId: item.id,
    mangaTitle: item.title,
    chapter: {
      source: item.chapterSource ?? item.source,
      mangaId: item.chapterMangaId ?? item.id,
      id: item.chapterId,
      number: item.chapterNumber,
    },
    cover: item.cover,
  }));
  return (
    <div className="relative w-[320px] shrink-0">
      <button type="button" onClick={open} onContextMenu={(e) => { e.preventDefault(); onRemove(item); }}
        className="flex w-full items-center gap-4 rounded border border-m-line bg-m-sheet p-3 text-start transition-colors hover:border-m-ink"
        aria-label={`${item.title} — الفصل ${item.chapterNumber}`}>
        <MangaCover uri={upgradeMangaCover(item.cover)} label={item.title} displayWidth={72} className="aspect-[2/3] w-[72px] shrink-0" />
        <div className="min-w-0 flex-1 pe-6">
          <div className="line-clamp-2 text-sm font-bold">{item.title}</div>
          <div className="mt-1 text-xs font-semibold text-m-muted">الفصل {item.chapterNumber} · {Math.min(item.page + 1, item.total)} / {item.total}</div>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-m-wash"><div className="h-full bg-m-accent" style={{ width: `${Math.round(progress * 100)}%` }} /></div>
          <div className="mt-2 flex items-center gap-1.5 text-xs font-bold text-m-accent">{t.mangaContinue}<MIcon d={ICONS.arrowLeft} size={14} /></div>
        </div>
      </button>
      <button type="button" onClick={() => onRemove(item)} aria-label={t.remove}
        className="absolute end-2 top-2 flex h-7 w-7 items-center justify-center rounded-full text-m-muted hover:bg-m-wash hover:text-m-ink">
        <MIcon d={ICONS.close} size={16} />
      </button>
    </div>
  );
}

function FilterPill({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <button type="button" onClick={onRemove} aria-label={`إزالة ${label}`}
      className="flex items-center gap-1.5 rounded-full border border-m-accent bg-m-accent-wash px-3 py-1 text-xs font-bold text-m-accent">
      {label}<MIcon d={ICONS.close} size={13} />
    </button>
  );
}

function FilterBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-2.5 text-sm font-bold text-m-muted">{label}</div>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

function GridSkeleton() {
  return (
    <div className={MANGA_GRID.comfortable}>
      {Array.from({ length: 12 }, (_, i) => (
        <div key={i}><MangaSkeleton className="aspect-[2/3] w-full" /><MangaSkeleton className="mt-2 h-3.5 w-3/4" /></div>
      ))}
    </div>
  );
}

function HubSkeleton() {
  return (
    <div className="mt-9 space-y-8">
      <MangaSkeleton className="h-[260px] w-full rounded-lg" />
      {[0, 1].map((row) => (
        <div key={row}>
          <MangaSkeleton className="mb-4 h-6 w-40" />
          <div className="flex gap-4 overflow-hidden">
            {Array.from({ length: 8 }, (_, i) => <MangaSkeleton key={i} className="aspect-[2/3] w-[168px] shrink-0" />)}
          </div>
        </div>
      ))}
    </div>
  );
}
