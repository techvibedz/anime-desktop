import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { t } from "../lib/i18n";

export function LoginPage() {
  const { signInWithEmail, signInWithGoogle, isConfigured, authError } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    const { error } = await signInWithEmail(email, password);
    setBusy(false);
    if (error) setErr(error);
    else navigate("/");
  }

  if (!isConfigured) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg p-6">
        <p className="max-w-md text-center text-text-secondary">{t.authNotConfigured}</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg p-6">
      <form onSubmit={submit} className="w-full max-w-sm space-y-5 rounded-2xl border border-white/10 bg-surface p-8 shadow-card">
        <div className="text-center">
          <img src="/logo.png" alt="" className="mx-auto h-14 w-14 rounded-2xl" />
          <h1 className="mt-3 text-2xl font-bold text-white">{t.welcomeBack}</h1>
          <p className="mt-1 text-sm text-text-secondary">{t.loginSub}</p>
        </div>
        <div className="space-y-3">
          <input
            type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
            placeholder={t.email}
            className="w-full rounded-xl border border-white/10 bg-bg px-4 py-3 text-sm text-white placeholder:text-text-muted focus:border-accent focus:outline-none"
          />
          <input
            type="password" required value={password} onChange={(e) => setPassword(e.target.value)}
            placeholder={t.password}
            className="w-full rounded-xl border border-white/10 bg-bg px-4 py-3 text-sm text-white placeholder:text-text-muted focus:border-accent focus:outline-none"
          />
        </div>
        {(err || authError) && <p className="text-sm text-red-400">{err || authError}</p>}
        <button
          type="submit" disabled={busy}
          className="w-full rounded-full bg-accent py-3 text-sm font-bold text-black transition-colors hover:bg-accent-bright disabled:opacity-50"
        >
          {busy ? t.loading : t.signIn}
        </button>
        <div className="flex items-center gap-3">
          <span className="h-px flex-1 bg-white/10" />
          <span className="text-xs text-text-muted">{t.or}</span>
          <span className="h-px flex-1 bg-white/10" />
        </div>
        <button
          type="button" onClick={() => signInWithGoogle()}
          className="w-full rounded-full border border-white/10 bg-white/5 py-3 text-sm font-medium text-white transition-colors hover:bg-white/10"
        >
          {t.continueWithGoogle}
        </button>
        <p className="text-center text-xs text-text-muted">
          {t.noAccount}{" "}
          <Link to="/register" className="font-semibold text-accent hover:text-accent-bright">{t.createAccount}</Link>
        </p>
      </form>
    </div>
  );
}
