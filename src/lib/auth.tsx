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

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setReady(true);
      return;
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setUser(data.session?.user ?? null);
      setReady(true);
    });
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
        const access_token = params.get("access_token");
        const refresh_token = params.get("refresh_token");
        const code = params.get("code");
        if (access_token && refresh_token) {
          await supabase.auth.setSession({ access_token, refresh_token });
        } else if (code) {
          await supabase.auth.exchangeCodeForSession(code);
        }
      } catch (e) {
        console.warn("[auth] callback handling failed", e);
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
