import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { fetchAllAnime, fetchGenre, searchAnimeStream, type SearchResult } from "../lib/api";
import { AnimeCard } from "../components/AnimeCard";
import { CardLayoutControl } from "../components/CardLayoutControl";
import { CompletionBadge } from "../components/CompletionBadge";
import { Shimmer } from "../components/Shimmer";
import { useCardLayout } from "../lib/cardLayout";
import { t } from "../lib/i18n";

// Debounce the live search so each keystroke doesn't fire a (networked) query.
const DEBOUNCE_MS = 350;
// Short queries match far too much and feel noisy — wait for a 2nd char.
const MIN_QUERY = 2;

// Mobile's Discover genre list. Values are the scraper's English slugs
// (lib/scraper WIT_GENRES); labels are display-only.
const GENRE_LABELS: Record<string, string> = {
  All: t.genreAll,
  Action: t.genreAction,
  Adventure: t.genreAdventure,
  Comedy: t.genreComedy,
  Drama: t.genreDrama,
  Fantasy: t.genreFantasy,
  Horror: t.genreHorror,
  Mystery: t.genreMystery,
  Romance: t.genreRomance,
  "Sci-Fi": t.genreSciFi,
  "Slice of Life": t.genreSliceOfLife,
  Sports: t.genreSports,
  Supernatural: t.genreSupernatural,
  Thriller: t.genreThriller,
  Mecha: t.genreMecha,
  Shounen: t.genreShounen,
  Seinen: t.genreSeinen,
};
const GENRES = Object.keys(GENRE_LABELS);

type Mode = "browse" | "genre" | "search";

