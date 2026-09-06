// Pure watch-party sync math — no React/React-Native imports so it stays
// unit-testable with plain tsx (see watchParty.test.ts). The stateful channel
// + hook live in watchParty.ts and re-export these.

export interface PartyState {
  /** Decoded episode href (same shape as the watch screen's `episode` param). */
  episode: string;
  /** Nav params to reopen the episode on a client (url4up, anime, img, …). */
  params: Record<string, string>;
  positionMs: number;
  playing: boolean;
  /** Date.now() at send — clients add transit + elapsed time to compensate. */
  at: number;
}

export const DRIFT_TOLERANCE_MS = 2000; // buffer window — only seek past this

// Cap on the sender-clock compensation applied to a broadcast position. Two
// devices with unsynced clocks (manual time, bad NTP) produce a `now - at` of
// minutes; adding that to the expected position made the client seek past the
// drift tolerance on EVERY heartbeat — a perpetual rebuffer storm where the
// video never settles. Transit/processing delay is realistically <1s and the
// drift tolerance already absorbs it, so clamp hard at 1s: legit late delivery
// is still compensated, skewed clocks degrade to "no compensation" (in-sync).
export const MAX_COMPENSATION_MS = 1000;

// Unambiguous alphabet (no 0/O/1/I) for spoken/typed room codes.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function genCode(len = 5): string {
  let out = "";
  for (let i = 0; i < len; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * Given the host's broadcast `state`, the client's local position and `now`,
 * decide whether to seek and what play state to hold. A seek only fires when
 * drift exceeds DRIFT_TOLERANCE_MS so clients aren't constantly correcting.
 */
export function computeSync(
  state: PartyState,
  localPosMs: number,
  now: number,
): { shouldSeekTo: number | null; play: boolean } {
  const elapsed = state.playing ? Math.min(Math.max(0, now - state.at), MAX_COMPENSATION_MS) : 0;
  const expected = state.positionMs + elapsed;
  const shouldSeekTo = Math.abs(localPosMs - expected) > DRIFT_TOLERANCE_MS ? expected : null;
  return { shouldSeekTo, play: state.playing };
}
