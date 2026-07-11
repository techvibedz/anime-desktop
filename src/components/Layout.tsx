import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useState, useEffect, useRef } from "react";
import { useAuth } from "../lib/auth";
import { clearHomeCache } from "../lib/api";
import { t } from "../lib/i18n";

// Stroke icon set — one visual voice for the whole sidebar.
function Icon({ d, size = 20 }: { d: string; size?: number }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden
    >
      {d.split("|").map((p, i) => <path key={i} d={p} />)}
    </svg>
  );
}

const NAV = [
  { to: "/", label: t.home, end: true, d: "M3 10.5 12 3l9 7.5|M5 9.5V21h14V9.5|M9 21v-6h6v6" },
  { to: "/search", label: t.search, end: false, d: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z|m21 21-4.3-4.3" },
  { to: "/schedule", label: t.scheduleTitle, end: false, d: "M8 2v4|M16 2v4|M3 8h18|M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" },
  { to: "/seasons", label: t.seasonsTitle, end: false, d: "M12 3v2|M12 19v2|M3 12h2|M19 12h2|M5.6 5.6l1.4 1.4|M17 17l1.4 1.4|M5.6 18.4 7 17|M17 7l1.4-1.4|M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z" },
  { to: "/upcoming", label: t.upcomingTitle, end: false, d: "M12 8v4l3 3|M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z" },
  { to: "/downloads", label: t.downloadsTitle, end: false, d: "M12 3v12|m7 10 5 5 5-5|M5 21h14" },
  { to: "/watch-party", label: t.wpTitle, end: false, d: "M16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z|M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z|M2 20c0-2.8 2.7-5 6-5s6 2.2 6 5|M15.5 15.4c2.6.5 4.5 2.4 4.5 4.6" },
  { to: "/mylist", label: t.myList, end: false, d: "M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1Z" },
];

export function Layout() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
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

  return (
    <div className="min-h-screen bg-bg text-text">
      <aside className="fixed inset-y-0 start-0 z-sticky flex w-60 flex-col border-e border-white/5 bg-bg">
        <Link to="/" className="flex items-center gap-3 px-5 pb-6 pt-6">
          <img src="/logo.png" alt="" className="h-9 w-9 rounded-xl" />
          <span className="text-lg font-bold tracking-tight text-white">{t.appName}</span>
        </Link>

        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `group relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors duration-150 ${
                  isActive
                    ? "bg-white/[0.06] text-accent"
                    : "text-text-muted hover:bg-white/[0.04] hover:text-white"
                }`
              }
            >
              {({ isActive }) => (
                <>
                  {isActive && (
                    <span className="absolute inset-y-2 start-0 w-0.5 rounded-full bg-accent" aria-hidden />
                  )}
                  <Icon d={item.d} />
                  {item.label}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="space-y-1 border-t border-white/5 p-3">
          <button
            onClick={refresh}
            disabled={refreshing}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-text-muted transition-colors hover:bg-white/[0.04] hover:text-white disabled:opacity-60"
          >
            <svg
              width="20" height="20" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
              className={refreshing ? "animate-spin" : ""}
            >
              <path d="M23 4v6h-6" />
              <path d="M1 20v-6h6" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
            {t.refresh}
          </button>

          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setShowMenu((v) => !v)}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-start transition-colors hover:bg-white/[0.04]"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-bold text-black">
                {user?.email?.[0]?.toUpperCase() ?? "?"}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs text-text-secondary" dir="ltr">
                  {user?.email ?? t.guest}
                </span>
              </span>
            </button>
            {showMenu && (
              <div className="absolute bottom-full start-0 z-modal mb-2 w-full rounded-xl border border-white/10 bg-raised p-1.5 shadow-card">
                <button
                  onClick={async () => { await signOut(); navigate("/login"); }}
                  className="w-full rounded-lg px-3 py-2 text-start text-sm text-white hover:bg-white/5"
                >
                  {t.signOut}
                </button>
              </div>
            )}
          </div>
        </div>
      </aside>

      <main className="min-h-screen ps-60">
        <div className="mx-auto max-w-[1700px] px-8 py-7">
          {/* Bumping refreshKey remounts the active page so its data-fetch effects re-run. */}
          <div key={refreshKey}>
            <Outlet />
          </div>
        </div>
      </main>
    </div>
  );
}
