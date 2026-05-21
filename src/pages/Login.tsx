import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { t } from "../lib/i18n";

export function LoginPage() {
  const { signInWithEmail, signInWithGoogle, isConfigured } = useAuth();
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
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-2xl border border-white/10 bg-surface p-8">
        <div className="text-center">
          <h1 className="font-display text-3xl font-extrabold text-white">{t.appName}</h1>
          <p className="mt-1 text-sm text-text-secondary">{t.welcomeBack}</p>
        </div>
        <input
          type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
          placeholder={t.email}
          className="w-full rounded-md border border-white/10 bg-bg px-3 py-2.5 text-sm focus:border-accent focus:outline-none"
        />
        <input
          type="password" required value={password} onChange={(e) => setPassword(e.target.value)}
          placeholder={t.password}
          className="w-full rounded-md border border-white/10 bg-bg px-3 py-2.5 text-sm focus:border-accent focus:outline-none"
        />
        {err && <p className="text-sm text-accent">{err}</p>}
        <button
          type="submit" disabled={busy}
          className="w-full rounded-md bg-accent py-2.5 text-sm font-semibold text-white shadow-glow disabled:opacity-50"
        >
          {busy ? t.loading : t.signIn}
        </button>
        <button
          type="button" onClick={() => signInWithGoogle()}
          className="w-full rounded-md border border-white/10 bg-bg py-2.5 text-sm font-medium text-white hover:bg-white/5"
        >
          {t.continueWithGoogle}
        </button>
        <p className="text-center text-xs text-text-muted">
          {t.noAccount}{" "}
          <Link to="/register" className="text-accent hover:underline">{t.createAccount}</Link>
        </p>
      </form>
    </div>
  );
}
