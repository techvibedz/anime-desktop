import { Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import { lazy, Suspense, useEffect } from "react";
import { useAuth } from "./lib/auth";
import { pullFavoritesFromCloud } from "./lib/favorites";
import { pullHistoryFromCloud } from "./lib/history";
import { pullCompletionFromCloud, CompletionProvider } from "./lib/completion";
import { Layout } from "./components/Layout";
import { HomePage } from "./pages/Home";
import { UpdateBanner } from "./components/UpdateBanner";

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
    const isAuth = path === "/login" || path === "/register";
    if (!user && !isAuth) navigate("/login", { replace: true });
    else if (user && isAuth) navigate("/", { replace: true });
  }, [user, ready, isConfigured, location.pathname, navigate]);

  useEffect(() => {
    if (user) {
      pullFavoritesFromCloud().catch(() => {});
      pullHistoryFromCloud().catch(() => {});
      pullCompletionFromCloud().catch(() => {});
    }
  }, [user?.id]);

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
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </Suspense>
      <UpdateBanner />
    </CompletionProvider>
  );
}
