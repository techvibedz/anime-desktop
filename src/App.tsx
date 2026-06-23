import { Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useEffect } from "react";
import { useAuth } from "./lib/auth";
import { pullFavoritesFromCloud } from "./lib/favorites";
import { pullHistoryFromCloud } from "./lib/history";
import { pullCompletionFromCloud, CompletionProvider } from "./lib/completion";
import { Layout } from "./components/Layout";
import { HomePage } from "./pages/Home";
import { SearchPage } from "./pages/Search";
import { MyListPage } from "./pages/MyList";
import { AnimeDetailPage } from "./pages/AnimeDetail";
import { WatchPage } from "./pages/Watch";
import { SeeAllPage } from "./pages/SeeAll";
import { PopularPage } from "./pages/Popular";
import { SeasonsPage } from "./pages/Seasons";
import { UpcomingPage } from "./pages/Upcoming";
import { TitlePage } from "./pages/Title";
import { SchedulePage } from "./pages/Schedule";
import { DownloadsPage } from "./pages/Downloads";
import { LoginPage } from "./pages/Login";
import { RegisterPage } from "./pages/Register";
import { UpdateBanner } from "./components/UpdateBanner";

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
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      <UpdateBanner />
    </CompletionProvider>
  );
}