/** List-layout row — small poster + title, mirrors mobile's PosterCard list mode. */
function SearchRowCard({ item }: { item: SearchResult }) {
  const [imgFailed, setImgFailed] = useState(false);
  const showImg = item.image && !imgFailed;
  return (
    <Link
      to={`/anime/${encodeURIComponent(item.href)}`}
      className="group flex items-center gap-4 rounded-xl border border-white/10 bg-raised p-3 transition-colors hover:bg-white/5"
    >
      <div className="relative aspect-[2/3] w-[84px] shrink-0 overflow-hidden rounded-lg bg-surface">
        {showImg ? (
          <img
            src={item.image}
            alt={item.title}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
            loading="lazy"
            decoding="async"
            onError={() => setImgFailed(true)}
          />
        ) : (
          <div className="h-full w-full shimmer" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="line-clamp-2 text-sm font-semibold text-text-secondary transition-colors group-hover:text-white">
          {item.title}
        </h3>
        {item.type && <p className="mt-1 text-xs text-text-muted">{item.type}</p>}
      </div>
      <CompletionBadge hrefs={[item.href]} titles={[item.title]} className="shrink-0" />
    </Link>
  );
}

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [activeGenre, setActiveGenre] = useState("All");
  // Live streaming search (unchanged).
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Browse-all / genre grid (infinite scroll).
  const [items, setItems] = useState<SearchResult[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const cards = useCardLayout("search");
  // Race guard: each search bumps reqId; stale callbacks whose id no longer
  // matches are dropped so a slow witanime result can't clobber a newer query.
  const reqId = useRef(0);
  const listSeq = useRef(0);
  const pageRef = useRef(1);
  const seenRef = useRef<Set<string>>(new Set());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastGenreParam = useRef<string | null>(null);
  const browseLoaded = useRef(false);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Mode is derived, never stored: a genre chip wins only while the query is
  // empty; a query of 2+ chars (or a submitted ?q=) is a live search.
  const term = q.trim();
  const mode: Mode =
    term.length >= MIN_QUERY || (term.length > 0 && term === (params.get("q") ?? "").trim())
      ? "search"
      : activeGenre !== "All"
        ? "genre"
        : "browse";

  const runSearch = useCallback((searchTerm: string) => {
    const id = ++reqId.current;
    if (!searchTerm) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    searchAnimeStream(searchTerm, (partial, phase) => {
      if (id !== reqId.current) return;
      setResults(partial);
      // The spinner stays only while NOTHING is on screen yet: the fast phase
      // turns it off as soon as it has any card (anime4up/anime3rb land in well
      // under a second), and the full phase turns it off once witanime settles.
      if (phase === "full" || partial.length > 0) setLoading(false);
    })
      .then((final) => {
        if (id !== reqId.current) return;
        setResults(final);
        setLoading(false);
      })
      .catch((e) => {
        if (id !== reqId.current) return;
        setError(e?.message ?? t.failedToLoad);
        setLoading(false);
      });
  }, []);

  // Shared append for browse + genre pages: page 1 replaces, later pages append
  // de-duplicated. A page that adds nothing new ends pagination (hasNext from the
  // API is only "page non-empty", so repeats would otherwise loop forever).
  const appendList = useCallback((fresh: SearchResult[], page: number, more: boolean) => {
    if (page === 1) {
      seenRef.current = new Set(fresh.map((x) => x.href));
      setItems(fresh);
    } else {
      const added = fresh.filter((x) => !seenRef.current.has(x.href));
      added.forEach((x) => seenRef.current.add(x.href));
      if (added.length > 0) setItems((prev) => [...prev, ...added]);
      else more = false;
    }
    pageRef.current = page;
    setHasMore(more && fresh.length > 0);
  }, []);

  const loadBrowse = useCallback(async (page = 1) => {
    browseLoaded.current = true;
    const seq = ++listSeq.current;
    if (page === 1) {
      setListLoading(true);
      setError(null);
    } else setLoadingMore(true);
    try {
      const res = await fetchAllAnime(page);
      if (seq !== listSeq.current) return;
      if (res.data.items.length === 0) {
        if (page === 1) {
          // Mobile falls back to the Action genre when the catalog is empty.
          const fallback = await fetchGenre("Action", 1);
          if (seq !== listSeq.current) return;
          appendList(fallback.data.items, 1, fallback.data.hasNext);
        } else {
          setHasMore(false);
        }
      } else {
        appendList(res.data.items, page, res.data.hasNext);
      }
    } catch (e) {
      if (seq !== listSeq.current) return;
      if (page === 1) setError(e instanceof Error ? e.message : t.failedToLoad);
      setHasMore(false);
    } finally {
      if (seq === listSeq.current) {
        setListLoading(false);
        setLoadingMore(false);
      }
    }
  }, [appendList]);

  const loadGenre = useCallback(async (name: string, page = 1) => {
    const seq = ++listSeq.current;
    if (page === 1) {
      setListLoading(true);
      setError(null);
    } else setLoadingMore(true);
    try {
      const res = await fetchGenre(name, page);
      if (seq !== listSeq.current) return;
      appendList(res.data.items, page, res.data.hasNext);
    } catch (e) {
      if (seq !== listSeq.current) return;
      if (page === 1) setError(e instanceof Error ? e.message : t.failedToLoad);
      setHasMore(false);
    } finally {
      if (seq === listSeq.current) {
        setListLoading(false);
        setLoadingMore(false);
      }
    }
  }, [appendList]);

  // Pull ?q= into the input when it changes externally (deep link, back/forward).
  // Typing updates `q` directly, so this only fires on real URL changes — no loop.
  useEffect(() => {
    const urlQ = params.get("q") ?? "";
    setQ((cur) => (cur === urlQ ? cur : urlQ));
  }, [params]);

  // Deep link: ?genre=Action opens that genre's grid. Read-only — chip presses
  // keep the URL clean and match mobile (which never writes the genre param).
  useEffect(() => {
    const raw = params.get("genre");
    if (!raw || raw === lastGenreParam.current) return;
    lastGenreParam.current = raw;
    if (!GENRES.includes(raw)) return;
    setActiveGenre(raw);
    setQ("");
    reqId.current++; // drop any in-flight search so its error can't surface here
    void loadGenre(raw, 1);
  }, [params, loadGenre]);

  // The catalog loads once, the first time browse mode is actually shown —
  // deep links to ?q= / ?genre= don't pay for a wasted browse scrape.
  useEffect(() => {
    if (mode !== "browse" || browseLoaded.current) return;
    void loadBrowse(1);
  }, [mode, loadBrowse]);

  // Debounced live search driven by the input value.
  useEffect(() => {
    const term = q.trim();
    if (term.length < MIN_QUERY) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }
    debounceRef.current = setTimeout(() => runSearch(term), DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [q, runSearch]);

  const handleGenre = useCallback((genre: string) => {
    setActiveGenre(genre);
    setQ("");
    reqId.current++; // cancel any in-flight search
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (genre === "All") {
      void loadBrowse(1);
      return;
    }
    void loadGenre(genre, 1);
  }, [loadBrowse, loadGenre]);

  // "Browse all" from the empty search state.
  const showBrowseAll = useCallback(() => {
    setQ("");
    setActiveGenre("All");
    reqId.current++;
    setParams({}, { replace: true });
    void loadBrowse(1);
  }, [loadBrowse, setParams]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const term = q.trim();
    // Keep the URL shareable / back-button friendly.
    setParams(term ? { q: term } : {}, { replace: true });
    // Flush immediately on Enter — skip the debounce wait.
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (term) runSearch(term);
  }

  const loadMore = useCallback(() => {
    if (mode === "search" || loadingMore || listLoading || !hasMore) return;
    if (mode === "genre") void loadGenre(activeGenre, pageRef.current + 1);
    else void loadBrowse(pageRef.current + 1);
  }, [mode, activeGenre, loadingMore, listLoading, hasMore, loadBrowse, loadGenre]);

  // Infinite scroll via IntersectionObserver, with the button as manual fallback.
  useEffect(() => {
    if (mode === "search" || !hasMore || listLoading) return;
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) loadMore();
    }, { rootMargin: "1600px" }); // prefetch ~1.5–2 screens early to hide latency
    io.observe(el);
    return () => io.disconnect();
  }, [mode, hasMore, listLoading, loadingMore, items.length, loadMore]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const gridStyle = { gridTemplateColumns: `repeat(${cards.columns}, minmax(0, 1fr))` };
  const renderList = (list: SearchResult[]) =>
    cards.layout === "list" ? (
      <div className="space-y-2">
        {list.map((it) => <SearchRowCard key={it.href} item={it} />)}
      </div>
    ) : (
      <div className="grid gap-3" style={gridStyle}>
        {list.map((it) => <AnimeCard key={it.href} item={it} />)}
      </div>
    );
  const renderSkeleton = () =>
    cards.layout === "list" ? (
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => <Shimmer key={i} className="h-[148px] w-full" />)}
      </div>
    ) : (
      <div className="grid gap-3" style={gridStyle}>
        {Array.from({ length: cards.columns * 4 }).map((_, i) => <Shimmer key={i} className="aspect-[2/3]" />)}
      </div>
    );

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold">{t.discover}</h1>
          <p className="mt-1 text-sm text-text-muted">{t.searchSub}</p>
        </div>
        <CardLayoutControl layout={cards.layout} onChange={cards.setLayout} />
      </div>

      <form onSubmit={submit} className="flex gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
          placeholder={t.searchPlaceholder}
          className="flex-1 rounded-full border border-white/10 bg-surface px-6 py-3.5 text-base text-white placeholder:text-text-muted focus:border-accent focus:outline-none"
        />
        <button
          type="submit"
          className="rounded-full bg-accent px-7 py-3.5 text-sm font-bold text-black transition-colors hover:bg-accent-bright"
        >
          {t.search}
        </button>
      </form>

      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {GENRES.map((g) => (
          <button
            key={g}
            type="button"
            onClick={() => handleGenre(g)}
            aria-pressed={activeGenre === g}
            className={`shrink-0 rounded-full border px-4 py-2 text-sm font-semibold transition-colors ${
              activeGenre === g
                ? "border-accent/60 bg-accent/15 text-accent"
                : "border-white/10 bg-raised text-text-secondary hover:bg-white/5 hover:text-white"
            }`}
          >
            {GENRE_LABELS[g]}
          </button>
        ))}
      </div>

      {error && (
        <div className="flex items-center gap-3 text-sm text-text-secondary">
          <span className="text-accent">{error}</span>
          {mode !== "search" && (
            <button
              type="button"
              onClick={() => (mode === "genre" ? void loadGenre(activeGenre, 1) : void loadBrowse(1))}
              className="rounded-full bg-accent px-4 py-2 font-semibold text-black"
            >
              {t.retry}
            </button>
          )}
        </div>
      )}

      {mode === "search" ? (
        loading ? (
          renderSkeleton()
        ) : results.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-10">
            <p className="text-center text-text-secondary">{t.noResults}</p>
            <button
              type="button"
              onClick={showBrowseAll}
              className="rounded-full border border-white/10 bg-raised px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:border-accent hover:bg-accent/10"
            >
              {t.browseAll}
            </button>
          </div>
        ) : (
          <>
            <p className="text-sm text-text-secondary">{t.searchResultsFor(term)}</p>
            {renderList(results)}
          </>
        )
      ) : listLoading && items.length === 0 ? (
        renderSkeleton()
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-10">
          <p className="text-center text-text-secondary">{t.noResults}</p>
          <button
            type="button"
            onClick={() => (mode === "genre" ? void loadGenre(activeGenre, 1) : void loadBrowse(1))}
            className="rounded-full bg-accent px-4 py-2 font-semibold text-black"
          >
            {t.retry}
          </button>
        </div>
      ) : (
        renderList(items)
      )}

      {mode !== "search" && hasMore && !listLoading && (
        <div ref={sentinelRef} className="flex flex-col items-center justify-center gap-3 py-8">
          {loadingMore ? (
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          ) : (
            <button
              onClick={loadMore}
              className="rounded-full border border-white/10 bg-surface px-6 py-2.5 text-sm font-semibold text-white hover:border-accent hover:bg-accent/10"
            >
              {t.loadMore}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
