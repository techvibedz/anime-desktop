// Throughput-aware server ranking.
//
// Discovery proves a server ANSWERS, not that it can keep up. On this user's
// ISP whole datacenter routes crawl while others are fine (measured
// 2026-11-24: Hetzner Falkenstein — where vid3rb keeps most of its files — at
// 20-80KB/s, every other DC at 4-10MB/s), so the top-ranked server sat on
// "loading" for minutes, then "stepped down" to a lower quality on the SAME
// slow host. We measure what each resolved stream actually delivers and rank
// the ones that can't sustain their bitrate last.

export type SpeedVerdict = "fast" | "slow";

export type SpeedSample = {
  kbps: number;      // measured body throughput, KB/s
  needKbps: number;  // what the stream needs to play in real time, KB/s
  host: string;      // final media host (after redirects)
  at: number;
};

// Comfortable margin: a link at exactly the bitrate still rebuffers on every
// throughput dip (vid3rb 720p at 79KB/s vs 78KB/s needed stalled every ~20s).
export const SPEED_HEADROOM = 1.3;
const SAMPLE_TTL_MS = 15 * 60_000;

const samples = new Map<string, SpeedSample>();      // keyed by iframeUrl
const hostSamples = new Map<string, SpeedSample>();  // keyed by media host
const inflight = new Map<string, Promise<SpeedSample | null>>();
const listeners = new Set<() => void>();

