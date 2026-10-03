import { Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import { lazy, Suspense, useEffect } from "react";
import { useAuth } from "./lib/auth";
import { invalidateNetworkCaches } from "./lib/api";
import { pullFavoritesFromCloud } from "./lib/favorites";
import { pullHistoryFromCloud } from "./lib/history";
import { pullCompletionFromCloud, CompletionProvider } from "./lib/completion";
import { Layout } from "./components/Layout";
import { HomePage } from "./pages/Home";
import { UpdateBanner } from "./components/UpdateBanner";
import { startPresence, stopPresence } from "./lib/presence";
import { startUsageSession, endUsageSession } from "./lib/usage";
import { startNotificationSync, stopNotificationSync } from "./lib/notifications";
import { setLogUser } from "./lib/remoteLog";
import { normalizePartyCode, takePendingInvite } from "./lib/partyInvite";

// Route-level code splitting. Home stays eager (first paint); everything else
// loads on demand — most importantly Watch, which pulls in hls.js.
const SearchPage = lazy(() => import("./pages/Search").then((m) => ({ default: m.SearchPage })));
const MyListPage = lazy(() => import("./pages/MyList").then((m) => ({ default: m.MyListPage })));
const AnimeDetailPage = lazy(() => import("./pages/AnimeDetail").then((m) => ({ default: m.AnimeDetailPage })));
const WatchPage = lazy(() => import("./pages/Watch").then((m) => ({ default: m.WatchPage })));
const SeeAllPage = lazy(() => import("./pages/SeeAll").then((m) => ({ default: m.SeeAllPage })));
const PopularPage = lazy(() => import("./pages/Popular").then((m) => ({ default: m.PopularPage })));
const SeasonsPage = lazy(() => import("./pages/Seasons").then((m) => ({ default: m.SeasonsPage })));
const UpcomingPage = lazy(() => import("./pages/Upcoming").then((m) => ({ default: m.UpcomingPage })));
const TitlePage = lazy(() => import("./pages/Title").then((m) => ({ default: m.TitlePage })));
const SchedulePage = lazy(() => import("./pages/Schedule").then((m) => ({ default: m.SchedulePage })));
const DownloadsPage = lazy(() => import("./pages/Downloads").then((m) => ({ default: m.DownloadsPage })));
const WatchPartyPage = lazy(() => import("./pages/WatchParty").then((m) => ({ default: m.WatchPartyPage })));
const LoginPage = lazy(() => import("./pages/Login").then((m) => ({ default: m.LoginPage })));
const RegisterPage = lazy(() => import("./pages/Register").then((m) => ({ default: m.RegisterPage })));
const WelcomePage = lazy(() => import("./pages/Welcome").then((m) => ({ default: m.WelcomePage })));
const ForgotPage = lazy(() => import("./pages/Forgot").then((m) => ({ default: m.ForgotPage })));
const NotificationsPage = lazy(() => import("./pages/Notifications").then((m) => ({ default: m.NotificationsPage })));
const ProfilePage = lazy(() => import("./pages/Profile").then((m) => ({ default: m.ProfilePage })));
const SettingsPage = lazy(() => import("./pages/Settings").then((m) => ({ default: m.SettingsPage })));
const NewsPage = lazy(() => import("./pages/News").then((m) => ({ default: m.NewsPage })));
const NewsArticlePage = lazy(() => import("./pages/NewsArticle").then((m) => ({ default: m.NewsArticlePage })));
const ReportPage = lazy(() => import("./pages/Report").then((m) => ({ default: m.ReportPage })));
const ChatPage = lazy(() => import("./pages/Chat").then((m) => ({ default: m.ChatPage })));
const ScraperDebugPage = lazy(() => import("./pages/ScraperDebug").then((m) => ({ default: m.ScraperDebugPage })));
const AdminLivePage = lazy(() => import("./pages/admin/Live").then((m) => ({ default: m.AdminLivePage })));
const AdminUsersPage = lazy(() => import("./pages/admin/Users").then((m) => ({ default: m.AdminUsersPage })));
const AdminUserDetailPage = lazy(() => import("./pages/admin/UserDetail").then((m) => ({ default: m.AdminUserDetailPage })));
const AdminChatsPage = lazy(() => import("./pages/admin/Chats").then((m) => ({ default: m.AdminChatsPage })));
const AdminChatViewPage = lazy(() => import("./pages/admin/ChatView").then((m) => ({ default: m.AdminChatViewPage })));
const AdminLogsPage = lazy(() => import("./pages/admin/Logs").then((m) => ({ default: m.AdminLogsPage })));

// Signed-out users may only see these routes; anything else funnels to Welcome.
const GUEST_PATHS = ["/welcome", "/login", "/register", "/forgot"];

function PageSpinner() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <div className="h-10 w-10 animate-spin rounded-full border-2 border-accent border-t-transparent" />
    </div>
  );
}

