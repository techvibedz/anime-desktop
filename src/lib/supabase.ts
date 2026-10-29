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

// auth-js wipes the session on ANY refresh failure it does not class as
// "retryable" — and a non-JSON body (ISP block page, captive portal, CF 429 /
// HTML 500) is classed as fatal, which signed users out at random on flaky
// networks. Only a real GoTrue JSON 4xx (revoked / reused refresh token) may
// end the session; every other failure is reported as a retryable 503 so the
// session is kept and refreshed later. Mirrors mobile lib/supabase.ts.
async function authSafeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const res = await fetch(input, init);
  if (res.ok || !url.includes("/auth/v1/token") || !url.includes("grant_type=refresh_token")) return res;
  const isJson = (res.headers.get("content-type") ?? "").includes("json");
  const genuine = isJson && res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
  if (genuine) return res;
  return new Response(JSON.stringify({ message: `transient refresh failure (${res.status})` }), {
    status: 503,
    headers: { "content-type": "application/json" },
  });
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
    global: { fetch: authSafeFetch },
  },
);

export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

/** The signed-in user from the persisted session — no remote Auth request
 *  (getUser() hits the network on every call and fails offline). */
export async function getSessionUser() {
  const { data } = await supabase.auth.getSession();
  return data.session?.user ?? null;
}
