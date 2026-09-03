import { createContext, useContext, useEffect, useState, useCallback } from "react";
import type { ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase, isSupabaseConfigured } from "./supabase";

interface AuthState {
  user: User | null;
  session: Session | null;
  loading: boolean;
  ready: boolean;
  isConfigured: boolean;
  authError: string | null;
  clearAuthError: () => void;
  signInWithEmail: (email: string, password: string) => Promise<{ error?: string }>;
  signUpWithEmail: (email: string, password: string) => Promise<{ error?: string; needsConfirmation?: boolean }>;
  signInWithGoogle: () => Promise<{ error?: string }>;
  signOut: () => Promise<void>;
  sendPasswordReset: (email: string) => Promise<{ error?: string }>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const clearAuthError = useCallback(() => setAuthError(null), []);

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setReady(true);
      return;
    }
    supabase.auth.getSession()
      .then(({ data, error }) => {
        setSession(data.session);
        setUser(data.session?.user ?? null);
        if (error) setAuthError(error.message);
      })
      .catch((error) => {
        console.warn("[auth] failed to restore session", error);
        setAuthError(error instanceof Error ? error.message : "Could not restore the saved session.");
      })
      .finally(() => setReady(true));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, sess) => {
      setSession(sess);
      setUser(sess?.user ?? null);
    });

    // OAuth callback handler — fires when the system browser redirects to
    // pantoufa://auth-callback and the main process forwards us the URL.
    const off = window.pantoufa?.onAuthCallback?.(async (url) => {
      try {
        const hash = url.split("#")[1] ?? "";
        const query = url.split("?")[1]?.split("#")[0] ?? "";
        const params = new URLSearchParams(hash || query);
        // Provider/Supabase can bounce back an error instead of a session
        // (e.g. redirect URL not allow-listed, consent denied). Surface it.
        const errDesc = params.get("error_description") || params.get("error");
        if (errDesc) {
          setAuthError(decodeURIComponent(errDesc.replace(/\+/g, " ")));
          return;
        }
        const access_token = params.get("access_token");
        const refresh_token = params.get("refresh_token");
        const code = params.get("code");
        if (access_token && refresh_token) {
          const { error } = await supabase.auth.setSession({ access_token, refresh_token });
          if (error) setAuthError(error.message);
        } else if (code) {
          const { error } = await supabase.auth.exchangeCodeForSession(code);
          if (error) setAuthError(error.message);
        } else {
          setAuthError("Sign-in response was missing its session token.");
        }
      } catch (e) {
        console.warn("[auth] callback handling failed", e);
        setAuthError(e instanceof Error ? e.message : "Google sign-in failed.");
      }
    });

    return () => {
      sub.subscription.unsubscribe();
      off?.();
    };
  }, []);

  const signInWithEmail = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    return { error: error?.message };
  }, []);

  const signUpWithEmail = useCallback(async (email: string, password: string) => {
    const { data, error } = await supabase.auth.signUp({ email: email.trim(), password });
    if (error) return { error: error.message };
    return { needsConfirmation: !data.session };
  }, []);

  const signInWithGoogle = useCallback(async () => {
    setAuthError(null);
    // Ask Supabase for the OAuth URL but DON'T navigate the Electron window
    // there. We open it in the user's system browser and wait for the
    // pantoufa:// custom-protocol callback (wired in main.ts → preload).
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: "pantoufa://auth-callback",
        skipBrowserRedirect: true,
      },
    });
    if (error || !data?.url) return { error: error?.message ?? "Google sign-in failed" };
    const ok = await window.pantoufa?.openExternal?.(data.url);
    if (!ok) return { error: "Could not open the system browser" };
    return {};
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  const sendPasswordReset = useCallback(async (email: string) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim());
    return { error: error?.message };
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        session,
        loading: !ready,
        ready,
        isConfigured: isSupabaseConfigured,
        authError,
        clearAuthError,
        signInWithEmail,
        signUpWithEmail,
        signInWithGoogle,
        signOut,
        sendPasswordReset,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