export default function App() {
  const { user, ready, isConfigured } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (!ready) return;
    if (!isConfigured) return;
    const path = location.pathname;
    // Admin detail routes carry ids the guest list cannot enumerate — treat
    // every non-auth route as protected.
    const isGuestPath = GUEST_PATHS.includes(path);
    if (!user && !isGuestPath) navigate("/welcome", { replace: true });
    else if (user && isGuestPath) navigate("/", { replace: true });
  }, [user, ready, isConfigured, location.pathname, navigate]);

  useEffect(() => {
    if (user) {
      pullFavoritesFromCloud().catch(() => {});
      pullHistoryFromCloud().catch(() => {});
      pullCompletionFromCloud().catch(() => {});
    }
  }, [user?.id]);

  // Presence + usage + notification sync + remote-log identity, keyed to the
  // signed-in user. Signed out, the notification feed still syncs (scope "all")
  // so the center and unread badge work without an account.
  useEffect(() => {
    setLogUser(user ? { id: user.id, email: user.email ?? undefined } : null);
    startNotificationSync(user?.id);
    if (user) {
      void startPresence(user).catch(() => {});
      void startUsageSession(user).catch(() => {});
    }
    return () => {
      stopNotificationSync();
      void stopPresence().catch(() => {});
      void endUsageSession().catch(() => {});
    };
  }, [user?.id]);

  // OS notification tap → deep-link into the episode (or the center).
  useEffect(() => {
    const off = window.pantoufa?.onNotificationClick?.((data) => {
      const d = (data ?? {}) as { href?: string | null; episode?: number | null };
      if (d.href) {
        const ep = d.episode != null ? `?ep=${d.episode}` : "";
        navigate(`/watch/${encodeURIComponent(d.href)}${ep}`);
      } else {
        navigate("/notifications");
      }
    });
    return off;
  }, [navigate]);

  // A watch-party invite link opened before sign-in is stashed; route into the
  // lobby as soon as a session exists.
  useEffect(() => {
    if (!ready || !user) return;
    let cancelled = false;
    void takePendingInvite().then((raw) => {
      const code = normalizePartyCode(raw);
      if (code && !cancelled) navigate(`/watch-party?join=${code}`);
    });
    return () => {
      cancelled = true;
    };
  }, [ready, user?.id, navigate]);

  // Connection switched: the main process already flushed Chromium's network
  // state. Drop the renderer's negative/empty scrape caches even when the
  // watch screen is not mounted, so a source first queried during the outage
  // isn't remembered as empty; the watch screen's own listener re-runs
  // discovery on top of this.
  useEffect(() => {
    const off = window.pantoufa.onNetworkChanged?.(() => invalidateNetworkCaches());
    return off;
  }, []);

  if (!ready) {
    return (
      <div className="flex h-screen items-center justify-center bg-bg">
        <div className="h-12 w-12 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      </div>
    );
  }

  return (
    <CompletionProvider>
      <Suspense fallback={<PageSpinner />}>
        <Routes>
          <Route path="/welcome" element={<WelcomePage />} />
          <Route path="/forgot" element={<ForgotPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/" element={<Layout />}>
            <Route index element={<HomePage />} />
            <Route path="search" element={<SearchPage />} />
            <Route path="mylist" element={<MyListPage />} />
            <Route path="anime/:id" element={<AnimeDetailPage />} />
            <Route path="watch/:episode" element={<WatchPage />} />
            <Route path="see-all/:section" element={<SeeAllPage />} />
            <Route path="popular/:kind" element={<PopularPage />} />
            <Route path="seasons" element={<SeasonsPage />} />
            <Route path="upcoming" element={<UpcomingPage />} />
            <Route path="title/:id" element={<TitlePage />} />
            <Route path="schedule" element={<SchedulePage />} />
            <Route path="downloads" element={<DownloadsPage />} />
            <Route path="watch-party" element={<WatchPartyPage />} />
            <Route path="notifications" element={<NotificationsPage />} />
            <Route path="profile" element={<ProfilePage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="news" element={<NewsPage />} />
            <Route path="news/:id" element={<NewsArticlePage />} />
            <Route path="report" element={<ReportPage />} />
            <Route path="chat" element={<ChatPage />} />
            <Route path="scraper-debug" element={<ScraperDebugPage />} />
            <Route path="admin/live" element={<AdminLivePage />} />
            <Route path="admin/users" element={<AdminUsersPage />} />
            <Route path="admin/users/:id" element={<AdminUserDetailPage />} />
            <Route path="admin/chats" element={<AdminChatsPage />} />
            <Route path="admin/chats/:id" element={<AdminChatViewPage />} />
            <Route path="admin/logs" element={<AdminLogsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </Suspense>
      <UpdateBanner />
    </CompletionProvider>
  );
}
