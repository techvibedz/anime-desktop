// Client for the spoiler-safe "رفيق الأنمي" AI companion.
//
// The actual model call lives in the `anime-companion` Supabase Edge Function
// (shared with the mobile app). This wrapper only invokes it and degrades
// gracefully whenever the function (or its AI_* secrets) has not been
// deployed yet — the UI then shows a quiet "not enabled" state.

import { isSupabaseConfigured, supabase } from "./supabase";

export type CompanionRequest = {
  mode: "chat" | "recap";
  animeTitle: string;
  epNum: number;
  totalEpisodes?: number | null;
  question?: string;
  /** Episode label ("الحلقة 5: ...") when known, for a more grounded answer. */
  episodeTitle?: string;
  /** Explicit season/part number parsed from the title or source slug. */
  seasonNumber?: number;
  /** Romaji/English title from the source slug — disambiguates later seasons. */
  altTitle?: string;
  /** Recent turns (oldest→newest) so the companion keeps the thread. */
  history?: { role: "user" | "ai"; text: string }[];
};

export type CompanionResult =
  | { ok: true; answer: string; spoilerBound: number }
  | { ok: false; reason: "offline" | "signin" | "unavailable" | "rate_limited" | "error" };

/** Per-request deadline. The function answers in ~5-10s and stops itself at
 *  ~24s, so this only trips on a dead network. */
const REQUEST_TIMEOUT_MS = 28_000;
/** Whole-call deadline, INCLUDING getSession and supabase-js's own token
 *  lookup (neither is covered by invoke's timeout — a stuck token refresh
 *  could leave the "thinking" bubble spinning forever). */
const TOTAL_DEADLINE_MS = 32_000;

export async function askCompanion(req: CompanionRequest): Promise<CompanionResult> {
  if (!isSupabaseConfigured) return { ok: false, reason: "offline" };
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<CompanionResult>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: "error" }), TOTAL_DEADLINE_MS);
  });
  try {
    const first = await Promise.race([askOnce(req), deadline]);
    // A fast generic failure is usually a transient network/gateway blip:
    // retry once while there's still plenty of time.
    if (!first.ok && first.reason === "error" && Date.now() - startedAt < 6_000) {
      return await Promise.race([askOnce(req), deadline]);
    }
    return first;
  } finally {
    clearTimeout(timer);
  }
}

async function askOnce(req: CompanionRequest): Promise<CompanionResult> {
  try {
    const { data: sessionData } = await supabase.auth.getSession();
    if (!sessionData?.session) return { ok: false, reason: "signin" };

    const { data, error } = await supabase.functions.invoke("anime-companion", {
      body: req,
      // Aborts the underlying request at the deadline (supabase-js clears its
      // own timer), instead of letting it run on after the UI gave up.
      timeout: REQUEST_TIMEOUT_MS,
    });
    if (error) {
      // functions.invoke throws FunctionsHttpError with a fixed message; the
      // real status lives on error.context (a Response). 404 = function not
      // deployed → "unavailable"; anything else is a real failure to retry.
      const status = (error as { context?: { status?: number } })?.context?.status;
      if (status === 404) return { ok: false, reason: "unavailable" };
      return {
        ok: false,
        reason: status === 429 ? "rate_limited" : status === 401 ? "signin" : "error",
      };
    }

    const res = (data ?? {}) as {
      ok?: boolean;
      answer?: string;
      spoilerBound?: number;
      error?: string;
    };
    if (res.ok && res.answer) {
      return { ok: true, answer: res.answer, spoilerBound: res.spoilerBound ?? req.epNum };
    }
    if (res.error === "not_configured") return { ok: false, reason: "unavailable" };
    if (res.error === "rate_limited") return { ok: false, reason: "rate_limited" };
    return { ok: false, reason: "error" };
  } catch {
    return { ok: false, reason: "error" };
  }
}
