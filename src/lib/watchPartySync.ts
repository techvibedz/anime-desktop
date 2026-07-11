// Pure watch-party sync math — no React/router imports so it stays portable
// and unit-testable. The stateful channel + hook live in watchParty.ts.
// (Byte-identical to the mobile app's lib/watchPartySync.ts, which has the
// unit tests; the logic is the shared correctness surface.)

export interface PartyState {
  /** Decoded episode href (same shape as the Watch page's `episode` param). */
  episode: string;
  /** Query params to reopen the episode on a client (up4, img, anime). */
  params: Record<string, string>;
  positionMs: number;
  playing: boolean;
  /** Date.now() at send — clients add transit + elapsed time to compensate. */
  at: number;
}

export const DRIFT_TOLERANCE_MS = 2000; // buffer window — only seek past this

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
  const elapsed = state.playing ? Math.max(0, now - state.at) : 0;
  const expected = state.positionMs + elapsed;
  const shouldSeekTo = Math.abs(localPosMs - expected) > DRIFT_TOLERANCE_MS ? expected : null;
  return { shouldSeekTo, play: state.playing };
}
