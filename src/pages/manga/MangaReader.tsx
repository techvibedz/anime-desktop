// Manga reader — full-window night canvas over the app shell (mobile
// app/manga-reader/[chapter].tsx parity, rebuilt for mouse + keyboard).
//
// Modes: continuous vertical scroll (webtoon), horizontal pages (RTL/LTR) and
// vertical pages. Fit modes mirror mobile (width / screen / height / stretch /
// original / smart); desktop adds a column-width control so "fill width"
// doesn't blow a manga page up to a 2560px monitor. Progress is saved per page,
// the chapter is marked read once its last page has been shown, the next
// chapter is prefetched near the end, and the saved page is restored on reopen.

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { t } from "../../lib/i18n";
import { storage } from "../../lib/storage";
import { normFuzzy } from "../../lib/fuzzy";
import { fetchMangaChapter } from "../../lib/manga/api";
import { chapterNumberKey, fetchMergedDetail } from "../../lib/manga/aggregate";
import { upgradeMangaPage } from "../../lib/manga/cover";
import { decodeReaderRef, type MergedChapter, type MergedMangaDetail } from "../../lib/manga/types";
import {
  flushMangaStore,
  getMangaProgress,
  mangaChapterReadKey,
  markMangaChapterRead,
  saveMangaProgress,
  setMangaChapterRead,
  useReadChapters,
} from "../../lib/manga/store";
import { mangaDetailPath, mangaReaderPath } from "../../lib/manga/nav";
import { ChapterRow, ChoiceChip, ICONS, MangaSkeleton, MangaState, MIcon } from "../../components/manga/MangaUI";

type ReaderMode = "vertical" | "paged" | "pagedV";
type ReaderDirection = "ltr" | "rtl";
type FitMode = "width" | "screen" | "height" | "stretch" | "original" | "smart";

interface ReaderPrefs {
  mode: ReaderMode;
  direction: ReaderDirection;
  fit: FitMode;
  /** Desktop only: reading column width as % of the window (vertical mode). */
  column: number;
  /** Desktop only: gap between pages in vertical mode. */
  gap: boolean;
}

