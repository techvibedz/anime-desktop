import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { t } from "../lib/i18n";

export function RegisterPage() {
  const { signUpWithEmail } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setMsg(null); setBusy(true);
    const r = await signUpWithEmail(email, password);
    setBusy(false);
    if (r.error) setErr(r.error);
    else if (r.needsConfirmation) setMsg(t.confirmEmailSent(email));
    else navigate("/");
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg p-6">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-2xl border border-white/10 bg-surface p-8">
        <div className="text-center">
          <h1 className="font-display text-3xl font-extrabold text-white">{t.createAccount}</h1>
        </div>
        <input
          type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
          placeholder={t.email}
          className="w-full rounded-md border border-white/10 bg-bg px-3 py-2.5 text-sm focus:border-accent focus:outline-none"
        />
        <input
          type="password" required value={password} onChange={(e) => setPassword(e.target.value)}
          placeholder={t.passwordMin8} minLength={8}
          className="w-full rounded-md border border-white/10 bg-bg px-3 py-2.5 text-sm focus:border-accent focus:outline-none"
        />
        {err && <p className="text-sm text-accent">{err}</p>}
        {msg && <p className="text-sm text-green">{msg}</p>}
        <button
          type="submit" disabled={busy}
          className="w-full rounded-md bg-accent py-2.5 text-sm font-semibold text-white shadow-glow disabled:opacity-50"
        >
          {busy ? t.loading : t.createAccount}
        </button>
        <p className="text-center text-xs text-text-muted">
          {t.haveAccount}{" "}
          <Link to="/login" className="text-accent hover:underline">{t.signIn}</Link>
        </p>
      </form>
    </div>
  );
}
