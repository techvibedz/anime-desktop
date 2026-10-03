// Welcome — desktop port of the mobile app's app/(auth)/welcome.tsx. Brand
// landing with the three feature rows and the two auth CTAs (register / login).

import { Link } from "react-router-dom";
import { t } from "../lib/i18n";

const FEATURES: { d: string; text: string }[] = [
  { d: "M20 17.6A4.4 4.4 0 0 0 17.5 10h-1.3A7 7 0 1 0 5 16.7|m9 14 2.5 2.5L16 12", text: t.feature1 },
  { d: "M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8Z", text: t.feature2 },
  { d: "M12 3 5 6v6c0 4.4 3 8.4 7 9.4 4-1 7-5 7-9.4V6l-7-3Z|m9 12 2 2 4-4", text: t.feature3 },
];

export function WelcomePage() {
  return (
    <div dir="rtl" className="flex min-h-screen items-center justify-center bg-bg p-6">
      <div className="w-full max-w-sm space-y-6 rounded-2xl border border-white/10 bg-surface p-8 shadow-card">
        <div className="text-center">
          <img src="./logo.png" alt="" className="mx-auto h-14 w-14 rounded-2xl" />
          <h1 className="mt-3 text-2xl font-bold text-white">{t.appName}</h1>
          <p className="mt-1 text-sm text-text-secondary">{t.welcomeTagline}</p>
        </div>

        <div className="border-y border-white/5">
          {FEATURES.map((f, i) => (
            <div key={i} className="flex items-center gap-3 py-3.5">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-bg text-accent">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  {f.d.split("|").map((p, j) => <path key={j} d={p} />)}
                </svg>
              </span>
              <span className="min-w-0 flex-1 text-sm leading-6 text-text-secondary">{f.text}</span>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-green-400" aria-hidden>
                <path d="m5 13 4 4L19 7" />
              </svg>
            </div>
          ))}
        </div>

        <div className="space-y-3">
          <Link
            to="/register"
            className="block w-full rounded-full bg-accent py-3 text-center text-sm font-bold text-black transition-colors hover:bg-accent-bright"
          >
            {t.ctaCreate}
          </Link>
          <Link
            to="/login"
            className="block w-full rounded-full border border-white/10 bg-white/5 py-3 text-center text-sm font-medium text-white transition-colors hover:bg-white/10"
          >
            {t.ctaHaveAccount}
          </Link>
        </div>
      </div>
    </div>
  );
}
