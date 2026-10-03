// Pure helpers for the player extras (sleep timer + subtitle cycling).
// Framework-free so they can be unit-tested like the rest of lib/.
// Ported verbatim from the mobile app's lib/playerExtras.ts.

export const SLEEP_PRESETS = [15, 30, 45, 60] as const;

/** Cycle the sleep-timer presets: off → 15 → 30 → 45 → 60 → off. */
export function nextSleepPreset(current: number | null): number | null {
  if (current == null) return SLEEP_PRESETS[0];
  const idx = (SLEEP_PRESETS as readonly number[]).indexOf(current);
  if (idx === -1 || idx === SLEEP_PRESETS.length - 1) return null;
  return SLEEP_PRESETS[idx + 1];
}

/** Whole minutes left on a sleep timer (ceil, never negative). */
export function sleepMinutesLeft(endsAt: number, now: number): number {
  return Math.max(0, Math.ceil((endsAt - now) / 60_000));
}

/**
 * Cycle subtitle tracks: 0 → 1 → … → count-1 → off (-1) → 0.
 * A server with no tracks always reports off.
 */
export function cycleSubtitleTrack(current: number, count: number): number {
  if (count <= 0) return -1;
  const next = current + 1;
  return next >= count ? -1 : next;
}

/** Seconds shown in the next-episode countdown card. */
export const NEXT_EPISODE_COUNTDOWN_SECONDS = 10;
