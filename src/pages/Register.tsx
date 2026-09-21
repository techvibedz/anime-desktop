import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { authErrorKey } from "../lib/authErrors";
import { t } from "../lib/i18n";

export function RegisterPage() {
  const { signUpWithEmail, resendConfirmation } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const errorText = (value: string) =>
    authErrorKey(value) === "unknown" ? value : t.authErrors[authErrorKey(value)];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setMsg(null); setNotice(null); setBusy(true);
    const r = await signUpWithEmail(email, password);
    setBusy(false);
    if (r.error) setErr(errorText(r.error));
    // Supabase reports "success" for an address that already has an account (it
    // won't leak which addresses exist). Saying "check your inbox" to that user
    // left them waiting for an email that never comes.
    else if (r.emailExists) setErr(t.emailAlreadyRegisteredHint);
    else if (r.needsConfirmation) setMsg(t.confirmEmailSent(email));
    else navigate("/");
  }

  async function resend() {
    setNotice(null);
    setBusy(true);
    const { error } = await resendConfirmation(email);
    setBusy(false);
    setNotice(error ? errorText(error) : t.resendConfirmationSent);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg p-6">
      <form onSubmit={submit} className="w-full max-w-sm space-y-5 rounded-2xl border border-white/10 bg-surface p-8 shadow-card">
        <div className="text-center">
          <img src="/logo.png" alt="" className="mx-auto h-14 w-14 rounded-2xl" />
          <h1 className="mt-3 text-2xl font-bold text-white">{t.createAccount}</h1>
        </div>
        <div className="space-y-3">
          <input
            type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
            placeholder={t.email}
            className="w-full rounded-xl border border-white/10 bg-bg px-4 py-3 text-sm text-white placeholder:text-text-muted focus:border-accent focus:outline-none"
          />
          <input
            type="password" required value={password} onChange={(e) => setPassword(e.target.value)}
            placeholder={t.passwordMin8} minLength={8}
            className="w-full rounded-xl border border-white/10 bg-bg px-4 py-3 text-sm text-white placeholder:text-text-muted focus:border-accent focus:outline-none"
          />
        </div>
        {err && <p className="text-sm text-red-400">{err}</p>}
        {msg && <p className="text-sm text-accent">{msg}</p>}
        {msg && (
          <button
            type="button" onClick={resend} disabled={busy}
            className="w-full rounded-lg border border-accent/40 bg-accent/10 py-2 text-xs font-semibold text-accent transition-colors hover:bg-accent/20 disabled:opacity-50"
          >
            {t.resendConfirmation}
          </button>
        )}
        {notice && <p className="text-xs text-accent">{notice}</p>}
        <button
          type="submit" disabled={busy}
          className="w-full rounded-full bg-accent py-3 text-sm font-bold text-black transition-colors hover:bg-accent-bright disabled:opacity-50"
        >
          {busy ? t.loading : t.createAccount}
        </button>
        <p className="text-center text-xs text-text-muted">
          {t.haveAccount}{" "}
          <Link to="/login" className="font-semibold text-accent hover:text-accent-bright">{t.signIn}</Link>
        </p>
      </form>
    </div>
  );
}
