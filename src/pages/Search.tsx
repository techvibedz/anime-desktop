import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { searchAnimeStream, type SearchResult } from "../lib/api";
import { animeTitleKey } from "../lib/history";
import { AnimeCard } from "../components/AnimeCard";
import { Shimmer } from "../components/Shimmer";
import { t } from "../lib/i18n";

// Debounce the live search so each keystroke doesn't fire a (networked) query.
const DEBOUNCE_MS = 350;
// Short queries match far too much and feel noisy — wait for a 2nd char.
const MIN_QUERY = 2;

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Race guard: each search bumps reqId; stale callbacks whose id no longer
  // matches are dropped so a slow witanime result can't clobber a newer query.
  const reqId = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runSearch = useCallback((term: string) => {
    const id = ++reqId.current;
    if (!term) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    searchAnimeStream(term, (partial, phase) => {
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

  // Pull ?q= into the input when it changes externally (deep link, back/forward).
  // Typing updates `q` directly, so this only fires on real URL changes — no loop.
  useEffect(() => {
    const urlQ = params.get("q") ?? "";
    setQ((cur) => (cur === urlQ ? cur : urlQ));
  }, [params]);

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

  const searched = !!params.get("q") || q.trim().length >= MIN_QUERY;

  return (
    <div className="space-y-6">
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

      {error && <p className="text-accent">{error}</p>}

      {loading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {Array.from({ length: 12 }).map((_, i) => <Shimmer key={i} className="aspect-[2/3]" />)}
        </div>
      ) : results.length === 0 && searched ? (
        <p className="text-center text-text-secondary">{t.noResults}</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {results.map((it) => <AnimeCard key={animeTitleKey(it.title) || it.href} item={it} />)}
        </div>
      )}
    </div>
  );
}
