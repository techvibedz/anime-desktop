import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./lib/auth";
import "./global.css";

// NOTE: StrictMode is intentionally disabled. It double-invokes effects
// in dev, which doubles every scraper job (one extraction → two BrowserWindow
// loads competing for slots and producing different tokens). The caches in
// lib/api.ts already coalesce duplicate calls, but skipping StrictMode also
// removes the visible flicker on Watch.tsx.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <HashRouter>
    <AuthProvider>
      <App />
    </AuthProvider>
  </HashRouter>,
);
