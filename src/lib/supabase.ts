import { createClient } from "@supabase/supabase-js";

// Read from Vite env. Set these in a .env file:
//   VITE_SUPABASE_URL=...
//   VITE_SUPABASE_ANON_KEY=...
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY ?? "";

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.warn(
    "[supabase] Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. " +
      "Auth and cloud sync will be disabled.",
  );
}

export const supabase = createClient(
  SUPABASE_URL || "https://placeholder.supabase.co",
  SUPABASE_ANON_KEY || "placeholder-anon-key",
  {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
      // PKCE (not the default implicit flow) for desktop OAuth. Implicit puts
      // the session in the URL *fragment* (#access_token=...), which browsers
      // routinely drop when handing a pantoufa:// custom-scheme URL to the OS,
      // so the app never receives it. PKCE returns ?code=... in the query
      // string instead, which survives the deep-link round-trip; auth.tsx then
      // calls exchangeCodeForSession() using the verifier kept in localStorage.
      flowType: "pkce",
      storage: typeof window !== "undefined" ? window.localStorage : undefined,
    },
  },
);

export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
