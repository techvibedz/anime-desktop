// Watch-party invite helpers + pending invite stash.
//
// A deep link can arrive while the user is signed OUT: the watch-party screen
// stashes the code, the auth flow runs, and after sign-in it routes back into
// /watch-party, which consumes the stash. Memory-first so the common
// same-session trip is synchronous; storage so the code survives an app
// restart between the tap and the sign-in.

import { storage } from "./storage";
import { t } from "./i18n";

// Room-code generator lives with the sync math; re-exported so invite callers
// have a single import surface.
export { genCode } from "./watchPartySync";

/** Where the static "join a party" web page lives (landing/join.html). */
export const PARTY_WEB_URL = "https://pantoufa-join.pages.dev/join";

/** Clickable invite link shared with friends — opens the web join page. */
export function partyInviteLink(code: string): string {
  return `${PARTY_WEB_URL}?code=${code}`;
}

// Unambiguous alphabet (no 0/O/1/I) for spoken/typed room codes.
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4,8}$/;

/**
 * Accepts a raw room code, a deep link (pantoufa://watch-party?code=X), the
 * web invite link, or any pasted text containing one; returns the clean code
 * or null. Used to heal pasted invite links in the join input.
 */
export function normalizePartyCode(input: string | null | undefined): string | null {
  if (!input) return null;
  const raw = String(input).trim().toUpperCase();
  if (CODE_RE.test(raw)) return raw;
  const m = raw.match(/[?&]CODE=([A-Z0-9]{4,8})/);
  if (m && CODE_RE.test(m[1])) return m[1];
  return null;
}

/** WhatsApp/Telegram-style share message: Arabic invite text + web join link. */
export function partyShareText(code: string): string {
  return `${t.wpInviteText(code)}\n${partyInviteLink(code)}`;
}

const KEY = "@wp_pending_invite";
let pending: string | null = null;

/** Stash a code (validated). A null/invalid input clears the stash. */
export function setPendingInvite(raw: string): void {
  pending = normalizePartyCode(raw);
  if (pending) storage.setItem(KEY, pending).catch(() => {});
  else storage.removeItem(KEY).catch(() => {});
}

/** Consume the stored code (memory first, disk fallback). */
export async function takePendingInvite(): Promise<string | null> {
  if (!pending) {
    try {
      const stored = await storage.getItem(KEY);
      if (stored) pending = normalizePartyCode(stored);
    } catch {}
  }
  const code = pending;
  if (code) {
    pending = null;
    storage.removeItem(KEY).catch(() => {});
  }
  return code;
}
