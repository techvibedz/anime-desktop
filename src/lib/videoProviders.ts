export type ProviderFailureMode = "failed" | "iframe";
export type ProviderResolution = "direct" | "directThenIframe" | "iframe";

export type ProviderPolicy = {
  patterns: string[];
  rank: number;
  resolution: ProviderResolution;
  failureMode: ProviderFailureMode;
  supported: boolean;
  downloadable?: boolean;
  adaptive?: boolean;
};

// Shared with mobile. Desktop maps the same intent onto hls.js/HTMLMediaElement.
export const STREAM_BUFFER_POLICY = {
  lowBufferSeconds: 12,
  unhealthySwitchMs: 7_000,
  recoveryBufferSeconds: 30,
  recoveryStableMs: 120_000,
  preferredForwardBufferSeconds: 300,
  minBufferForPlaybackSeconds: 4,
} as const;

export function createGenerationGuard() {
  let current = 0;
  return {
    next: () => ++current,
    isCurrent: (generation: number) => generation === current,
  };
}

export function episodeNumberFromUrl(raw: string): number | null {
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch {}
  const match = decoded.match(/الحلقة[\s_-]*(\d+)/) || decoded.match(/\/(?:episode|watch)\/[^/]+\/(\d+)(?:\/|$)/i);
  return match ? parseInt(match[1], 10) : null;
}

