// Forgot password — desktop port of the mobile app's app/(auth)/forgot.tsx.
// Email → sendPasswordReset → sent confirmation with a link back to /login.

import { useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { authErrorKey } from "../lib/authErrors";
import { t } from "../lib/i18n";

export function ForgotPage() {
  const { sendPasswordReset } = useAuth();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const errorText = (value: string) =>
    authErrorKey(value) === "unknown" ? value : t.authErrors[authErrorKey(value)];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!email.trim()) { setErr(t.emailPasswordRequired); return; }
    setBusy(true);
    try {
      const { error } = await sendPasswordReset(email);
      if (error) setErr(errorText(error));
      else setSent(true);
    } catch (e) {
      setErr(errorText(e instanceof Error ? e.message : ""));
    }
    setBusy(false);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg p-6">
      <form onSubmit={submit} className="w-full max-w-sm space-y-5 rounded-2xl border border-white/10 bg-surface p-8 shadow-card">
        <div className="text-center">
          <img src="./logo.png" alt="" className="mx-auto h-14 w-14 rounded-2xl" />
          <h1 className="mt-3 text-2xl font-bold text-white">{t.forgotTitle}</h1>
          <p className="mt-1 text-sm text-text-secondary">{t.forgotSub}</p>
        </div>
        <input
          type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
          placeholder={t.email} disabled={sent}
          className="w-full rounded-xl border border-white/10 bg-bg px-4 py-3 text-sm text-white placeholder:text-text-muted focus:border-accent focus:outline-none disabled:opacity-60"
        />
        {err && <p className="text-sm text-red-400">{err}</p>}
        {sent && <p className="text-sm text-accent">{t.resetSent}</p>}
        {sent ? (
          <Link
            to="/login"
            className="block w-full rounded-full bg-accent py-3 text-center text-sm font-bold text-black transition-colors hover:bg-accent-bright"
          >
            {t.goToSignIn}
          </Link>
        ) : (
          <button
            type="submit" disabled={busy}
            className="w-full rounded-full bg-accent py-3 text-sm font-bold text-black transition-colors hover:bg-accent-bright disabled:opacity-50"
          >
            {busy ? t.loading : t.sendResetLink}
          </button>
        )}
        <p className="text-center text-xs text-text-muted">
          <Link to="/login" className="font-semibold text-accent hover:text-accent-bright">{t.goToSignIn}</Link>
        </p>
      </form>
    </div>
  );
}