const PREFS_KEY = "manga_reader_prefs_desktop_v1";
const RATIOS_KEY = "manga_page_ratios_v1";
const FIT_MODES: FitMode[] = ["width", "screen", "height", "stretch", "original", "smart"];
const DEFAULT_PREFS: ReaderPrefs = { mode: "vertical", direction: "rtl", fit: "width", column: 55, gap: false };

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function loadPrefs(): ReaderPrefs {
  try {
    const parsed = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") as Partial<ReaderPrefs>;
    return {
      mode: parsed.mode === "paged" ? "paged" : parsed.mode === "pagedV" ? "pagedV" : "vertical",
      direction: parsed.direction === "ltr" ? "ltr" : "rtl",
      fit: FIT_MODES.includes(parsed.fit as FitMode) ? (parsed.fit as FitMode) : "width",
      column: typeof parsed.column === "number" ? clamp(parsed.column, 25, 100) : DEFAULT_PREFS.column,
      gap: parsed.gap === true,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

// ── aspect-ratio cache (persisted) ───────────────────────────────────────────
// Knowing a page's ratio before its bitmap arrives keeps placeholder heights
// correct, which keeps the continuous scroll anchor stable while pages load.
const ratioCache = new Map<string, number>();
let recentRatio = 1.45;
let ratiosLoaded = false;
function loadRatios() {
  if (ratiosLoaded) return;
  ratiosLoaded = true;
  try {
    const parsed = JSON.parse(localStorage.getItem(RATIOS_KEY) || "{}") as Record<string, unknown>;
    for (const [key, value] of Object.entries(parsed)) if (typeof value === "number" && value > 0) ratioCache.set(key, value);
  } catch {}
}
function persistRatios() {
  const out: Record<string, number> = {};
  // Keep the newest entries (Map preserves insertion order).
  const entries = [...ratioCache].slice(-4000);
  for (const [key, value] of entries) out[key] = value;
  void storage.setItem(RATIOS_KEY, JSON.stringify(out));
}
function rememberRatio(uri: string, ratio: number) {
  if (!(ratio > 0) || ratioCache.get(uri) === ratio) return;
  if (ratio > 0.4 && ratio < 16) recentRatio = ratio;
  ratioCache.delete(uri);
  ratioCache.set(uri, ratio);
}

// ── page image with recovery ─────────────────────────────────────────────────

/** Shared recovery for every mode: upgraded URL first, then the original;
 * two automatic retries, then a visible retry button. */
const PageImage = memo(function PageImage({ uri, page, style, className = "", onDisplayed, onRatio }: {
  uri: string; page: number; style?: React.CSSProperties; className?: string;
  onDisplayed: (uri: string) => void; onRatio?: (ratio: number, naturalWidth: number) => void;
}) {
  const [src, setSrc] = useState(() => upgradeMangaPage(uri));
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");

  useEffect(() => {
    setSrc(upgradeMangaPage(uri));
    setAttempt(0);
    setStatus("loading");
  }, [uri]);

  // A download that never finishes must not leave a skeleton forever.
  useEffect(() => {
    if (status !== "loading") return;
    const timer = setTimeout(() => recover(), 25_000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, attempt, status]);

  function recover() {
    if (src !== uri) { setSrc(uri); setAttempt((a) => a + 1); return; }
    if (attempt < 2) { setTimeout(() => setAttempt((a) => a + 1), 800); return; }
    setStatus("error");
  }

  if (status === "error") {
    return (
      <div className={`flex min-h-[320px] w-full flex-col items-center justify-center gap-2 bg-m-night p-6 text-center ${className}`} style={style}>
        <MIcon d={ICONS.offline} size={28} className="text-m-night-accent" />
        <div className="text-base font-bold text-m-sheet">الصفحة {page + 1}</div>
        <div className="text-sm text-m-night-muted">{t.mangaPageError}</div>
        <button type="button" onClick={() => { setAttempt((a) => a + 1); setStatus("loading"); }}
          className="mt-2 flex min-h-[44px] items-center gap-2 rounded bg-m-accent px-5 text-sm font-bold text-m-sheet">
          <MIcon d={ICONS.refresh} size={18} />{t.retry}
        </button>
      </div>
    );
  }

  // Retries bust the HTTP cache entry of the failed attempt.
  const url = attempt > 0 ? `${src}${src.includes("?") ? "&" : "?"}_r=${attempt}` : src;
  return (
    <div className={`relative ${className}`} style={style}>
      {status === "loading" && <MangaSkeleton dark className="absolute inset-0 rounded-none" />}
      <img key={url} src={url} alt={`الصفحة ${page + 1}`} draggable={false} decoding="async"
        className={`relative block h-full w-full select-none transition-opacity duration-150 ${status === "loaded" ? "opacity-100" : "opacity-0"}`}
        style={{ objectFit: "contain" }}
        onLoad={(e) => {
          const img = e.currentTarget;
          if (img.naturalWidth > 0) {
            const ratio = img.naturalHeight / img.naturalWidth;
            rememberRatio(uri, ratio);
            onRatio?.(ratio, img.naturalWidth);
          }
          setStatus("loaded");
          onDisplayed(uri);
        }}
        onError={recover} />
    </div>
  );
});

// ── vertical page (continuous mode) ──────────────────────────────────────────

const VerticalPage = memo(function VerticalPage({ uri, page, fit, columnPx, viewportH, gap, root, onDisplayed }: {
  uri: string; page: number; fit: FitMode; columnPx: number; viewportH: number; gap: boolean;
  root: HTMLDivElement | null; onDisplayed: (uri: string) => void;
}) {
  const [ratio, setRatio] = useState(() => ratioCache.get(uri) ?? recentRatio);
  const [natural, setNatural] = useState(0);
  const [near, setNear] = useState(page < 3);
  const boxRef = useRef<HTMLDivElement>(null);
  const onRatio = useCallback((r: number, w: number) => { setRatio(r); setNatural(w); }, []);
  // Mount the image only once it comes within ~2 screens: a 200-page webtoon
  // must not fire 200 downloads at once, and an off-screen page must not trip
  // the stall watchdog. Once mounted it stays mounted (no re-download).
  useEffect(() => {
    if (near || !root || !boxRef.current) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setNear(true);
    }, { root, rootMargin: "2000px 0px 2000px 0px" });
    io.observe(boxRef.current);
    return () => io.disconnect();
  }, [near, root]);
  const dims = useMemo(() => {
    switch (fit) {
      case "stretch": return { width: columnPx, height: viewportH };
      case "screen": { const w = Math.min(columnPx, viewportH / ratio); return { width: w, height: w * ratio }; }
      case "height": { const w = Math.min(columnPx, viewportH / ratio); return { width: w, height: Math.min(viewportH, w * ratio) }; }
      case "original": { const w = natural > 0 ? Math.min(columnPx, natural / Math.min(window.devicePixelRatio || 1, 2)) : columnPx; return { width: w, height: w * ratio }; }
      case "smart": {
        if (ratio >= 1.8) return { width: columnPx, height: columnPx * ratio }; // webtoon strip
        const w = Math.min(columnPx, viewportH / ratio);
        return { width: w, height: w * ratio };
      }
      case "width":
      default: return { width: columnPx, height: columnPx * ratio };
    }
  }, [fit, columnPx, viewportH, ratio, natural]);
  return (
    <div ref={boxRef} data-page={page} className={`flex justify-center ${gap ? "pb-3" : ""}`}>
      {near
        ? <PageImage uri={uri} page={page} style={{ width: dims.width, height: dims.height }} onDisplayed={onDisplayed} onRatio={onRatio} />
        : <div style={{ width: dims.width, height: dims.height }} className="bg-m-night-panel/40" />}
    </div>
  );
});

// ── screen ───────────────────────────────────────────────────────────────────

export function MangaReaderPage() {
  const { ref = "" } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const decoded = useMemo(() => decodeReaderRef(ref), [ref]);
  // Anchor = stable work identity (progress/library); the chapter may live on
  // a different source after the cross-source merge.
  const source = decoded?.source ?? "asq";
  const mangaId = decoded?.mangaId ?? "";
  const chapterSource = decoded?.chapterSource ?? source;
  const chapterMangaId = decoded?.chapterMangaId ?? mangaId;
  const chapterId = decoded?.chapterId ?? "";
  const mangaTitle = params.get("title") ?? "";
  const chapterNumber = params.get("num") ?? "";
  const coverParam = params.get("cover") ?? "";

  const [pages, setPages] = useState<string[] | null>(null);
  const [detail, setDetail] = useState<MergedMangaDetail | null>(null);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [prefs, setPrefs] = useState<ReaderPrefs>(loadPrefs);
  const [progressReady, setProgressReady] = useState(false);
  const [chrome, setChrome] = useState(true);
  const [index, setIndex] = useState(0);
  const [listOpen, setListOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chapterQuery, setChapterQuery] = useState("");
  const [viewport, setViewport] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));

  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);
  const pendingPageRef = useRef(0);
  const restoredRef = useRef(false);
  const restoringRef = useRef(false);
  const userInteractedRef = useRef(false);
  const pagesRef = useRef<string[] | null>(null);
  const displayedRef = useRef(new Set<string>());
  const indexRef = useRef(0);
  const prefetchRef = useRef<string | null>(null);
  pagesRef.current = pages;
  indexRef.current = index;

  // Stable callback ref: an inline one would re-fire every render and loop on setScrollRoot.
  const attachScroll = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
    setScrollRoot(el);
    el?.focus({ preventScroll: true });
  }, []);

  const readIds = useReadChapters(source, mangaId);
  const readSet = useMemo(() => new Set(readIds), [readIds]);

  useEffect(() => { void storage.setItem(PREFS_KEY, JSON.stringify(prefs)); }, [prefs]);
  useEffect(() => {
    loadRatios();
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); persistRatios(); };
  }, []);

  // ── load chapter + detail + saved position ──
  useEffect(() => {
    if (!decoded) return;
    let alive = true;
    setPages(null);
    setProgressReady(false);
    setDetail((prev) => (prev && prev.source === source && prev.id === mangaId ? prev : null));
    setChrome(true);
    setError(false);
    setIndex(0);
    displayedRef.current.clear();
    restoredRef.current = false;
    restoringRef.current = true;
    userInteractedRef.current = false;
    pendingPageRef.current = 0;
    prefetchRef.current = null;
    scrollRef.current?.scrollTo({ top: 0 });

    void fetchMangaChapter(chapterSource, chapterMangaId, chapterId, { force: reloadKey > 0 })
      .then((data) => { if (alive) { if (data.pages.length) setPages(data.pages); else setError(true); } })
      .catch(() => { if (alive) setError(true); });

    void fetchMergedDetail(source, mangaId, { onUpdate: (merged) => { if (alive) setDetail(merged); } })
      .then((merged) => { if (alive) setDetail(merged); })
      .catch(() => {});

    void getMangaProgress(source, mangaId).then((progress) => {
      if (!alive || !progress || progress.page <= 0) return;
      // Same chapter, possibly served by a different source after a merge
      // reshuffle — match by native id first, then by chapter number.
      const sameChapter = progress.chapterId === chapterId
        ? (progress.chapterSource ?? source) === chapterSource
        : !!chapterNumber && progress.chapterNumber === chapterNumber;
      if (sameChapter) pendingPageRef.current = progress.page;
    }).catch(() => {}).finally(() => { if (alive) setProgressReady(true); });

    return () => { alive = false; flushMangaStore(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, mangaId, chapterSource, chapterMangaId, chapterId, chapterNumber, reloadKey]);

  useEffect(() => () => flushMangaStore(), []);

  // ── progress saving ──
  const saveRef = useRef<(pageIndex: number) => void>(() => {});
  saveRef.current = (pageIndex: number) => {
    const total = pagesRef.current?.length ?? 0;
    if (total <= 0 || !progressReady) return;
    // The first visibility tick (page 0) must not overwrite the saved position
    // while the restore jump is still in flight.
    if (restoringRef.current) {
      if (pageIndex !== pendingPageRef.current) return;
      restoringRef.current = false;
    }
    setIndex(pageIndex);
    void saveMangaProgress({
      source,
      id: mangaId,
      title: mangaTitle || detail?.title || "",
      cover: coverParam || detail?.cover || null,
      chapterId,
      chapterSource,
      chapterMangaId,
      chapterNumber,
      page: pageIndex,
      total,
    });
    const lastUri = pagesRef.current?.[total - 1];
    if (pageIndex >= total - 1 && lastUri && displayedRef.current.has(lastUri)) {
      void markMangaChapterRead(source, mangaId, mangaChapterReadKey(chapterSource, chapterId));
    }
  };

  const onPageDisplayed = useCallback((uri: string) => {
    displayedRef.current.add(uri);
    if (indexRef.current >= (pagesRef.current?.length ?? 0) - 1) saveRef.current(indexRef.current);
  }, []);

  // ── restore saved page ──
  const scrollToPage = useCallback((target: number, smooth = false) => {
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-page="${target}"]`);
    if (el && scrollRef.current) scrollRef.current.scrollTo({ top: el.offsetTop, behavior: smooth ? "smooth" : "auto" });
  }, []);

  useEffect(() => {
    if (!pages || !progressReady || restoredRef.current) return;
    restoredRef.current = true;
    if (userInteractedRef.current) return;
    const target = clamp(pendingPageRef.current, 0, pages.length - 1);
    pendingPageRef.current = target;
    setIndex(target);
    if (target <= 0) { restoringRef.current = false; saveRef.current(0); return; }
    restoringRef.current = true;
    if (prefs.mode === "vertical") {
      // Two passes: once now, once after early pages measure their real height.
      const a = setTimeout(() => scrollToPage(target), 60);
      const b = setTimeout(() => { if (!userInteractedRef.current) scrollToPage(target); }, 900);
      return () => { clearTimeout(a); clearTimeout(b); };
    }
    saveRef.current(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages, progressReady]);

  // Vertical mode: the current page is the one crossing the upper third.
  useEffect(() => {
    if (prefs.mode !== "vertical" || !pages) return;
    const root = scrollRef.current;
    if (!root) return;
    // Trailing timer, not rAF: rAF stalls while the window is in the background
    // (e.g. reading in a side window) and progress would stop saving.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        const probe = root.scrollTop + root.clientHeight / 3;
        const nodes = root.querySelectorAll<HTMLElement>("[data-page]");
        let current = 0;
        for (const node of nodes) {
          if (node.offsetTop <= probe) current = Number(node.dataset.page);
          else break;
        }
        // At the very bottom the last page counts as reached.
        if (root.scrollTop + root.clientHeight >= root.scrollHeight - 4) current = pages.length - 1;
        if (current !== indexRef.current || restoringRef.current) saveRef.current(current);
      }, 120);
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => { root.removeEventListener("scroll", onScroll); if (timer) clearTimeout(timer); };
  }, [prefs.mode, pages]);

  // Switching modes keeps the current page.
  const lastModeRef = useRef(prefs.mode);
  useEffect(() => {
    if (lastModeRef.current === prefs.mode) return;
    lastModeRef.current = prefs.mode;
    if (prefs.mode === "vertical") setTimeout(() => scrollToPage(indexRef.current), 50);
  }, [prefs.mode, scrollToPage]);

  // ── chapter navigation ──
  const chapters = detail?.chapters ?? [];
  const currentIdx = useMemo(() => {
    let idx = chapters.findIndex((c) => c.id === chapterId && c.source === chapterSource);
    if (idx < 0 && chapterNumber) idx = chapters.findIndex((c) => c.number === chapterNumber);
    return idx;
  }, [chapters, chapterId, chapterSource, chapterNumber]);
  const newerChapter = currentIdx > 0 ? chapters[currentIdx - 1] : null;
  const olderChapter = currentIdx >= 0 && currentIdx < chapters.length - 1 ? chapters[currentIdx + 1] : null;

  // Prefetch the next chapter (payload + first pages) near the end.
  useEffect(() => {
    if (!pages || !newerChapter || index < pages.length - 5) return;
    const key = `${newerChapter.source}:${newerChapter.id}`;
    if (prefetchRef.current === key) return;
    prefetchRef.current = key;
    void fetchMangaChapter(newerChapter.source, newerChapter.mangaId, newerChapter.id)
      .then((data) => { for (const url of data.pages.slice(0, 3)) { const img = new Image(); img.src = upgradeMangaPage(url); } })
      .catch(() => {});
  }, [index, pages, newerChapter]);

  const goToChapter = useCallback((chapter: MergedChapter) => {
    setListOpen(false);
    navigate(mangaReaderPath({
      source,
      mangaId,
      mangaTitle: mangaTitle || detail?.title || "",
      chapter: { source: chapter.source, mangaId: chapter.mangaId, id: chapter.id, number: chapter.number },
      cover: coverParam || detail?.cover || null,
    }), { replace: true });
  }, [navigate, source, mangaId, mangaTitle, coverParam, detail]);

  const total = pages?.length ?? 0;

  const jumpTo = useCallback((target: number) => {
    if (!total) return;
    userInteractedRef.current = true;
    restoringRef.current = false;
    const clamped = clamp(target, 0, total - 1);
    if (prefs.mode === "vertical") {
      scrollToPage(clamped, true);
      saveRef.current(clamped);
    } else {
      saveRef.current(clamped);
    }
  }, [total, prefs.mode, scrollToPage]);

  /** Paged step: past the last page goes to the next chapter (and back). */
  const step = useCallback((delta: 1 | -1) => {
    if (!total) return;
    const next = indexRef.current + delta;
    if (next >= total) { if (newerChapter) goToChapter(newerChapter); return; }
    if (next < 0) { if (olderChapter) goToChapter(olderChapter); return; }
    jumpTo(next);
  }, [total, newerChapter, olderChapter, goToChapter, jumpTo]);

  const exit = useCallback(() => {
    if (window.history.length > 1) navigate(-1);
    else navigate(mangaDetailPath({ source, id: mangaId, title: mangaTitle, cover: coverParam }));
  }, [navigate, source, mangaId, mangaTitle, coverParam]);

  // ── chrome auto-hide ──
  const chromeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pokeChrome = useCallback(() => {
    setChrome(true);
    if (chromeTimer.current) clearTimeout(chromeTimer.current);
    chromeTimer.current = setTimeout(() => setChrome(false), 3500);
  }, []);
  useEffect(() => {
    if (!pages || listOpen || settingsOpen) { if (chromeTimer.current) clearTimeout(chromeTimer.current); return; }
    pokeChrome();
    return () => { if (chromeTimer.current) clearTimeout(chromeTimer.current); };
  }, [pages, listOpen, settingsOpen, pokeChrome]);

  // ── keyboard ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (e.key === "Escape") {
        if (listOpen || settingsOpen) { setListOpen(false); setSettingsOpen(false); }
        else if (document.fullscreenElement) void document.exitFullscreen();
        else exit();
        return;
      }
      if (e.key === "f" || e.key === "F") { toggleFullscreen(); return; }
      if (listOpen || settingsOpen) return;
      const rtl = prefs.direction === "rtl";
      if (prefs.mode === "vertical") {
        if (e.key === "n" || e.key === "N") { if (newerChapter) goToChapter(newerChapter); return; }
        if (e.key === "p" || e.key === "P") { if (olderChapter) goToChapter(olderChapter); return; }
        return; // native scrolling handles arrows/space/PageUp/PageDown
      }
      let delta: 1 | -1 | 0 = 0;
      if (e.key === "ArrowLeft") delta = prefs.mode === "paged" ? (rtl ? 1 : -1) : 0;
      else if (e.key === "ArrowRight") delta = prefs.mode === "paged" ? (rtl ? -1 : 1) : 0;
      else if (e.key === "ArrowDown" || e.key === "PageDown" || e.key === " ") delta = 1;
      else if (e.key === "ArrowUp" || e.key === "PageUp") delta = -1;
      else if (e.key === "Home") { jumpTo(0); return; }
      else if (e.key === "End") { jumpTo(total - 1); return; }
      if (delta) { e.preventDefault(); step(delta); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prefs.mode, prefs.direction, listOpen, settingsOpen, step, jumpTo, total, exit, newerChapter, olderChapter, goToChapter]);

  // Paged modes: the wheel turns pages (debounced so one flick = one page).
  const wheelLock = useRef(0);
  const onWheel = (e: React.WheelEvent) => {
    if (prefs.mode === "vertical" || listOpen || settingsOpen) return;
    const now = Date.now();
    if (now - wheelLock.current < 350 || Math.abs(e.deltaY) < 10) return;
    wheelLock.current = now;
    step(e.deltaY > 0 ? 1 : -1);
  };

  const filteredChapters = useMemo(() => {
    if (!chapterQuery.trim()) return chapters;
    const q = normFuzzy(chapterQuery);
    const n = chapterNumberKey(chapterQuery);
    return chapters.filter((c) => (n && chapterNumberKey(c.number).includes(n)) || (q && normFuzzy(c.title ?? "").includes(q)));
  }, [chapters, chapterQuery]);

  // Scroll the active chapter into view when the drawer opens.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!listOpen) return;
    setChapterQuery("");
    setTimeout(() => listRef.current?.querySelector("[data-active='true']")?.scrollIntoView({ block: "center" }), 30);
  }, [listOpen]);

  if (!decoded) {
    return (
      <div className="fixed inset-0 z-player flex items-center justify-center bg-m-night" dir="rtl">
        <MangaState dark icon={ICONS.alert} variant="error" title={t.mangaLoadError} message={t.mangaLoadErrorSub}
          primary={{ label: t.back, onClick: exit, icon: ICONS.back }} />
      </div>
    );
  }

  const columnPx = Math.round(viewport.w * (prefs.column / 100));
  const titleText = mangaTitle || detail?.title || "";
  const pagedUri = pages?.[clamp(index, 0, Math.max(0, total - 1))];

  return (
    <div dir="rtl" className="fixed inset-0 z-player select-none bg-m-night text-m-sheet" onMouseMove={pokeChrome} onWheel={onWheel}>
      {/* ── canvas ── */}
      {error ? (
        <div className="flex h-full items-center justify-center">
          <MangaState dark icon={ICONS.offline} variant="error" title={t.mangaChapterError} message={t.mangaLoadErrorSub}
            primary={{ label: t.retry, onClick: () => setReloadKey((k) => k + 1), icon: ICONS.refresh }} />
        </div>
      ) : !pages ? (
        <div className="flex h-full flex-col items-center justify-center gap-4">
          <div className="h-10 w-10 animate-spin rounded-full border-2 border-m-night-accent border-t-transparent" />
          <div className="text-sm font-semibold text-m-night-muted">{t.mangaLoadingChapter}</div>
          {chapterNumber && <div className="text-xs text-m-night-muted">الفصل {chapterNumber}</div>}
        </div>
      ) : prefs.mode === "vertical" ? (
        <div ref={attachScroll} tabIndex={-1}
          className="h-full overflow-y-auto overscroll-contain outline-none"
          onClick={() => setChrome((v) => !v)}
          onWheel={() => { userInteractedRef.current = true; }}>
          <div className="pb-4 pt-16">
            {pages.map((uri, i) => (
              <VerticalPage key={uri} uri={uri} page={i} fit={prefs.fit} columnPx={columnPx} viewportH={viewport.h}
                gap={prefs.gap} root={scrollRoot} onDisplayed={onPageDisplayed} />
            ))}
          </div>
          <ChapterEnd newer={newerChapter} older={olderChapter} onGo={goToChapter} onBack={exit} />
        </div>
      ) : (
        <div className="relative flex h-full items-center justify-center overflow-hidden">
          {pagedUri && (
            <PagedView key={pagedUri} uri={pagedUri} page={index} fit={prefs.fit} viewport={viewport} onDisplayed={onPageDisplayed} />
          )}
          {/* click zones: outer thirds turn pages, the middle toggles chrome */}
          <div className="absolute inset-0 flex" dir="ltr">
            <button type="button" aria-label="zone-left" className="h-full w-1/3 cursor-w-resize focus:outline-none"
              onClick={() => step(prefs.mode === "paged" ? (prefs.direction === "rtl" ? 1 : -1) : -1)} />
            <button type="button" aria-label="zone-center" className="h-full w-1/3 cursor-default focus:outline-none" onClick={() => setChrome((v) => !v)} />
            <button type="button" aria-label="zone-right" className="h-full w-1/3 cursor-e-resize focus:outline-none"
              onClick={() => step(prefs.mode === "paged" ? (prefs.direction === "rtl" ? -1 : 1) : 1)} />
          </div>
          {index >= total - 1 && (
            <div className="pointer-events-none absolute inset-x-0 bottom-24 flex justify-center">
              <div className="pointer-events-auto rounded-lg border border-m-night-line bg-m-night-panel/95 px-5 py-3 text-sm shadow-xl">
                {newerChapter
                  ? <button type="button" onClick={() => goToChapter(newerChapter)} className="font-bold text-m-night-accent">{t.mangaFinishedChapter} — {t.mangaNextChapter} • الفصل {newerChapter.number}</button>
                  : <span className="text-m-night-muted">{t.mangaFinishedChapter} · {t.mangaNoNewer}</span>}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── top chrome ── */}
      <div className={`absolute inset-x-0 top-0 z-10 flex items-center gap-3 bg-gradient-to-b from-black/85 to-transparent px-5 pb-6 pt-3 transition-opacity duration-200 ${chrome || !pages ? "opacity-100" : "pointer-events-none opacity-0"}`}>
        <button type="button" onClick={exit} aria-label={t.back} className="flex h-10 w-10 items-center justify-center rounded-full hover:bg-white/10">
          <MIcon d={ICONS.back} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-bold">{titleText}</div>
          <div className="text-xs text-m-night-muted">الفصل {chapterNumber}{total ? ` · ${index + 1} / ${total}` : ""}</div>
        </div>
        <button type="button" onClick={toggleFullscreen} title="ملء الشاشة (F)" className="flex h-10 w-10 items-center justify-center rounded-full hover:bg-white/10">
          <MIcon d={ICONS.maximize} size={18} />
        </button>
        <button type="button" onClick={() => setSettingsOpen(true)} aria-label={t.mangaReaderSettings} className="flex h-10 w-10 items-center justify-center rounded-full hover:bg-white/10">
          <MIcon d={ICONS.settings} size={19} />
        </button>
      </div>

      {/* ── bottom chrome ── */}
      {pages && (
        <div className={`absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/85 to-transparent px-5 pb-4 pt-8 transition-opacity duration-200 ${chrome ? "opacity-100" : "pointer-events-none opacity-0"}`}>
          <div className="mx-auto flex max-w-4xl items-center gap-3">
            <ChromeButton label={t.mangaPrevChapter} disabled={!olderChapter} onClick={() => olderChapter && goToChapter(olderChapter)} icon={ICONS.back} />
            <PageSlider total={total} index={index} onSeek={jumpTo} direction={prefs.mode === "paged" ? prefs.direction : "rtl"} />
            <ChromeButton label={t.mangaChaptersList} onClick={() => setListOpen(true)} icon={ICONS.list} />
            <ChromeButton label={t.mangaNextChapter} disabled={!newerChapter} onClick={() => newerChapter && goToChapter(newerChapter)} icon={ICONS.forward} iconAfter />
          </div>
        </div>
      )}

      {/* ── chapter drawer ── */}
      {listOpen && (
        <div className="absolute inset-0 z-20 flex justify-start bg-black/50" onClick={() => setListOpen(false)}>
          <div className="flex h-full w-[420px] max-w-full flex-col border-e border-m-night-line bg-m-night shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-m-night-line px-5 py-4">
              <h2 className="text-lg font-bold">{t.mangaChaptersList}</h2>
              <button type="button" onClick={() => setListOpen(false)} aria-label={t.cancel} className="text-m-night-muted hover:text-m-sheet"><MIcon d={ICONS.close} /></button>
            </div>
            <div className="px-5 pt-4">
              <label className="flex h-11 items-center gap-2 rounded border border-m-night-line bg-m-night-panel px-3 focus-within:border-m-night-accent">
                <MIcon d={ICONS.search} size={18} className="text-m-night-muted" />
                <input autoFocus value={chapterQuery} onChange={(e) => setChapterQuery(e.target.value)} placeholder={t.mangaChapterFilter} aria-label={t.mangaChapterFilter}
                  className="h-full flex-1 bg-transparent text-sm text-m-sheet outline-none placeholder:text-m-night-muted" />
              </label>
            </div>
            <div ref={listRef} className="flex-1 space-y-2 overflow-y-auto px-5 py-4">
              {!detail && [0, 1, 2, 3, 4].map((i) => <MangaSkeleton key={i} dark className="h-[72px] w-full" />)}
              {filteredChapters.map((chapter) => {
                const active = chapter.id === chapterId && chapter.source === chapterSource;
                const read = readSet.has(mangaChapterReadKey(chapter.source, chapter.id));
                return (
                  <div key={`${chapter.source}:${chapter.id}`} data-active={active ? "true" : undefined}>
                    <ChapterRow dark number={chapter.number} title={active ? t.mangaReadingNow : chapter.title} date={chapter.date} read={read} active={active}
                      onClick={() => goToChapter(chapter)}
                      onToggleRead={() => void setMangaChapterRead(source, mangaId, mangaChapterReadKey(chapter.source, chapter.id), !read)} />
                  </div>
                );
              })}
            </div>
            <div className="border-t border-m-night-line px-5 py-3 text-xs text-m-night-muted">انقر بزر الفأرة الأيمن أو على علامة ✓ لتغيير حالة القراءة</div>
          </div>
        </div>
      )}

      {/* ── settings ── */}
      {settingsOpen && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/55 p-6" onClick={() => setSettingsOpen(false)}>
          <div className="w-full max-w-lg rounded-lg border border-m-night-line bg-m-night p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-5 flex items-center justify-between">
              <h2 className="text-lg font-bold">{t.mangaReaderSettings}</h2>
              <button type="button" onClick={() => setSettingsOpen(false)} aria-label={t.cancel} className="text-m-night-muted hover:text-m-sheet"><MIcon d={ICONS.close} /></button>
            </div>
            <div className="space-y-5">
              <SettingBlock label={t.mangaReaderMode}>
                <ChoiceChip dark label={t.mangaReaderVertical} active={prefs.mode === "vertical"} onClick={() => setPrefs((p) => ({ ...p, mode: "vertical" }))} />
                <ChoiceChip dark label={t.mangaReaderPaged} active={prefs.mode === "paged"} onClick={() => setPrefs((p) => ({ ...p, mode: "paged" }))} />
                <ChoiceChip dark label={t.mangaReaderPagedV} active={prefs.mode === "pagedV"} onClick={() => setPrefs((p) => ({ ...p, mode: "pagedV" }))} />
              </SettingBlock>
              {prefs.mode === "paged" && (
                <SettingBlock label={t.mangaDirection}>
                  <ChoiceChip dark label={t.mangaDirectionRtl} active={prefs.direction === "rtl"} onClick={() => setPrefs((p) => ({ ...p, direction: "rtl" }))} />
                  <ChoiceChip dark label={t.mangaDirectionLtr} active={prefs.direction === "ltr"} onClick={() => setPrefs((p) => ({ ...p, direction: "ltr" }))} />
                </SettingBlock>
              )}
              <SettingBlock label={t.mangaReaderFit}>
                {([
                  ["width", t.mangaFitWidth], ["screen", t.mangaFitScreen], ["height", t.mangaFitHeight],
                  ["stretch", t.mangaFitStretch], ["original", t.mangaFitOriginal], ["smart", t.mangaFitSmart],
                ] as [FitMode, string][]).map(([fit, label]) => (
                  <ChoiceChip dark key={fit} label={label} active={prefs.fit === fit} onClick={() => setPrefs((p) => ({ ...p, fit }))} />
                ))}
              </SettingBlock>
              {prefs.mode === "vertical" && (
                <>
                  <div>
                    <div className="mb-2 flex items-center justify-between text-sm font-bold text-m-night-muted">
                      <span>عرض عمود القراءة</span><span dir="ltr">{prefs.column}%</span>
                    </div>
                    <input type="range" min={25} max={100} step={5} value={prefs.column} dir="ltr"
                      onChange={(e) => setPrefs((p) => ({ ...p, column: Number(e.target.value) }))}
                      className="w-full accent-[#F09572]" />
                  </div>
                  <SettingBlock label="المسافة بين الصفحات">
                    <ChoiceChip dark label="بدون" active={!prefs.gap} onClick={() => setPrefs((p) => ({ ...p, gap: false }))} />
                    <ChoiceChip dark label="مسافة صغيرة" active={prefs.gap} onClick={() => setPrefs((p) => ({ ...p, gap: true }))} />
                  </SettingBlock>
                </>
              )}
              <div className="rounded border border-m-night-line bg-m-night-panel px-4 py-3 text-xs leading-6 text-m-night-muted">
                الأسهم / Space / PageUp-PageDown للتنقل · N و P للفصل التالي والسابق · F لملء الشاشة · Esc للخروج
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function toggleFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen().catch(() => {});
}

// ── pieces ───────────────────────────────────────────────────────────────────

function PagedView({ uri, page, fit, viewport, onDisplayed }: {
  uri: string; page: number; fit: FitMode; viewport: { w: number; h: number }; onDisplayed: (uri: string) => void;
}) {
  const [ratio, setRatio] = useState(() => ratioCache.get(uri) ?? recentRatio);
  const [natural, setNatural] = useState(0);
  const { w, h } = viewport;
  const dims = (() => {
    switch (fit) {
      case "stretch": return { width: w, height: h };
      case "width": return { width: w, height: w * ratio };
      case "height": return { width: h / ratio, height: h };
      case "original": {
        const width = natural > 0 ? natural / Math.min(window.devicePixelRatio || 1, 2) : Math.min(w, h / ratio);
        return { width, height: width * ratio };
      }
      case "smart": {
        // Tall strips read best at full width; ordinary pages fit the screen.
        if (ratio >= 1.8) return { width: Math.min(w, 900), height: Math.min(w, 900) * ratio };
        const width = Math.min(w, h / ratio);
        return { width, height: width * ratio };
      }
      case "screen":
      default: { const width = Math.min(w, h / ratio); return { width, height: width * ratio }; }
    }
  })();
  const scrolls = dims.height > h + 1 || dims.width > w + 1;
  return (
    <div className={`flex h-full w-full justify-center ${scrolls ? "items-start overflow-auto" : "items-center"}`}>
      <PageImage uri={uri} page={page} style={{ width: dims.width, height: dims.height, flexShrink: 0 }}
        onDisplayed={onDisplayed} onRatio={(r, nw) => { setRatio(r); setNatural(nw); }} />
    </div>
  );
}

function ChapterEnd({ newer, older, onGo, onBack }: {
  newer: MergedChapter | null; older: MergedChapter | null; onGo: (chapter: MergedChapter) => void; onBack: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 pb-36 pt-16 text-center" onClick={(e) => e.stopPropagation()}>
      <div className="flex h-16 w-16 items-center justify-center rounded-full border border-m-night-line bg-m-night-panel text-m-night-accent">
        <MIcon d={ICONS.check} size={26} />
      </div>
      <div className="text-xl font-bold">{t.mangaFinishedChapter}</div>
      {newer ? (
        <button type="button" onClick={() => onGo(newer)} className="flex min-h-[48px] items-center gap-2 rounded bg-m-accent px-6 text-sm font-bold text-m-sheet hover:opacity-90">
          {t.mangaNextChapter} • الفصل {newer.number}<MIcon d={ICONS.forward} size={16} />
        </button>
      ) : (
        <div className="text-sm text-m-night-muted">{t.mangaNoNewer}</div>
      )}
      {older && (
        <button type="button" onClick={() => onGo(older)} className="min-h-[44px] rounded border border-m-night-line px-6 text-sm font-bold text-m-night-muted hover:text-m-sheet">
          {t.mangaPrevChapter} • الفصل {older.number}
        </button>
      )}
      <button type="button" onClick={onBack} className="mt-2 text-sm font-semibold text-m-night-muted underline-offset-4 hover:underline">العودة إلى دليل العمل</button>
    </div>
  );
}

function ChromeButton({ label, icon, onClick, disabled = false, iconAfter = false }: {
  label: string; icon: string; onClick: () => void; disabled?: boolean; iconAfter?: boolean;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={label}
      className="flex h-10 shrink-0 items-center gap-1.5 rounded-full border border-white/15 bg-black/40 px-3.5 text-xs font-bold backdrop-blur hover:bg-white/10 disabled:opacity-35">
      {!iconAfter && <MIcon d={icon} size={16} />}{label}{iconAfter && <MIcon d={icon} size={16} />}
    </button>
  );
}

function PageSlider({ total, index, onSeek, direction }: {
  total: number; index: number; onSeek: (page: number) => void; direction: ReaderDirection;
}) {
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag ?? index;
  return (
    <div className="flex flex-1 items-center gap-3" dir={direction}>
      <span className="w-8 text-center font-mono text-xs text-m-night-muted" dir="ltr">{shown + 1}</span>
      <input type="range" min={0} max={Math.max(0, total - 1)} value={shown} aria-label={t.mangaPageJump}
        onChange={(e) => setDrag(Number(e.target.value))}
        onPointerUp={() => { if (drag != null) { onSeek(drag); setDrag(null); } }}
        onKeyUp={() => { if (drag != null) { onSeek(drag); setDrag(null); } }}
        className="flex-1 accent-[#F09572]" />
      <span className="w-8 text-center font-mono text-xs text-m-night-muted" dir="ltr">{total}</span>
    </div>
  );
}

function SettingBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-2 text-sm font-bold text-m-night-muted">{label}</div>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}
