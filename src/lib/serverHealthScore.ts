// Pure scoring for crowdsourced server health (no React Native imports, so it
// is unit-testable under tsx). The network layer lives in lib/serverHealth.ts.

export interface HealthStat {
  ok: number;
  fail: number;
  /** Mean time-to-first-frame in ms over successful starts, or null. */
  avgMs: number | null;
  /** Same counters restricted to the last ~3 hours. */
  recentOk: number;
  recentFail: number;
}

export type HealthTier = "fast" | "good" | "unstable" | "unknown";

/** Minimum attempts before an aggregate is trusted for badges/demotion. */
export const HEALTH_MIN_SAMPLES = 6;

export function healthKey(source: string | undefined | null, provider: string | undefined | null): string {
  return `${(source || "unknown").toLowerCase()}|${(provider || "generic").toLowerCase()}`;
}

/**
 * Success probability with a Bayesian prior (70% over 4 virtual attempts) so a
 * provider with 1/1 doesn't outrank one with 95/100. When the last few hours
 * carry enough evidence they dominate — a host that died this afternoon must
 * drop fast even if it was fine this morning.
 */
export function successRate(h: HealthStat | null | undefined): number {
  if (!h) return 0.7;
  const day = (h.ok + 2.8) / (h.ok + h.fail + 4);
  const recentN = h.recentOk + h.recentFail;
  if (recentN < 4) return day;
  const recent = (h.recentOk + 2.8) / (recentN + 4);
  return recent * 0.65 + day * 0.35;
}

export function healthTier(h: HealthStat | null | undefined): HealthTier {
  if (!h || h.ok + h.fail < HEALTH_MIN_SAMPLES) return "unknown";
  const rate = successRate(h);
  if (rate < 0.45) return "unstable";
  if (rate >= 0.8 && h.avgMs != null && h.avgMs <= 4500) return "fast";
  return "good";
}

/**
 * Sort weight: higher is better. Success dominates; speed breaks near-ties.
 * Unknown providers sit at the prior so new hosts aren't buried.
 */
export function healthScore(h: HealthStat | null | undefined): number {
  const rate = successRate(h);
  if (!h || h.avgMs == null || h.ok < 3) return rate;
  // 1.0 at ≤2s, falling to 0.85 at ≥15s.
  const speed = 1 - Math.min(0.15, Math.max(0, (h.avgMs - 2000) / 13000) * 0.15);
  return rate * speed;
}

/** Coarse bucket so tiny score differences never override quality ordering. */
export function healthBucket(h: HealthStat | null | undefined): number {
  return Math.round(healthScore(h) / 0.15);
}

/** The single key that deserves the "fastest now" badge among candidates. */
export function fastestKey(keys: string[], stats: Map<string, HealthStat>): string | null {
  let best: string | null = null;
  let bestMs = Infinity;
  for (const k of keys) {
    const h = stats.get(k);
    if (healthTier(h) !== "fast" || h?.avgMs == null) continue;
    if (h.avgMs < bestMs) {
      bestMs = h.avgMs;
      best = k;
    }
  }
  return best;
}