/** Notified whenever a new reading lands (the player re-ranks on it). */
export function subscribeSpeed(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function qualityOf(name: string): number {
  const m = /(\d{3,4})p/i.exec(name);
  if (m) return Number(m[1]);
  if (/fhd|1080/i.test(name)) return 1080;
  if (/\bhd\b|720/i.test(name)) return 720;
  if (/\bsd\b|480|360/i.test(name)) return 480;
  return 0;
}

/** KB/s a progressive file needs. vid3rb signs its pacing rate into the URL as
 * `speed=` (measured: always 2.4× the file's average bitrate, e.g. 720p
 * speed=189 for a 110.7MB / 23.5min file = 78KB/s). Others: by quality. */
export function progressiveNeedKbps(name: string, videoUrl: string): number {
  const speed = /[?&]speed=(\d+)/.exec(videoUrl);
  if (speed && /vid3rb\.com/i.test(videoUrl)) return Math.max(20, Math.round(Number(speed[1]) / 2.4));
  const q = qualityOf(name);
  if (q >= 1080) return 180;
  if (q >= 720) return 90;
  if (q > 0) return 45;
  return 90;
}

function fresh(s: SpeedSample | undefined): s is SpeedSample {
  return !!s && Date.now() - s.at < SAMPLE_TTL_MS;
}

export function verdictOf(sample: SpeedSample | null | undefined): SpeedVerdict | null {
  if (!sample || sample.kbps < 0 || sample.needKbps <= 0) return null;
  return sample.kbps >= sample.needKbps * SPEED_HEADROOM ? "fast" : "slow";
}

export function speedSampleFor(iframeUrl: string): SpeedSample | null {
  const s = samples.get(iframeUrl);
  return fresh(s) ? s : null;
}

/** A host measured slow for one stream is slow for every stream it serves —
 * this is what stops a step-down onto a sibling quality on the same box. */
export function hostSample(host: string): SpeedSample | null {
  const s = hostSamples.get(host);
  return fresh(s) ? s : null;
}

export function recordSpeed(iframeUrl: string, sample: Omit<SpeedSample, "at">): SpeedSample {
  const full = { ...sample, at: Date.now() };
  samples.set(iframeUrl, full);
  if (full.host) {
    const prev = hostSamples.get(full.host);
    // Keep the most recent reading per host — routes recover.
    if (!prev || prev.at <= full.at) hostSamples.set(full.host, full);
  }
  for (const cb of listeners) { try { cb(); } catch {} }
  return full;
}

// At most two probes at once: parallel probes split a weak link between
// them, so every server would read slower than it really is.
const MAX_PARALLEL_PROBES = 2;
let activeProbes = 0;
const probeQueue: (() => void)[] = [];
async function withProbeSlot<T>(run: () => Promise<T>): Promise<T> {
  if (activeProbes >= MAX_PARALLEL_PROBES) await new Promise<void>((r) => probeQueue.push(r));
  activeProbes++;
  try { return await run(); } finally {
    activeProbes--;
    probeQueue.shift()?.();
  }
}

/** Measure a resolved stream once per embed (deduped, cached 15 min).
 * Resolves null when the stream can't be measured (custom scheme, probe API
 * missing, zero bytes) — unknown is never treated as slow. */
export function measureServerSpeed(
  server: { name: string; iframeUrl: string },
  videoUrl: string,
  type: "hls" | "mp4" | string,
  opts: { force?: boolean } = {},
): Promise<SpeedSample | null> {
  const cached = speedSampleFor(server.iframeUrl);
  // force: the player is stalling on a stream measured fine earlier — vid3rb
  // redirects each request to whichever files-N box it likes, so a reading
  // can describe a different box than the one playback landed on.
  if (cached && !(opts.force && Date.now() - cached.at > 20_000)) return Promise.resolve(cached);
  const running = inflight.get(server.iframeUrl);
  if (running) return running;
  const measure = window.pantoufa?.measureMedia;
  if (!measure || !/^https?:/i.test(videoUrl)) return Promise.resolve(null);
  const p = withProbeSlot(() => measure(videoUrl, server.iframeUrl, type === "hls" ? 8000 : 6000))
    .then((r) => {
      // ok = the stream answered. A stream that answered but delivered
      // (almost) nothing in the window is the clearest "too slow" there is.
      if (!r?.ok) return null;
      const needKbps = type === "hls"
        ? (r.needKbps || 90)
        : progressiveNeedKbps(server.name, videoUrl);
      const sample = recordSpeed(server.iframeUrl, { kbps: r.kbps, needKbps, host: r.host });
      console.info(`[speed] ${server.name}: ${r.kbps}KB/s (needs ${needKbps}) @ ${r.host} → ${verdictOf(sample)}`);
      return sample;
    })
    .catch(() => null)
    .finally(() => { inflight.delete(server.iframeUrl); });
  inflight.set(server.iframeUrl, p);
  return p;
}

/** The resolved stream didn't answer at all within the probe window. */
export function recordUnresponsive(iframeUrl: string): void {
  recordSpeed(iframeUrl, { kbps: 0, needKbps: 1, host: "" });
}

/** Verdict for a server, falling back to its media host's reading so
 * unmeasured siblings inherit it. A host that crawled for ANY of its streams
 * is slow for all of them: the route is the problem, and it fluctuates (the
 * same Falkenstein box gave 79KB/s for 720p and 21KB/s for 480p a minute
 * apart) — stepping down on it just stalls again. A fast host is re-judged
 * against this stream's own bitrate. */
export function serverVerdict(
  server: { name: string; iframeUrl: string; provider: string; videoUrl?: string },
  groupHost?: string | null,
): SpeedVerdict | null {
  const own = speedSampleFor(server.iframeUrl);
  if (own) return verdictOf(own);
  const host = groupHost ? hostSample(groupHost) : null;
  if (!host) return null;
  const hostVerdict = verdictOf(host);
  if (hostVerdict !== "fast") return hostVerdict;
  if (server.provider !== "vid3rb" && !server.videoUrl) return hostVerdict;
  return verdictOf({ ...host, needKbps: progressiveNeedKbps(server.name, server.videoUrl || "") });
}

/** Media host of the first measured server in each source+provider group —
 * one provider's servers for an episode share a CDN box (vid3rb: all three
 * qualities on the same files-N host). */
export function groupHosts(
  servers: readonly { iframeUrl: string; provider: string; source?: string }[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of servers) {
    const key = `${s.source || ""}|${s.provider}`;
    if (out.has(key)) continue;
    const sample = speedSampleFor(s.iframeUrl);
    if (sample?.host) out.set(key, sample.host);
  }
  return out;
}

export function groupKey(s: { provider: string; source?: string }): string {
  return `${s.source || ""}|${s.provider}`;
}

export function __resetSpeedForTests(): void {
  samples.clear(); hostSamples.clear(); inflight.clear(); probeQueue.length = 0; activeProbes = 0;
}
