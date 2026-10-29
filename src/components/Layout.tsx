import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useState, useEffect, useRef, type FormEvent } from "react";
import { useAuth } from "../lib/auth";
import { clearHomeCache } from "../lib/api";
import { getUnreadCount, subscribeNotifications } from "../lib/notifications";
import { isAdmin } from "../lib/presence";
import { useOnlineStatus } from "../lib/net";
import { t } from "../lib/i18n";

// Stroke icon set — one visual voice for the whole shell.
export function Icon({ d, size = 20, stroke = 1.8 }: { d: string; size?: number; stroke?: number }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden
    >
      {d.split("|").map((p, i) => <path key={i} d={p} />)}
    </svg>
  );
}

const ICONS = {
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z|m21 21-4.3-4.3",
  bell: "M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8|M10.5 21a1.5 1.5 0 0 0 3 0",
  refresh: "M21 12a9 9 0 0 1-15.5 6.2L3 16|M3 12a9 9 0 0 1 15.5-6.2L21 8|M21 3v5h-5|M3 21v-5h5",
  back: "m9 18 6-6-6-6",
  collapse: "M3 5h18|M3 12h18|M3 19h18",
};

type NavEntry = { to: string; label: string; end?: boolean; d: string; badge?: boolean };

const NAV_BROWSE: NavEntry[] = [
  { to: "/", label: t.home, end: true, d: "M3 10.5 12 3l9 7.5|M5 9.5V21h14V9.5|M9 21v-6h6v6" },
  { to: "/search", label: t.search, d: ICONS.search },
  { to: "/schedule", label: t.scheduleTitle, d: "M8 2v4|M16 2v4|M3 8h18|M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" },
  { to: "/seasons", label: t.seasonsTitle, d: "M12 3v2|M12 19v2|M3 12h2|M19 12h2|M5.6 5.6l1.4 1.4|M17 17l1.4 1.4|M5.6 18.4 7 17|M17 7l1.4-1.4|M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z" },
  { to: "/upcoming", label: t.upcomingTitle, d: "M12 8v4l3 3|M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z" },
  { to: "/manga", label: t.mangaTab, d: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20|M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z|M9 7h7|M9 11h5" },
];

const NAV_LIBRARY: NavEntry[] = [
  { to: "/mylist", label: t.myList, d: "M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1Z" },
  { to: "/downloads", label: t.downloadsTitle, d: "M12 3v12|m7 10 5 5 5-5|M5 21h14" },
  { to: "/watch-party", label: t.wpTitle, d: "M16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z|M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z|M2 20c0-2.8 2.7-5 6-5s6 2.2 6 5|M15.5 15.4c2.6.5 4.5 2.4 4.5 4.6" },
  { to: "/news", label: t.newsTitle, d: "M4 4h16v16H4z|M8 8h8|M8 12h8|M8 16h5" },
];

const NAV_ACCOUNT: NavEntry[] = [
  { to: "/notifications", label: t.notifications, badge: true, d: ICONS.bell },
  { to: "/chat", label: t.chatUserThreadTitle, d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" },
  { to: "/report", label: t.reportTitle, d: "M12 9v4|M12 17h.01|M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" },
  { to: "/settings", label: t.settingsTitle, d: "M4 21v-7|M4 10V3|M12 21v-9|M12 8V3|M20 21v-5|M20 12V3|M1 14h6|M9 8h6|M17 16h6" },
];

const NAV_ADMIN: NavEntry[] = [
  { to: "/admin/live", label: t.liveUsersTitle, d: "M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z|M8.5 8.5a5 5 0 0 0 0 7|M15.5 15.5a5 5 0 0 0 0-7|M5.5 5.5a9 9 0 0 0 0 13|M18.5 18.5a9 9 0 0 0 0-13" },
  { to: "/admin/users", label: t.usersTitle, d: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2|M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z|M23 21v-2a4 4 0 0 0-3-3.87|M16 3.13a4 4 0 0 1 0 7.75" },
  { to: "/admin/chats", label: t.chatAdminInboxTitle, d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" },
  { to: "/admin/logs", label: t.logsTitle, d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z|M14 2v6h6|M8 13h8|M8 17h8" },
];

const COLLAPSE_KEY = "@sidebar_collapsed_v1";

function NavItem({ item, unread, collapsed }: { item: NavEntry; unread: number; collapsed: boolean }) {
  return (
    <NavLink
      to={item.to}
      end={item.end}
      title={collapsed ? item.label : undefined}
      className={({ isActive }) =>
        `group relative flex items-center gap-3 rounded-control py-2.5 text-[14px] font-semibold transition-colors duration-150 ${
          collapsed ? "justify-center px-0" : "px-3"
        } ${
          isActive
            ? "bg-accent/[0.12] text-white"
            : "text-text-muted hover:bg-white/[0.05] hover:text-white"
        }`
      }
    >
      {({ isActive }) => (
        <>
          <span className={`relative flex shrink-0 ${isActive ? "text-accent" : ""}`}>
            <Icon d={item.d} />
            {item.badge && unread > 0 && collapsed && (
              <span className="absolute -end-1 -top-1 h-2 w-2 rounded-full bg-mint" aria-hidden />
            )}
          </span>
          {!collapsed && <span className="min-w-0 flex-1 truncate">{item.label}</span>}
          {!collapsed && item.badge && unread > 0 && (
            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-mint px-1.5 text-[10px] font-bold text-on-accent">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </>
      )}
    </NavLink>
  );
}

function NavGroup({ label, items, unread, collapsed }: { label: string; items: NavEntry[]; unread: number; collapsed: boolean }) {
  return (
    <div className="space-y-0.5">
      {collapsed ? (
        <div className="mx-auto my-2 h-px w-8 bg-white/[0.06]" />
      ) : (
        <p className="px-3 pb-1.5 pt-4 text-[11px] font-bold tracking-wide text-text-muted/70">{label}</p>
      )}
      {items.map((item) => (
        <NavItem key={item.to} item={item} unread={unread} collapsed={collapsed} />
      ))}
    </div>
  );
}

// Top-level routes have no "back"; everything else gets one, since the app has
// no browser chrome to go back with.
const ROOT_PATHS = new Set(["/", "/search", "/schedule", "/seasons", "/upcoming", "/manga", "/mylist", "/downloads", "/watch-party", "/news", "/notifications", "/chat", "/report", "/settings", "/profile"]);

export function Layout() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [showMenu, setShowMenu] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [unread, setUnread] = useState(0);
  const [scrolled, setScrolled] = useState(false);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === "1"; } catch { return false; }
  });
  const menuRef = useRef<HTMLDivElement>(null);
  const { online } = useOnlineStatus();
  const admin = isAdmin(user?.email);
  const path = location.pathname;
  // Manga pages paint their own paper canvas edge to edge, with their own chrome.
  const manga = path.startsWith("/manga");
  const onSearch = path === "/search";
  const canGoBack = !ROOT_PATHS.has(path);

  useEffect(() => {
    try { localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0"); } catch {}
  }, [collapsed]);

  // Unread notification badge — re-renders whenever the feed changes.
  useEffect(() => {
    let alive = true;
    const load = () => {
      void getUnreadCount().then((n) => {
        if (alive) setUnread(n);
      });
    };
    load();
    const off = subscribeNotifications(load);
    return () => {
      alive = false;
      off();
    };
  }, []);

  // Top bar: transparent over hero art, solid once the page scrolls.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // A route change starts at the top (React Router keeps the old offset).
  useEffect(() => {
    if (!path.startsWith("/watch")) window.scrollTo({ top: 0 });
    setShowMenu(false);
  }, [path]);

  // Ctrl/Cmd+K or "/" focuses search from anywhere.
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if ((e.key === "k" && (e.ctrlKey || e.metaKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        if (onSearch) (document.querySelector("[data-search-input]") as HTMLInputElement | null)?.focus();
        else searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSearch]);

  // Force the current page to reload its data: drop the home cache (so it
  // re-scrapes instead of replaying an empty/stale list) and remount the
  // active page so its data-fetching effects re-run.
  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    try { await clearHomeCache(); } catch {}
    setRefreshKey((k) => k + 1);
    setTimeout(() => setRefreshing(false), 600);
  }

  function submitSearch(e: FormEvent) {
    e.preventDefault();
    const q = query.trim();
    navigate(q ? `/search?q=${encodeURIComponent(q)}` : "/search");
    setQuery("");
    searchRef.current?.blur();
  }

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setShowMenu(false);
    }
    window.addEventListener("click", onClick);
    return () => window.removeEventListener("click", onClick);
  }, []);

  const sidebarW = collapsed ? "w-[76px]" : "w-64";
  const mainPs = collapsed ? "ps-[76px]" : "ps-64";
  const avatar = user?.user_metadata?.avatar_url as string | undefined;
  const initial = user?.email?.[0]?.toUpperCase() ?? "?";

  return (
    <div className="min-h-screen bg-bg text-text">
      <aside className={`fixed inset-y-0 start-0 z-sticky flex ${sidebarW} flex-col border-e border-white/[0.05] bg-bg-deep transition-[width] duration-200`}>
        <div className={`flex h-16 shrink-0 items-center ${collapsed ? "justify-center" : "justify-between px-4"}`}>
          {!collapsed && (
            <Link to="/" className="flex items-center gap-2.5">
              <img src="./logo.png" alt="" className="h-8 w-8 rounded-[10px]" />
              <span className="text-[19px] font-extrabold tracking-tight text-white">{t.appName}</span>
            </Link>
          )}
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            aria-label={t.menu}
            title={t.menu}
            className="flex h-9 w-9 items-center justify-center rounded-control text-text-muted transition-colors hover:bg-white/[0.06] hover:text-white"
          >
            <Icon d={ICONS.collapse} size={18} />
          </button>
        </div>

        <nav className={`no-scrollbar flex-1 overflow-y-auto pb-4 ${collapsed ? "px-3" : "px-3"}`}>
          <NavGroup label={t.navBrowse} items={NAV_BROWSE} unread={unread} collapsed={collapsed} />
          <NavGroup label={t.navLibrary} items={NAV_LIBRARY} unread={unread} collapsed={collapsed} />
          <NavGroup label={t.navAccount} items={NAV_ACCOUNT} unread={unread} collapsed={collapsed} />
          {admin && <NavGroup label={t.navAdmin} items={NAV_ADMIN} unread={unread} collapsed={collapsed} />}
        </nav>
      </aside>

      <main className={`min-h-screen ${mainPs} transition-[padding] duration-200 ${manga ? "bg-m-paper" : ""}`}>
        {!manga && (
          <header
            className={`sticky top-0 z-sticky -mb-16 flex h-16 items-center gap-3 px-8 transition-colors duration-200 ${
              scrolled ? "border-b border-white/[0.06] bg-bg/[0.97] shadow-[0_8px_24px_-12px_rgba(0,0,0,0.8)]" : "bg-gradient-to-b from-bg/80 to-transparent"
            }`}
          >
            {canGoBack && (
              <button
                type="button"
                onClick={() => (window.history.length > 1 ? navigate(-1) : navigate("/"))}
                aria-label={t.back}
                title={t.back}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-white transition-colors hover:bg-white/[0.12]"
              >
                <Icon d={ICONS.back} size={18} stroke={2.2} />
              </button>
            )}

            {!onSearch && (
              <form onSubmit={submitSearch} className="relative w-full max-w-md">
                <span className="pointer-events-none absolute inset-y-0 start-3.5 flex items-center text-text-muted">
                  <Icon d={ICONS.search} size={17} />
                </span>
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t.searchPlaceholderShort}
                  aria-label={t.search}
                  className="h-10 w-full rounded-full border border-white/[0.08] bg-white/[0.06] pe-14 ps-10 text-sm text-white outline-none backdrop-blur-md transition-colors placeholder:text-text-muted focus:border-accent/60 focus:bg-black/40"
                />
                <kbd className="pointer-events-none absolute inset-y-0 end-3 my-auto flex h-6 items-center rounded-md border border-white/10 px-1.5 font-display text-[10px] text-text-muted">
                  Ctrl K
                </kbd>
              </form>
            )}

            <div className="ms-auto flex items-center gap-2">
              <button
                type="button"
                onClick={refresh}
                disabled={refreshing}
                aria-label={t.refresh}
                title={t.refresh}
                className="flex h-10 w-10 items-center justify-center rounded-full bg-white/[0.06] text-white transition-colors hover:bg-white/[0.12] disabled:opacity-60"
              >
                <span className={refreshing ? "animate-spin" : ""}><Icon d={ICONS.refresh} size={18} /></span>
              </button>
              <Link
                to="/notifications"
                aria-label={t.notifications}
                title={t.notifications}
                className="relative flex h-10 w-10 items-center justify-center rounded-full bg-white/[0.06] text-white transition-colors hover:bg-white/[0.12]"
              >
                <Icon d={ICONS.bell} size={18} />
                {unread > 0 && (
                  <span className="absolute -end-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-mint px-1 text-[10px] font-bold text-on-accent">
                    {unread > 9 ? "9+" : unread}
                  </span>
                )}
              </Link>

              <div className="relative" ref={menuRef}>
                <button
                  type="button"
                  onClick={() => setShowMenu((v) => !v)}
                  aria-label={t.profileTitle}
                  className="flex h-10 items-center gap-2 rounded-full bg-white/[0.06] p-1 pe-1 ps-1 transition-colors hover:bg-white/[0.12]"
                >
                  <span className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full bg-accent text-sm font-bold text-on-accent">
                    {avatar ? <img src={avatar} alt="" className="h-8 w-8 object-cover" /> : initial}
                  </span>
                </button>
                {showMenu && (
                  <div className="absolute end-0 top-full z-modal mt-2 w-64 animate-sheetUp overflow-hidden rounded-card border border-white/[0.08] bg-surface p-1.5 shadow-lift">
                    <div className="px-3 pb-2 pt-2.5">
                      <p className="truncate text-xs text-text-muted" dir="ltr">{user?.email ?? t.guest}</p>
                    </div>
                    <div className="my-1 h-px bg-white/[0.06]" />
                    {[
                      { to: "/profile", label: t.profileTitle },
                      { to: "/settings", label: t.settingsTitle },
                      { to: "/downloads", label: t.downloadsTitle },
                    ].map((item) => (
                      <Link
                        key={item.to}
                        to={item.to}
                        onClick={() => setShowMenu(false)}
                        className="block rounded-[10px] px-3 py-2.5 text-start text-sm font-semibold text-white hover:bg-white/[0.06]"
                      >
                        {item.label}
                      </Link>
                    ))}
                    {user && (
                      <button
                        type="button"
                        onClick={async () => { setShowMenu(false); await signOut(); navigate("/welcome"); }}
                        className="w-full rounded-[10px] px-3 py-2.5 text-start text-sm font-semibold text-danger hover:bg-danger/10"
                      >
                        {t.signOut}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </header>
        )}

        <div className={`mx-auto max-w-[1760px] px-8 pb-12 ${manga ? "py-7" : "pt-[92px]"}`}>
          {online === false && (
            <div className="mb-5 flex items-center gap-3 rounded-card border border-gold/25 bg-gold/[0.08] px-4 py-3 text-sm font-semibold text-gold">
              <span className="h-2 w-2 shrink-0 rounded-full bg-gold" aria-hidden />
              {t.offlineNotice}
            </div>
          )}
          {/* Bumping refreshKey remounts the active page so its data-fetch effects re-run. */}
          <div key={refreshKey}>
            <Outlet />
          </div>
        </div>
      </main>
    </div>
  );
}
