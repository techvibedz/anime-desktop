import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useState, useEffect, useRef } from "react";
import { useAuth } from "../lib/auth";
import { clearHomeCache } from "../lib/api";
import { t } from "../lib/i18n";

const tabs = [
  { to: "/", label: t.home, end: true },
  { to: "/search", label: t.search },
  { to: "/mylist", label: t.myList },
];

export function Layout() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [showMenu, setShowMenu] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Force the current page to reload its data: drop the home cache (so it
  // re-scrapes instead of replaying an empty/stale list) and bump a key on
  // the <Outlet> wrapper, which remounts the active page and re-runs its
  // data-fetching effects. Fixes pages that come up blank after a failed
  // first scrape without needing to close and reopen the app.
  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    try { await clearHomeCache(); } catch {}
    setRefreshKey((k) => k + 1);
    // Brief spinner so the click registers visually even when remount is instant.
    setTimeout(() => setRefreshing(false), 600);
  }

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setShowMenu(false);
    }
    window.addEventListener("click", onClick);
    return () => window.removeEventListener("click", onClick);
  }, []);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (q.trim()) navigate(`/search?q=${encodeURIComponent(q.trim())}`);
  }

  return (
    <div className="min-h-screen bg-bg text-text">
      <header className="sticky top-0 z-50 border-b border-white/5 bg-bg/85 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1600px] items-center gap-6 px-6 py-3">
          <Link to="/" className="flex items-center gap-2 font-display text-xl font-extrabold tracking-tight text-white">
            <span className="text-accent">●</span> {t.appName}
          </Link>
          <nav className="flex items-center gap-1">
            {tabs.map((tab) => (
              <NavLink
                key={tab.to}
                to={tab.to}
                end={tab.end}
                className={({ isActive }) =>
                  `rounded-md px-3 py-1.5 text-sm font-medium transition ${
                    isActive ? "bg-white/10 text-white" : "text-text-secondary hover:bg-white/5 hover:text-white"
                  }`
                }
              >
                {tab.label}
              </NavLink>
            ))}
          </nav>
          <form onSubmit={submit} className="ms-auto flex-1 max-w-md">
            <div className="relative">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t.searchPlaceholder}
                className="w-full rounded-full border border-white/10 bg-surface px-4 py-2 pe-9 text-sm placeholder:text-text-muted focus:border-accent focus:outline-none"
              />
              <button type="submit" className="absolute end-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-accent">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.3-4.3" />
                </svg>
              </button>
            </div>
          </form>
          <button
            onClick={refresh}
            disabled={refreshing}
            title={t.refresh}
            aria-label={t.refresh}
            className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-surface text-text-secondary transition hover:bg-white/10 hover:text-white disabled:opacity-60"
          >
            <svg
              width="16" height="16" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              className={refreshing ? "animate-spin" : ""}
            >
              <path d="M23 4v6h-6" />
              <path d="M1 20v-6h6" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
          </button>
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setShowMenu((v) => !v)}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-accent text-sm font-bold text-white"
            >
              {user?.email?.[0]?.toUpperCase() ?? "?"}
            </button>
            {showMenu && (
              <div className="absolute end-0 mt-2 w-56 rounded-lg border border-white/10 bg-surface p-2 shadow-card">
                <p className="px-3 py-2 text-xs text-text-muted truncate">{user?.email ?? t.guest}</p>
                <button
                  onClick={async () => { await signOut(); navigate("/login"); }}
                  className="w-full rounded-md px-3 py-2 text-start text-sm text-white hover:bg-white/5"
                >
                  {t.signOut}
                </button>
              </div>
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1600px] px-6 py-8">
        {/* Bumping refreshKey remounts the active page so its data-fetch effects re-run. */}
        <div key={refreshKey}>
          <Outlet />
        </div>
      </main>
    </div>
  );
}
