import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useState, useEffect, useRef } from "react";
import { useAuth } from "../lib/auth";
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
  const menuRef = useRef<HTMLDivElement>(null);

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
        <Outlet />
      </main>
    </div>
  );
}
