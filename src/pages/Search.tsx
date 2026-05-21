import { useEffect, useState, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { searchAnime, type SearchResult } from "../lib/api";
import { AnimeCard } from "../components/AnimeCard";
import { Shimmer } from "../components/Shimmer";
import { t } from "../lib/i18n";

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const initial = params.get("q") ?? "";
  const [q, setQ] = useState(initial);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqId = useRef(0);

  useEffect(() => {
    const term = (params.get("q") ?? "").trim();
    if (!term) { setResults([]); return; }
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    searchAnime(term)
      .then((r) => {
        if (id !== reqId.current) return;
        setResults(r.data.results);
      })
      .catch((e) => { if (id === reqId.current) setError(e?.message ?? t.failedToLoad); })
      .finally(() => { if (id === reqId.current) setLoading(false); });
  }, [params]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setParams(q.trim() ? { q: q.trim() } : {});
  }

  return (
    <div className="space-y-6">
      <form onSubmit={submit} className="flex gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
          placeholder={t.searchPlaceholder}
          className="flex-1 rounded-full border border-white/10 bg-surface px-5 py-3 text-base placeholder:text-text-muted focus:border-accent focus:outline-none"
        />
        <button
          type="submit"
          className="rounded-full bg-accent px-6 py-3 text-sm font-semibold text-white shadow-glow"
        >
          {t.search}
        </button>
      </form>

      {error && <p className="text-accent">{error}</p>}

      {loading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {Array.from({ length: 12 }).map((_, i) => <Shimmer key={i} className="aspect-[2/3]" />)}
        </div>
      ) : results.length === 0 && params.get("q") ? (
        <p className="text-center text-text-secondary">{t.noResults}</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {results.map((it) => <AnimeCard key={it.href} item={it} />)}
        </div>
      )}
    </div>
  );
}
