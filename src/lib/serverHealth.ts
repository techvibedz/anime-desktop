// Crowdsourced server health.
//
// Every device reports, once per server attempt, whether the server it picked
// actually started playing and how long it took (lib → report_server_health
// RPC → hourly buckets in Supabase, no per-user rows). Every device reads the
// last 24h aggregate back, so a host that is dead TODAY sinks to the bottom of
// the picker for everyone and the fastest working one is badged first —
// without anyone tapping through dead uploads first.
//
// Pure scoring lives at the top so it is unit-testable; the network layer
// never throws and never blocks playback.

import { storage as AsyncStorage } from "./storage";
import { isSupabaseConfigured, supabase } from "./supabase";

import { healthKey, type HealthStat } from "./serverHealthScore";
export * from "./serverHealthScore";

/* ── Network layer ─────────────────────────────────────────────────────── */

const CACHE_KEY = "@server_health_v1";
const TTL_MS = 15 * 60 * 1000;
let memo: { at: number; stats: Map<string, HealthStat> } | null = null;
let inflight: Promise<Map<string, HealthStat>> | null = null;

function toMap(rows: unknown): Map<string, HealthStat> {
  const m = new Map<string, HealthStat>();
  if (!Array.isArray(rows)) return m;
  for (const r of rows as Record<string, unknown>[]) {
    const source = typeof r.source === "string" ? r.source : "";
    const provider = typeof r.provider === "string" ? r.provider : "";
    if (!source || !provider) continue;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    m.set(healthKey(source, provider), {
      ok: num(r.ok),
      fail: num(r.fail),
      avgMs: typeof r.avg_ms === "number" ? r.avg_ms : null,
      recentOk: num(r.recent_ok),
      recentFail: num(r.recent_fail),
    });
  }
  return m;
}

/** Cached aggregate (≤15 min old). Resolves to an empty map on any failure. */
export function getServerHealth(): Promise<Map<string, HealthStat>> {
  if (memo && Date.now() - memo.at < TTL_MS) return Promise.resolve(memo.stats);
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      if (!memo) {
        // Disk copy first so the picker can rank instantly after a cold start.
        const raw = await AsyncStorage.getItem(CACHE_KEY).catch(() => null);
        if (raw) {
          const parsed = JSON.parse(raw) as { at: number; rows: unknown };
          memo = { at: parsed.at, stats: toMap(parsed.rows) };
          if (Date.now() - parsed.at < TTL_MS) return memo.stats;
        }
      }
      if (!isSupabaseConfigured) return memo?.stats ?? new Map();
      const { data, error } = await supabase.rpc("get_server_health");
      if (error || !Array.isArray(data)) return memo?.stats ?? new Map();
      memo = { at: Date.now(), stats: toMap(data) };
      AsyncStorage.setItem(CACHE_KEY, JSON.stringify({ at: memo.at, rows: data })).catch(() => {});
      return memo.stats;
    } catch {
      return memo?.stats ?? new Map();
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Synchronous peek for first render (may be stale or empty). */
export function peekServerHealth(): Map<string, HealthStat> {
  return memo?.stats ?? new Map();
}

const reported = new Set<string>();

/**
 * Report one attempt's outcome. `attemptId` de-dupes so a re-render or a
 * second progress tick can never double-count the same attempt.
 */
export function reportServerResult(opts: {
  attemptId: string;
  source: string | undefined;
  provider: string | undefined;
  ok: boolean;
  startMs?: number | null;
}): void {
  if (!isSupabaseConfigured) return;
  if (reported.has(opts.attemptId)) return;
  reported.add(opts.attemptId);
  if (reported.size > 500) reported.clear();
  const source = (opts.source || "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32);
  const provider = (opts.provider || "").toLowerCase().replace(/[^a-z0-9_.-]/g, "").slice(0, 40);
  // Local files and unknown sources say nothing about the public hosts.
  if (!source || !provider || source === "local" || provider === "local") return;
  const startMs = opts.ok && opts.startMs && opts.startMs > 0 ? Math.min(120000, Math.round(opts.startMs)) : null;
  // Keep the local aggregate roughly current so this device's next picker
  // already reflects what it just learned.
  if (memo) {
    const k = healthKey(source, provider);
    const cur = memo.stats.get(k) ?? { ok: 0, fail: 0, avgMs: null, recentOk: 0, recentFail: 0 };
    const next: HealthStat = { ...cur };
    if (opts.ok) {
      next.ok += 1;
      next.recentOk += 1;
      if (startMs != null) next.avgMs = cur.avgMs == null ? startMs : Math.round((cur.avgMs * cur.ok + startMs) / (cur.ok + 1));
    } else {
      next.fail += 1;
      next.recentFail += 1;
    }
    memo.stats.set(k, next);
  }
  void (async () => {
    try {
      await supabase.rpc("report_server_health", {
        p_source: source,
        p_provider: provider,
        p_ok: opts.ok,
        p_start_ms: startMs,
      });
    } catch {}
  })();
}