export function anime4upEpisodeUrl(title: string, episodeNumber: number): string | null {
  const slug = String(title || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? `https://w1.anime4up.rest/episode/انمي-${slug}-الحلقة-${episodeNumber}-مترجمة/` : null;
}

export const PROVIDER_POLICIES: Record<string, ProviderPolicy> = {
  // Featured anime4up servers (Anime4up-S1/S2). The embed host rotates through
  // throwaway *.shop domains, so classify on the STABLE parts of the URL (the
  // /Anime4up-S\d/ path segment and the /mal/<id>/<ep>/sub/ tail), plus the
  // historical hosts. The server NAME ("anime4up1") is the last-resort signal.
  anime4upcdn: { patterns: ["anime4up-s\\d", "\\/mal\\/\\d+\\/\\d+\\/(?:sub|dub)", "44y4h0r\\.shop", "z4m2r9t\\.shop", "k1c6x8p\\.shop"], rank: 0, resolution: "directThenIframe", failureMode: "failed", supported: true, adaptive: true },
  mp4upload: { patterns: ["mp4upload"], rank: 1, resolution: "directThenIframe", failureMode: "failed", supported: true, downloadable: true },
  dailymotion: { patterns: ["dailymotion", "dai\\.ly"], rank: 0, resolution: "directThenIframe", failureMode: "failed", supported: true, adaptive: true },
  streamwish: { patterns: ["streamwish", "hlswish", "wishembed", "wishfast", "hgcloud", "jwembed", "vibuxer", "audinifer", "masukestin", "hanerix", "playerwish"], rank: 2, resolution: "directThenIframe", failureMode: "failed", supported: true, adaptive: true },
  voe: { patterns: ["voe\\."], rank: 4, resolution: "directThenIframe", failureMode: "failed", supported: true, adaptive: true },
  share4max: { patterns: ["share4max", "megamax"], rank: 7, resolution: "directThenIframe", failureMode: "failed", supported: true },
  streamruby: { patterns: ["rubyvidhub", "streamruby", "rubystm", "ruby"], rank: 7, resolution: "directThenIframe", failureMode: "failed", supported: true },
  doodstream: { patterns: ["doodstream", "dood\\.", "dsvplay", "d-s\\.io", "vidply", "ds2play", "ds2video", "d0o0d", "do0od", "all3do", "doply", "playmogo"], rank: 5, resolution: "directThenIframe", failureMode: "failed", supported: true },
  uqload: { patterns: ["uqload"], rank: 8, resolution: "directThenIframe", failureMode: "failed", supported: true },
  okru: { patterns: ["ok\\.ru", "odnoklassniki"], rank: 6, resolution: "directThenIframe", failureMode: "failed", supported: true, adaptive: true },
  videas: { patterns: ["app\\.videas\\.fr"], rank: 3, resolution: "directThenIframe", failureMode: "failed", supported: true },
  videa: { patterns: ["videa\\.", "vidvaita", "vidit", "videakid"], rank: 3, resolution: "directThenIframe", failureMode: "failed", supported: true },
  vk: { patterns: ["vk\\.com"], rank: 11, resolution: "iframe", failureMode: "iframe", supported: true },
  mega: { patterns: ["mega\\.(?:nz|co\\.nz)"], rank: 12, resolution: "direct", failureMode: "failed", supported: true },
  vid3rb: { patterns: ["vid3rb", "anime3rb"], rank: -1, resolution: "direct", failureMode: "failed", supported: true, downloadable: true },
  luluvdo: { patterns: ["luluvdo", "lulustream", "luluvid"], rank: 9, resolution: "directThenIframe", failureMode: "failed", supported: true },
  yonaplay: { patterns: ["yonaplay"], rank: 99, resolution: "iframe", failureMode: "failed", supported: false },
  generic: { patterns: [], rank: 10, resolution: "iframe", failureMode: "iframe", supported: true },
};

const PROVIDER_ENTRIES = Object.entries(PROVIDER_POLICIES).filter(([id]) => id !== "generic");

export function classifyProvider(url: string, name = ""): string {
  const value = String(url || "").toLowerCase();
  // anime4up labels the featured VnxPlayer servers "anime4up1"/"anime4up2" —
  // the label survives a host rotation the URL patterns can't follow.
  if (/anime4up\s*\d/i.test(name)) return "anime4upcdn";
  for (const [id, policy] of PROVIDER_ENTRIES) {
    if (policy.patterns.some((pattern) => new RegExp(pattern, "i").test(value))) return id;
  }
  return "generic";
}

export function providerPolicy(provider: string): ProviderPolicy {
  return PROVIDER_POLICIES[provider] || PROVIDER_POLICIES.generic;
}

export function providerRank(provider: string): number {
  return providerPolicy(provider).rank;
}

export function providerFailureMode(provider?: string): ProviderFailureMode {
  return providerPolicy(provider || "generic").failureMode;
}

export function isProviderSupported(provider: string): boolean {
  return providerPolicy(provider).supported;
}

export function isDirectProvider(provider: string): boolean {
  const policy = providerPolicy(provider);
  return policy.supported && policy.resolution !== "iframe";
}

export function isDownloadProvider(provider: string): boolean {
  return providerPolicy(provider).downloadable === true;
}

/** Provider flags are a pre-resolution hint. Once a media URL exists, the
 * URL itself decides whether this server can be saved as one offline file. */
export function isResolvedDownloadServer(server: {
  provider: string;
  videoUrl?: string | null;
}): boolean {
  const videoUrl = server.videoUrl || "";
  return isDirectProvider(server.provider) &&
    validateMediaUrl(videoUrl, server.provider) &&
    videoContentType(videoUrl, server.provider) === "progressive";
}

export function providerSupportsAdaptivePlayback(provider: string): boolean {
  return providerPolicy(provider).adaptive === true;
}

export function bufferAheadSeconds(currentTime: number, bufferedPosition: number): number | null {
  if (!Number.isFinite(currentTime) || !Number.isFinite(bufferedPosition) || bufferedPosition < 0) return null;
  return Math.max(0, bufferedPosition - currentTime);
}

export function isUnhealthyBufferSample(
  status: string,
  currentTime: number,
  bufferAhead: number | null,
  previousBufferAhead: number | null,
): boolean {
  if (currentTime <= 0) return false;
  if (status === "loading") return true;
  if (bufferAhead == null || previousBufferAhead == null) return false;
  return bufferAhead < STREAM_BUFFER_POLICY.lowBufferSeconds && bufferAhead <= previousBufferAhead + 0.25;
}

export function updateBufferRiskMs(currentMs: number, unhealthy: boolean, elapsedMs = 1_000): number {
  return unhealthy ? currentMs + elapsedMs : Math.max(0, currentMs - elapsedMs * 2);
}

export function isStableBufferSample(status: string, bufferAhead: number | null): boolean {
  return status === "readyToPlay" && bufferAhead != null && bufferAhead >= STREAM_BUFFER_POLICY.recoveryBufferSeconds;
}

export function qualityScore(name: string): number {
  const value = String(name || "").toLowerCase();
  if (value.includes("fhd") || value.includes("1080")) return 3;
  if (value.includes("hd") || value.includes("720")) return 2;
  if (value.includes("sd") || value.includes("480") || value.includes("360")) return 0;
  return 1;
}

export function sortVideoServers<T extends { name: string; provider: string }>(servers: T[]): T[] {
  // vid3rb serves fixed-bitrate MP4s: 1080p regularly outruns the connection.
  // Start at 720p; viewers can still select 1080p explicitly.
  const startupQuality = (s: T) => s.provider === "vid3rb" && qualityScore(s.name) === 3
    ? -1 : qualityScore(s.name);
  return [...servers].sort((a, b) =>
    providerRank(a.provider) - providerRank(b.provider) || startupQuality(b) - startupQuality(a));
}

export function selectWarmupServers<T extends { name: string; provider: string }>(servers: T[], limit = 3): T[] {
  return sortVideoServers(servers.filter((server) => isDirectProvider(server.provider))).slice(0, limit);
}

export function selectServerCandidates<T extends { provider: string }>(servers: readonly T[]): T[] {
  return servers.filter((server) => isDirectProvider(server.provider));
}

export function selectDownloadCandidates<
  T extends { id?: string; name: string; provider: string; iframeUrl: string; videoUrl?: string },
>(groups: readonly (readonly T[])[]): (T & { id: string; quality: string })[] {
  return mergeVideoServers(groups)
    .filter((server) => server.videoUrl
      ? isResolvedDownloadServer(server)
      : isDownloadProvider(server.provider))
    .map((server) => ({
      ...server,
      quality: qualityScore(server.name) === 3
        ? "FHD"
        : qualityScore(server.name) === 2
          ? "HD"
          : qualityScore(server.name) === 0 ? "SD" : "",
    }));
}

export function serverCandidateSignature(servers: readonly { provider: string; iframeUrl: string; source?: string }[]): string {
  return servers.map((server) => `${server.source || ""}|${server.provider}|${server.iframeUrl}`).join("\n");
}

export function mergeVideoServers<T extends { id?: string; name: string; provider: string; iframeUrl: string }>(
  groups: readonly (readonly T[])[],
): (T & { id: string })[] {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const group of groups) {
    for (const server of group) {
      const iframeUrl = normalizeServerUrl(server.iframeUrl);
      const dedupeKey = serverDedupeKey(iframeUrl);
      const provider = !server.provider || server.provider === "generic"
        ? classifyProvider(iframeUrl, server.name)
        : server.provider;
      if (!iframeUrl || !isProviderSupported(provider) || seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      merged.push({ ...server, provider, iframeUrl });
    }
  }
  // URL-backed IDs stay stable when a later source inserts a higher-ranked
  // server ahead of the current list. The watch screen can therefore retain
  // broken/selected state without accidentally applying it to another row.
  return sortVideoServers(merged).map((server, index) => ({
    ...server,
    id: serverDedupeKey(server.iframeUrl) || server.id || String(index),
  }));
}

export function mergePlayableServers<T extends {
  id?: string; name: string; provider: string; iframeUrl: string; videoUrl?: string;
}>(candidates: readonly T[], playable: readonly T[]): (T & { id: string })[] {
  return mergeVideoServers([playable, candidates]);
}

export function normalizeServerUrl(raw: string): string {
  const value = String(raw || "").trim();
  if (!value) return "";
  try {
    const url = new URL(value.startsWith("//") ? `https:${value}` : value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    // Keep the path EXACTLY as the source published it — trailing slashes are
    // significant. anime4up's VnxPlayer serves its "domain not authorized"
    // refusal for /Anime4up-S1/mal/<id>/<ep>/sub but the real player for …/sub/,
    // so stripping the slash here made every anime4up1/2 click land on the
    // refusal while the same URL extracted fine in tests (which used the raw
    // slash form). Identity comparison strips it in serverDedupeKey instead.
    return url.toString();
  } catch {
    return "";
  }
}

function serverDedupeKey(raw: string): string {
  try {
    const url = new URL(raw);
    if (!/^#vid3rb=\d+$/i.test(url.hash)) url.hash = "";
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return raw;
  }
}

const MEDIA_DECOY_RE =
  /test-videos\.co\.uk|bigbuckbunny|sample[-_.]|placeholder|tos\.mp4|googleapis\.com\/.*oggtheora|\/lol\/file\.mp4|doubleclick|adserv|\/vast|preroll|\/ads\//i;

export function validateMediaUrl(raw: string, provider = "generic"): boolean {
  try {
    const url = new URL(raw);
    if (provider === "mega" && url.protocol === "pantoufa-video:" && url.hostname === "mega") {
      return /^\/[A-Za-z0-9_-]{24}\.mp4$/.test(url.pathname);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (MEDIA_DECOY_RE.test(raw) || /\/embed(?:[-/]|$)|\/e\/[^/]*\.(?:mp4|m3u8)/i.test(url.pathname)) return false;
    if (provider === "mp4upload") {
      return (url.hostname === "mp4upload.com" || url.hostname.endsWith(".mp4upload.com")) &&
        url.pathname.toLowerCase().endsWith(".mp4");
    }
    // Anime4up's CDN serves extension-less, token-signed HLS URLs
    // (https://cdnN.<edge>.shop/?token=…), so the generic media-extension rule
    // below would reject every valid extraction.
    if (provider === "anime4upcdn") {
      return url.searchParams.has("token") || /\.(?:m3u8|mp4)$/i.test(url.pathname);
    }
    if (provider === "vid3rb" && /(^|\.)vid3rb\.com$/i.test(url.hostname)) {
      return /\.(?:m3u8|mp4)$/i.test(url.pathname) || /^\/video\//i.test(url.pathname);
    }
    if (provider === "doodstream" && url.searchParams.has("token") && url.searchParams.has("expiry")) return true;
    if (provider === "dailymotion" && /(^|\.)(?:dailymotion\.com|dmcdn\.net)$/i.test(url.hostname)) return true;
    if (provider === "okru" && /(^|\.)(?:ok\.ru|mycdn\.me|okcdn\.)/i.test(url.hostname)) return true;
    if (/videa\.hu$/i.test(url.hostname) && /\/static\//i.test(url.pathname) && url.searchParams.has("md5")) return true;
    return /\.(?:m3u8|mp4)(?:$|\?)/i.test(raw);
  } catch {
    return false;
  }
}

export function videoContentType(videoUrl: string, provider = "generic"): "hls" | "progressive" {
  if (/\.m3u8(?:\?|$)/i.test(videoUrl)) return "hls";
  // Anime4up's CDN URLs carry no extension — the resolver always returns HLS.
  if (provider === "anime4upcdn" && !/\.mp4(?:\?|$)/i.test(videoUrl)) return "hls";
  if (["streamwish", "voe", "dailymotion", "okru"].includes(provider) && !/\.mp4(?:\?|$)/i.test(videoUrl)) return "hls";
  return "progressive";
}
