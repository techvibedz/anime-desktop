import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useParams, useSearchParams, Link, useNavigate } from "react-router-dom";
import Hls from "hls.js";
import {
  fetchVideoServers, enrichServersFromUp4, resolveVideo, fetchEpisodes, fetchEpisodesUp4,
  resolveUp4EpisodeUrl, fetchAnime3rbServers,
  invalidateServersCache, invalidateResolveCache,
  type VideoServer, type Episode,
} from "../lib/api";
import { saveProgress, getProgress } from "../lib/history";
import { recordEpisodeWatched } from "../lib/completion";
import { toAnimeUrl } from "../lib/favorites";
import {
  startDownload, subscribeDownloads, getDownloadByEpisode,
  type DownloadStatus,
} from "../lib/downloads";
import { t } from "../lib/i18n";

type ServerWithSource = VideoServer & { source?: string };

// Fire-and-forget mute toggle. The IPC handler in main.ts wraps
// mainWindow.webContents.setAudioMuted(), which can transiently fail
// while the window is initializing or being destroyed. We don't track
// the system mute state in React — every call site simply asserts the
// state it wants and we trust the IPC to converge.
function setMutedSafe(muted: boolean) {
  window.pantoufa.setMuted?.(muted).catch(() => {});
}

const PROVIDER_RANK: Record<string, number> = {
  // vid3rb (anime3rb's first-party host) ranks top: a single static GET
  // yields a direct 1080p .mp4 that plays natively in the custom player —
  // no ads, no Cloudflare, Range-capable CDN.
  vid3rb: 0, dailymotion: 0, streamwish: 1, videa: 2, voe: 3,
  share4max: 4, streamruby: 5, mp4upload: 6, doodstream: 7,
  uqload: 8, okru: 9, yonaplay: 10, vk: 11,
};
function rank(p: string) { return PROVIDER_RANK[p] ?? 50; }

// Providers we can re-extract cheaply. If extraction returns an iframe
// fallback for one of these, it was almost certainly a transient miss, so we
// re-extract once (the resolve cache no longer keeps the stale fallback) to
// land the direct stream WITHOUT the user manually re-clicking the server.
// The slow capture providers (voe/share4max/uqload) are deliberately left out
// — a second ~30s capture attempt isn't worth the wait, so we accept their
// iframe fallback and let the embed play.
const FAST_REEXTRACT_PROVIDERS = new Set([
  "mp4upload", "streamwish", "okru", "doodstream", "vk", "streamruby",
  // videa resolves via its XML API in well under a second — a re-extract
  // after a transient miss is essentially free.
  "videa",
  // vid3rb resolves from one static player-page GET — also essentially free.
  "vid3rb",
]);

function displayName(s: VideoServer): string {
  const n = (s.name || "").trim();
  if (!n || /^(server\s*\d*|4up\s*s\d*)$/i.test(n)) {
    return s.provider.charAt(0).toUpperCase() + s.provider.slice(1);
  }
  return n;
}

function proxify(rawUrl: string, embedUrl: string): string {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return `pantoufa-video://x/?u=${encodeURIComponent(rawUrl)}&ref=${encodeURIComponent(embedUrl)}`;
  }
  const originEnc = encodeURIComponent(`${u.protocol}//${u.host}`);
  const refEnc = encodeURIComponent(embedUrl);
  const sep = u.search ? "&" : "?";
  return `pantoufa-video://x/${originEnc}${u.pathname}${u.search}${sep}__pantoufa_ref=${refEnc}`;
}

function formatTime(s: number): string {
  if (!isFinite(s) || s < 0) return "0:00";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

const STALL_THRESHOLD_MS = 15000;

// Skip-intro heuristic. Anime openings run ~85s but don't always start at
// second 0 — a cold-open/recap often pushes the OP a few minutes in. We have
// no per-episode intro markers, so we keep the "Skip Intro" affordance eligible
// across the first several minutes (covering late openings), jump forward by a
// fixed amount when tapped, and auto-fade the pill so it isn't glued on screen.
const INTRO_SKIP_SECONDS = 85;
const INTRO_WINDOW_END_SECONDS = 360;
// How long the pill stays up after appearing / after the last mouse move.
const SKIP_PILL_VISIBLE_MS = 6000;

export function WatchPage() {
  const { episode } = useParams<{ episode: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const episodeUrl = episode ? decodeURIComponent(episode) : "";
  const up4Param = params.get("up4");
  const imgParam = params.get("img");
  const animeParam = params.get("anime");

  const [servers, setServers] = useState<ServerWithSource[]>([]);
  // Direct anime4up episode URL harvested off the witanime episode page by
  // the server scrape. When present we enrich anime4up servers immediately,
  // skipping the slow cross-source title-search + sibling-match chain.
  const [harvestedUp4, setHarvestedUp4] = useState<string | null>(null);
  // anime4up episode URL resolved directly from the anime title + episode
  // number via no-headless HTTP fetches. This is the robust fallback when
  // there's no ?up4= and witanime carried no anime4up link (e.g. One Piece).
  const [directUp4, setDirectUp4] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ episodeTitle: string; animeTitle: string }>({ episodeTitle: "", animeTitle: "" });
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const [resolved, setResolved] = useState<{ url: string; type: "hls" | "mp4" | "dailymotion" | "iframe"; embed: string } | null>(null);
  const [status, setStatus] = useState<"idle" | "resolving" | "playing" | "failed">("idle");
  const [loadingServers, setLoadingServers] = useState(true);
  const [serverError, setServerError] = useState(false);
  const [retryServersNonce, setRetryServersNonce] = useState(0);
  const [brokenIds, setBrokenIds] = useState<Set<string>>(new Set());
  const [retryNonce, setRetryNonce] = useState(0);
  const [userActivated, setUserActivated] = useState(false);

  // Iframe-direct playback. We render the provider's embed page and
  // let the user click play inside it — the iframe is the source of
  // truth for the picture. Audio is muted via the system mute IPC for
  // a brief window so ad noise during embed initialization doesn't
  // hit the speaker; once `iframe.onLoad` fires we unmute.
  //
  // `fallbackReload` is bumped by `triggerReextract` so a same-URL
  // re-mount (Dailymotion HLS-extract → iframe budget exhaustion)
  // forces a fresh iframe — React would otherwise reuse the element.
  const [fallbackReload, setFallbackReload] = useState(0);
  const [iframeLoaded, setIframeLoaded] = useState(false);
  // How many HLS/MP4 re-extract cycles we've attempted on the current
  // server before giving up and falling back to the iframe.
  const reextractCount = useRef(0);
  const MAX_REEXTRACTS_BEFORE_FALLBACK = 2;
  const iframeFailedRef = useRef(false);
  // True once the active embed iframe has fired `onLoad`. After a successful
  // load, any `did-fail-load` reported by the main process is an internal
  // redirect / sub-navigation inside the embed (ok.ru, videa, mp4upload all
  // re-navigate after their landing page), NOT the embed dying — so we must
  // NOT advance to the next server. Reset to false whenever a new embed URL
  // is mounted. This is the renderer-side counterpart to the main process
  // ignoring ERR_ABORTED, and it hot-reloads (the main change needs a restart).
  const iframeLoadedRef = useRef(false);
  // Pending "advance to next server" scheduled by a main-process
  // did-fail-load report. We don't advance instantly: some embeds
  // (mp4upload, ok.ru) fail their first navigation with a real error code
  // and then load successfully a moment later. We give the iframe a short
  // grace window — if its onLoad fires meanwhile, the advance is cancelled.
  const pendingAdvanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // anime4up enrichment retry machinery. The anime4up scrape is flaky and
  // frequently comes back empty on the first try (ad gates / JS redirects, or
  // a burst of requests during initial page load getting rate-limited), which
  // is why anime4up servers used to only appear after a manual refresh. We keep
  // retrying on a steady backoff until anime4up servers actually land
  // (up4ServerCount > 0) or a generous wall-clock deadline passes — a small
  // fixed attempt cap gave up while the site was briefly congested, then the
  // manual refresh (fresh budget) "magically" worked. The deadline only starts
  // counting once we actually have an anime4up URL to try, so slow cross-source
  // resolution never eats into the retry window.
  const ENRICH_RETRY_DEADLINE_MS = 3 * 60 * 1000;
  const enrichAttemptsRef = useRef(0);
  const enrichStartedAtRef = useRef(0);
  const enrichInFlightRef = useRef(false);
  const enrichRetryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [enrichNonce, setEnrichNonce] = useState(0);
  // True once the retry deadline passes without landing any anime4up server —
  // used to stop showing the "searching for more servers" indicator.
  const [enrichExhausted, setEnrichExhausted] = useState(false);
  // Latest server embed URLs, read at cleanup time to flush their
  // resolve-cache entries when the user leaves the episode.
  const serverUrlsRef = useRef<string[]>([]);
  // Distinguish "effect re-fired (deps changed)" from "user left this episode"
  // inside settled async handlers: a cancelled run whose episode is still the
  // current one produced a result we WANT — discarding it (and scheduling no
  // retry) was a remaining "anime4up servers never show until reload" hole.
  const episodeUrlRef = useRef(episodeUrl);
  useEffect(() => { episodeUrlRef.current = episodeUrl; }, [episodeUrl]);
  const unmountedRef = useRef(false);
  useEffect(() => () => { unmountedRef.current = true; }, []);

  // Sibling episode navigation
  const [siblings, setSiblings] = useState<Episode[]>([]);
  const [up4Siblings, setUp4Siblings] = useState<Episode[]>([]);
  const [animeTitleFromDetail, setAnimeTitleFromDetail] = useState<string>("");
  const [posterFromDetail, setPosterFromDetail] = useState<string>("");

  // Custom player state
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const playerRef = useRef<HTMLDivElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [showRateMenu, setShowRateMenu] = useState(false);
  const [showVolumeBar, setShowVolumeBar] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [skipIntroVisible, setSkipIntroVisible] = useState(false);
  const skipHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reextractUsedRef = useRef(false);

  const sortedServers = useMemo(
    () => [...servers]
      // Hide unrecognized witanime embeds (mega.nz etc.), but always keep
      // anime4up-sourced servers — their data-watch URLs often don't match
      // a known provider regex yet still play fine in an iframe.
      .filter((s) => s.provider !== "generic" || s.source === "anime4up")
      .sort((a, b) => rank(a.provider) - rank(b.provider)),
    [servers],
  );

  // Fetch server list once.
  useEffect(() => {
    if (!episodeUrl) return;
    let cancelled = false;
    // Clear servers when episode changes so the loading state shows
    // properly. This prevents showing servers for the wrong episode
    // during prev/next navigation.
    setServers([]);
    setHarvestedUp4(null);
    setDirectUp4(null);
    // Clear the titles too: on watch→watch navigation the component stays
    // mounted, so a stale meta.animeTitle from the PREVIOUS anime would pair
    // with the new URL's episode number and make the title-based resolvers
    // (anime3rb, direct anime4up) fetch the WRONG anime's episode — which
    // then merges a wrong-anime server into this episode's list.
    setMeta({ episodeTitle: "", animeTitle: "" });
    setLoadingServers(true);
    setServerError(false);
    console.info(`[player] fetching servers for episode: ${episodeUrl}`);
    console.info(`[player] up4Param: ${up4Param || 'none'}`);
    fetchVideoServers(episodeUrl, up4Param || undefined)
      .then((r) => {
        if (cancelled) return;
        console.info(`[player] loaded ${r.data.servers.length} servers for: ${r.data.episodeTitle}`);
        // Merge append-only (dedupe by URL) instead of replacing wholesale.
        // anime4up enrichment can run CONCURRENTLY with this primary scrape
        // (when the anime4up URL is already known via ?up4= or harvested off
        // the witanime page), so a wholesale replace here would race-wipe the
        // anime4up servers an earlier enrichment run already appended.
        setServers((prev) => {
          const have = new Set(prev.map((s) => s.iframeUrl));
          const additions = r.data.servers.filter((s) => !have.has(s.iframeUrl));
          return additions.length ? [...prev, ...additions] : prev;
        });
        if ((r.data as any).up4EpisodeUrl) {
          console.info(`[player] harvested direct anime4up episode: ${(r.data as any).up4EpisodeUrl}`);
          setHarvestedUp4((r.data as any).up4EpisodeUrl);
        }
        setMeta({ episodeTitle: r.data.episodeTitle, animeTitle: r.data.animeTitle });
        setLoadingServers(false);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[player] failed to fetch video servers", err);
        setServerError(true);
        setLoadingServers(false);
      });
    return () => { cancelled = true; };
  }, [episodeUrl, up4Param, retryServersNonce]);

  // Fetch parent anime to populate prev/next + back-to-anime button.
  // Falls back to slug-deriving the anime URL from the episode URL when
  // the watch link didn't carry an explicit ?anime= (e.g. recently
  // updated tap, continue-watching history).
  const resolvedAnimeHref = useMemo(() => {
    if (animeParam) return animeParam;
    if (!episodeUrl) return null;
    return toAnimeUrl(episodeUrl);
  }, [animeParam, episodeUrl]);

  useEffect(() => {
    if (!resolvedAnimeHref) return;
    let cancelled = false;
    // This effect only re-fires when the PARENT ANIME changes, so clear the
    // previous anime's data immediately: stale siblings would let prev/next
    // (and the up4-sibling number match, and the title-based resolvers) act
    // on the wrong anime until the new fetch lands.
    setSiblings([]);
    setUp4Siblings([]);
    setAnimeTitleFromDetail("");
    fetchEpisodes(resolvedAnimeHref)
      .then((r) => {
        if (cancelled) return;
        setSiblings(r.data.episodes);
        setUp4Siblings(r.data.episodes4up || []);
        if (r.data.title) setAnimeTitleFromDetail(r.data.title);
        if (r.data.poster) setPosterFromDetail(r.data.poster);
        // fetchEpisodes never resolves the anime4up cross-source list
        // (episodes4up is always []). Resolve it here so anime4up servers
        // can be enriched even when the watch link didn't carry ?up4=.
        if (!/anime4up/i.test(resolvedAnimeHref)) {
          fetchEpisodesUp4(resolvedAnimeHref, r.data.title || null, r.data.up4Hint)
            .then((up4) => { if (!cancelled && up4.episodes4up.length) setUp4Siblings(up4.episodes4up); })
            .catch(() => {});
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [resolvedAnimeHref]);

  // Episode number of the currently playing episode (used to match the
  // anime4up sibling when no explicit ?up4= was supplied).
  const currentEpNumber = useMemo(() => {
    const m = episodeUrl.match(/الحلقة[\s\-_]*(\d+)/);
    if (m) return parseInt(m[1], 10);
    const byHref = siblings.find((e) => {
      try { return decodeURIComponent(e.href || "").replace(/\/+$/, "") === decodeURIComponent(episodeUrl).replace(/\/+$/, ""); }
      catch { return false; }
    });
    return byHref?.number ?? null;
  }, [episodeUrl, siblings]);

  // Effective anime4up episode URL: the explicit ?up4= if present, else
  // the cross-source sibling matched by episode number.
  const effectiveUp4 = useMemo(() => {
    if (up4Param) return up4Param;
    // Direct link harvested off the witanime page — available as soon as the
    // servers load, so anime4up enrichment doesn't wait on the cross-source
    // sibling lookup.
    if (harvestedUp4) return harvestedUp4;
    if (currentEpNumber == null) return null;
    const sibling = up4Siblings.find((u) => u.number === currentEpNumber)?.href;
    if (sibling) return sibling;
    // Last resort: the URL resolved directly from the anime title + ep number.
    return directUp4;
  }, [up4Param, harvestedUp4, currentEpNumber, up4Siblings, directUp4]);

  // Anime title derived from the witanime episode URL slug
  // (…/episode/<anime-slug>-الحلقة-N/). Available synchronously on mount, so
  // the direct anime4up resolution below can start IMMEDIATELY instead of
  // waiting many seconds for the witanime scrape to report the real title.
  const slugTitle = useMemo(() => {
    if (!episodeUrl) return "";
    try {
      const d = decodeURIComponent(episodeUrl);
      // new URL().pathname RE-percent-encodes non-ASCII, so the Arabic الحلقة
      // marker comes back as %D8%A7… and the split below silently fails —
      // leaving "%D8%A7%D9%84… 11" junk in the title. That junk made every
      // attempt-1 cross-source lookup (anime4up AND anime3rb) search for a
      // garbage title: wasted round-trips at best, a wrong-anime match at
      // worst. Decode the slug again before cutting.
      const slug = decodeURIComponent(new URL(d).pathname.replace(/\/+$/, "").split("/").pop() || "");
      const cut = slug.split(/-?\s*الحلقة/)[0] || "";
      return cut.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
    } catch { return ""; }
  }, [episodeUrl]);

  // Retry machinery for the direct anime4up resolution below. The cross-source
  // search + episode-list fetch is heavier than enrichment, so we retry on a
  // longer backoff and a shorter deadline — enough to ride out a flaky first
  // attempt (which used to leave anime4up servers permanently absent) without
  // hammering the site. Bumping the nonce re-runs the resolution effect.
  const DIRECT_UP4_DEADLINE_MS = 90 * 1000;
  const directUp4AttemptsRef = useRef(0);
  const directUp4StartedAtRef = useRef(0);
  const directUp4RetryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [directUp4Nonce, setDirectUp4Nonce] = useState(0);
  useEffect(() => {
    directUp4AttemptsRef.current = 0;
    directUp4StartedAtRef.current = 0;
    if (directUp4RetryTimer.current) { clearTimeout(directUp4RetryTimer.current); directUp4RetryTimer.current = null; }
  }, [episodeUrl]);
  useEffect(() => () => { if (directUp4RetryTimer.current) clearTimeout(directUp4RetryTimer.current); }, []);

  // Direct anime4up resolution — runs independently of the sibling chain
  // (fetchEpisodes/fetchEpisodesUp4), which can silently fail when the
  // anime URL is derived/guessed (e.g. One Piece, no embedded anime4up link).
  // Only kicks in when no other source has produced an anime4up URL yet.
  useEffect(() => {
    if (up4Param || harvestedUp4) return;          // already have a better source
    if (directUp4) return;                          // already resolved (e.g. via slug title)
    if (/anime4up/i.test(episodeUrl)) return;       // primary is already anime4up
    if (currentEpNumber == null) return;            // can't match without ep number
    if (up4Siblings.some((u) => u.number === currentEpNumber)) return; // sibling will cover it
    // Slug-derived title lets this fire on mount (no waiting on the scrape);
    // when the real title differs and the slug search found nothing, the
    // effect re-runs with the better title once the scrape reports it.
    const title = meta.animeTitle || animeTitleFromDetail || slugTitle;
    if (!title) return;                             // wait until we know the title
    let cancelled = false;
    const epAtStart = episodeUrl;
    if (!directUp4StartedAtRef.current) directUp4StartedAtRef.current = Date.now();
    directUp4AttemptsRef.current += 1;
    const attempt = directUp4AttemptsRef.current;
    console.info(`[player] resolving anime4up directly for "${title}" ep ${currentEpNumber} (attempt ${attempt})`);
    // A flaky empty result is no longer cached (see api.ts), so re-running the
    // lookup genuinely re-queries anime4up. Keep retrying on a backoff until it
    // resolves or the deadline passes.
    const scheduleRetry = () => {
      if (cancelled) return;
      if (Date.now() - directUp4StartedAtRef.current > DIRECT_UP4_DEADLINE_MS) {
        console.warn(`[player] direct anime4up resolution gave up after ${attempt} attempts`);
        return;
      }
      const delay = Math.min(5000 * attempt, 15000);
      directUp4RetryTimer.current = setTimeout(() => setDirectUp4Nonce((n) => n + 1), delay);
    };
    resolveUp4EpisodeUrl(title, currentEpNumber)
      .then((url) => {
        if (!url) { if (!cancelled) scheduleRetry(); return; }
        // Accept a found URL even if this run was cancelled by a dep change
        // (e.g. the scrape reporting a better title mid-flight) — as long as
        // the user is still on this episode the result is exactly what the
        // replacement run is about to re-fetch. Discarding it wasted the
        // round-trip and delayed anime4up servers for no reason.
        if (unmountedRef.current || episodeUrlRef.current !== epAtStart) return;
        console.info(`[player] direct anime4up episode resolved: ${url}`);
        setDirectUp4(url);
      })
      .catch((e) => { if (cancelled) return; console.warn(`[player] direct anime4up resolution failed:`, e); scheduleRetry(); });
    return () => { cancelled = true; };
  }, [up4Param, harvestedUp4, directUp4, episodeUrl, currentEpNumber, up4Siblings, meta.animeTitle, animeTitleFromDetail, slugTitle, directUp4Nonce]);

  // Reset the enrichment retry state whenever the episode changes (or a
  // manual/auto refresh is requested via retryServersNonce).
  useEffect(() => {
    enrichAttemptsRef.current = 0;
    enrichStartedAtRef.current = 0;
    enrichInFlightRef.current = false;
    setEnrichExhausted(false);
    if (enrichRetryTimer.current) { clearTimeout(enrichRetryTimer.current); enrichRetryTimer.current = null; }
  }, [episodeUrl, retryServersNonce]);

  // How many anime4up servers we've successfully attached so far. Once this
  // is > 0 the enrichment effect considers itself done and stops retrying.
  const up4ServerCount = useMemo(
    () => servers.filter((s) => s.source === "anime4up").length,
    [servers],
  );

  // Keep the latest server URLs available to the unmount cleanup.
  useEffect(() => { serverUrlsRef.current = servers.map((s) => s.iframeUrl); }, [servers]);

  // When the user leaves an episode (navigates back/away or to another
  // episode), drop its cached server list and per-embed resolve entries so
  // returning re-scrapes fresh instead of replaying a stale, saved state.
  useEffect(() => {
    if (!episodeUrl) return;
    return () => {
      invalidateServersCache(episodeUrl);
      for (const u of serverUrlsRef.current) invalidateResolveCache(u);
    };
  }, [episodeUrl]);

  // Clear any pending enrichment-retry timer on unmount.
  useEffect(() => () => {
    if (enrichRetryTimer.current) { clearTimeout(enrichRetryTimer.current); enrichRetryTimer.current = null; }
  }, []);

  // Manual "refresh servers" — re-scrape the primary list AND restart the
  // anime4up enrichment retry loop from scratch. Busts the servers cache so
  // the re-scrape is genuinely fresh rather than replaying the cached list.
  const refreshServers = useCallback(() => {
    invalidateServersCache(episodeUrl);
    enrichAttemptsRef.current = 0;
    enrichStartedAtRef.current = 0;
    enrichInFlightRef.current = false;
    if (enrichRetryTimer.current) { clearTimeout(enrichRetryTimer.current); enrichRetryTimer.current = null; }
    // Also drop the directly-resolved anime4up URL and restart its resolution
    // loop, so a refresh can recover the "anime4up never showed" case (a flaky
    // first resolution) instead of only re-running enrichment against a URL we
    // never found. The resolution caches no longer pin failures (see api.ts),
    // so this genuinely re-tries the cross-source lookup.
    setDirectUp4(null);
    directUp4AttemptsRef.current = 0;
    directUp4StartedAtRef.current = 0;
    if (directUp4RetryTimer.current) { clearTimeout(directUp4RetryTimer.current); directUp4RetryTimer.current = null; }
    setRetryServersNonce((n) => n + 1);
  }, [episodeUrl]);

  // Merge anime4up servers once an anime4up URL is known (explicit ?up4=
  // or resolved cross-source). Runs CONCURRENTLY with the primary witanime
  // scrape — when the anime4up URL is already known up front (?up4= or
  // harvested) the two fetches race instead of serializing, so anime4up
  // servers appear without waiting on the slower witanime render. The
  // append-only merge (here and in the primary load) means neither run can
  // clobber the other's servers. Runs only once per episode/URL.
  useEffect(() => {
    if (!effectiveUp4) return;
    if (/anime4up/i.test(episodeUrl)) return;
    if (up4ServerCount > 0) return;             // already enriched successfully
    if (enrichInFlightRef.current) return;      // a run is already going
    if (enrichStartedAtRef.current && Date.now() - enrichStartedAtRef.current > ENRICH_RETRY_DEADLINE_MS) {
      setEnrichExhausted(true);
      return;
    }

    const epAtStart = episodeUrl;
    // True only when the user actually left this episode — the one case where
    // this run's outcome is genuinely unwanted. An effect-cleanup `cancelled`
    // flag can't tell: it also flips when the effect merely re-fires
    // (effectiveUp4 settles on a different URL mid-flight), and the re-fired
    // run bails on the in-flight latch above, so if we dropped the result AND
    // scheduled nothing here the retry chain would be dead until a manual
    // refresh — anime4up servers "never show" until the user reloads.
    const leftEpisode = () => unmountedRef.current || episodeUrlRef.current !== epAtStart;
    enrichInFlightRef.current = true;
    enrichAttemptsRef.current += 1;
    if (!enrichStartedAtRef.current) enrichStartedAtRef.current = Date.now();
    const attempt = enrichAttemptsRef.current;
    console.info(`[player] enriching with anime4up servers (attempt ${attempt}) from: ${effectiveUp4}`);

    // Schedule a backoff retry. Backoff grows with the attempt count but is
    // capped, so a persistently-empty anime4up keeps getting polled steadily
    // (without hammering it) until it responds or the wall-clock deadline
    // passes. Bumping enrichNonce re-runs this effect.
    const scheduleRetry = () => {
      if (leftEpisode()) return;
      if (Date.now() - enrichStartedAtRef.current > ENRICH_RETRY_DEADLINE_MS) {
        console.warn(`[player] anime4up enrichment gave up after ${attempt} attempts (deadline reached)`);
        setEnrichExhausted(true);
        return;
      }
      const delay = Math.min(1500 * attempt, 6000);
      if (enrichRetryTimer.current) clearTimeout(enrichRetryTimer.current);
      enrichRetryTimer.current = setTimeout(() => setEnrichNonce((n) => n + 1), delay);
    };

    enrichServersFromUp4(servers, effectiveUp4)
      .then((enriched) => {
        // Always clear the in-flight latch FIRST, before any bail-out. If this
        // run was cancelled by a dependency change (e.g. the primary scrape
        // appending to `servers`) and we bailed here without resetting the
        // flag, the `enrichInFlightRef.current` guard above would stay latched
        // forever — no further enrichment, no retry — and anime4up servers
        // would never appear until a manual refresh.
        enrichInFlightRef.current = false;
        // Note: deliberately NOT bailing on `cancelled` alone. A cancelled run
        // on the SAME episode still merges its result below (the append-only
        // merge against the latest state is safe), because the effect run that
        // cancelled us already bailed on the in-flight latch — nobody else
        // will deliver these servers or schedule a retry.
        if (leftEpisode()) return;
        // Merge into the LATEST state, append-only, deduped by URL. A second
        // enrichment run can capture a stale `servers` snapshot; replacing
        // wholesale with its result would wipe out anime4up servers an earlier
        // run already added whenever the flaky anime4up scrape comes back
        // short. Merging instead means no run can ever drop servers another
        // run contributed.
        let added = 0;
        setServers((prev) => {
          const have = new Set(prev.map((s) => s.iframeUrl));
          const additions = enriched.filter((s) => !have.has(s.iframeUrl));
          added = additions.length;
          if (additions.length === 0) return prev;
          console.info(`[player] enriched: +${additions.length} anime4up servers (${prev.length + additions.length} total)`);
          return [...prev, ...additions];
        });
        // The flaky anime4up scrape came back empty — try again shortly.
        if (added === 0) {
          console.warn(`[player] anime4up enrichment empty (attempt ${attempt}), scheduling retry`);
          scheduleRetry();
        }
      })
      .catch((e) => {
        enrichInFlightRef.current = false;
        if (leftEpisode()) return;
        console.warn(`[player] anime4up enrichment threw (attempt ${attempt}), scheduling retry`, e);
        scheduleRetry();
      });
    // No cleanup: a re-fired run bails on the in-flight latch, and the settled
    // handlers above decide staleness from leftEpisode(), not a cancel flag.
    // `servers` is deliberately NOT a dependency. The primary witanime scrape
    // appends to `servers` moments after enrichment starts; with `servers` as a
    // dep that append cancels the in-flight run and re-fires the effect, which
    // both wastes an anime4up round-trip and (previously) latched the in-flight
    // guard. enrichServersFromUp4 only reads `servers` to seed its dedup set,
    // and the setServers merge above re-dedups against the LATEST state, so
    // running with a slightly stale snapshot is harmless. Omitting it stops a
    // fast-resolved up4 URL (cache / harvest) from racing the primary scrape.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveUp4, episodeUrl, up4ServerCount, enrichNonce]);

  // ── anime3rb enrichment ──
  // Third server source, fully independent of the witanime/anime4up chains:
  // anime3rb episode URLs are constructible from the anime title + episode
  // number alone (/episode/<slug>/<n>), so there is no sibling-matching or
  // harvested-link machinery — just resolve + fetch with the same
  // retry-on-backoff-until-deadline shape as the other sources. The title
  // resolution is cached in api.ts, so retries and later episodes are cheap.
  const A3RB_RETRY_DEADLINE_MS = 2 * 60 * 1000;
  const a3rbAttemptsRef = useRef(0);
  const a3rbStartedAtRef = useRef(0);
  const a3rbInFlightRef = useRef(false);
  const a3rbRetryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [a3rbNonce, setA3rbNonce] = useState(0);
  const a3rbServerCount = useMemo(
    () => servers.filter((s) => s.source === "anime3rb").length,
    [servers],
  );
  useEffect(() => {
    a3rbAttemptsRef.current = 0;
    a3rbStartedAtRef.current = 0;
    a3rbInFlightRef.current = false;
    if (a3rbRetryTimer.current) { clearTimeout(a3rbRetryTimer.current); a3rbRetryTimer.current = null; }
  }, [episodeUrl, retryServersNonce]);
  useEffect(() => () => { if (a3rbRetryTimer.current) clearTimeout(a3rbRetryTimer.current); }, []);

  useEffect(() => {
    if (currentEpNumber == null) return;        // can't construct an episode URL
    if (a3rbServerCount > 0) return;            // already enriched successfully
    if (a3rbInFlightRef.current) return;        // a run is already going
    if (a3rbStartedAtRef.current && Date.now() - a3rbStartedAtRef.current > A3RB_RETRY_DEADLINE_MS) return;
    // Slug-derived title lets this fire on mount; the effect re-runs with the
    // real title once the scrape reports it (and the resolution caches by
    // title, so the re-run is a different cache key — both stay cheap).
    const title = meta.animeTitle || animeTitleFromDetail || slugTitle;
    if (!title) return;
    const epAtStart = episodeUrl;
    // Same staleness rule as the anime4up enrichment: only the user actually
    // leaving this episode makes the result unwanted — a dep-change re-fire
    // bails on the in-flight latch, so the settled handler must still merge.
    const leftEpisode = () => unmountedRef.current || episodeUrlRef.current !== epAtStart;
    a3rbInFlightRef.current = true;
    if (!a3rbStartedAtRef.current) a3rbStartedAtRef.current = Date.now();
    a3rbAttemptsRef.current += 1;
    const attempt = a3rbAttemptsRef.current;
    console.info(`[player] resolving anime3rb servers for "${title}" ep ${currentEpNumber} (attempt ${attempt})`);
    const scheduleRetry = () => {
      if (leftEpisode()) return;
      if (Date.now() - a3rbStartedAtRef.current > A3RB_RETRY_DEADLINE_MS) {
        console.warn(`[player] anime3rb enrichment gave up after ${attempt} attempts`);
        return;
      }
      const delay = Math.min(4000 * attempt, 15000);
      if (a3rbRetryTimer.current) clearTimeout(a3rbRetryTimer.current);
      a3rbRetryTimer.current = setTimeout(() => setA3rbNonce((n) => n + 1), delay);
    };
    fetchAnime3rbServers(title, currentEpNumber)
      .then((found) => {
        a3rbInFlightRef.current = false;
        if (leftEpisode()) return;
        if (found.length === 0) { scheduleRetry(); return; }
        setServers((prev) => {
          const have = new Set(prev.map((s) => s.iframeUrl));
          const additions = found
            .filter((s) => !have.has(s.iframeUrl))
            .map((s, i) => ({ ...s, id: `a3rb_${prev.length + i}`, source: "anime3rb" }));
          if (additions.length === 0) return prev;
          console.info(`[player] enriched: +${additions.length} anime3rb server(s) (${prev.length + additions.length} total)`);
          return [...prev, ...additions];
        });
      })
      .catch((e) => {
        a3rbInFlightRef.current = false;
        if (leftEpisode()) return;
        console.warn(`[player] anime3rb enrichment threw (attempt ${attempt}), scheduling retry`, e);
        scheduleRetry();
      });
    // No cleanup — same rationale as the anime4up enrichment effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentEpNumber, a3rbServerCount, episodeUrl, retryServersNonce, meta.animeTitle, animeTitleFromDetail, slugTitle, a3rbNonce]);

  // Auto-pick the highest-ranked NON-broken server (highlight only).
  useEffect(() => {
    if (sortedServers.length === 0) return;
    const firstGood = sortedServers.findIndex((s) => !brokenIds.has(s.id));
    if (firstGood >= 0 && activeIdx === null) {
      setActiveIdx(firstGood);
    }
  }, [sortedServers, brokenIds, activeIdx]);

  // Pre-resolve the auto-picked server the moment it's known, so the user's
  // Play click serves a cached stream URL instantly instead of kicking off
  // extraction. resolveVideo caches by embed URL (RESOLVE_TTL), so the click
  // path reuses this result or the still-in-flight promise. Capped at 2
  // distinct servers per episode (the pick can shift as anime4up servers
  // stream in) so we never burn scraper slots speculatively.
  const prefetchedRef = useRef<Set<string>>(new Set());
  useEffect(() => { prefetchedRef.current = new Set(); }, [episodeUrl]);
  useEffect(() => {
    if (userActivated) return;            // real resolve flow has taken over
    if (activeIdx === null) return;
    const srv = sortedServers[activeIdx];
    if (!srv) return;
    if (prefetchedRef.current.has(srv.iframeUrl) || prefetchedRef.current.size >= 2) return;
    prefetchedRef.current.add(srv.iframeUrl);
    console.info(`[player] prefetching resolve for ${srv.provider}`);
    resolveVideo(srv.iframeUrl, srv.provider).catch(() => {});
  }, [sortedServers, activeIdx, userActivated, episodeUrl]);

  const activateServer = useCallback((idx: number) => {
    setActiveIdx(idx);
    setUserActivated(true);
    setResolved(null);
    setStatus("resolving");
    setRetryNonce((n) => n + 1);
    reextractCount.current = 0;
    iframeFailedRef.current = false;
    setIframeLoaded(false);
  }, []);

  const advanceToNext = useCallback(() => {
    if (activeIdx === null) return;
    const failedId = sortedServers[activeIdx]?.id;
    if (failedId) setBrokenIds((prev) => new Set(prev).add(failedId));
    setStatus("failed");
  }, [activeIdx, sortedServers]);

  // Fast advance when iframe fails to load (did-fail-load in main process).
  // Fires within ~1s vs the iframe onError which takes ~5s on some platforms.
  useEffect(() => {
    const off = window.pantoufa.onIframeFailed(({ url }) => {
      // The embed already loaded successfully — this failure is an internal
      // redirect/sub-navigation, not the embed dying. Keep playing.
      if (iframeLoadedRef.current) {
        console.info(`[player] ignoring post-load iframe failure (embed already loaded): ${url}`);
        return;
      }
      // Don't advance instantly — the embed may fail its first navigation and
      // then load. Wait a grace window; if onLoad fires meanwhile (which clears
      // this timer) we keep the embed. Only a still-unloaded iframe advances.
      if (pendingAdvanceTimer.current) return; // already scheduled
      console.info(`[player] main process reports iframe failure, scheduling advance: ${url}`);
      pendingAdvanceTimer.current = setTimeout(() => {
        pendingAdvanceTimer.current = null;
        if (iframeLoadedRef.current) {
          console.info(`[player] iframe recovered during grace window, not advancing: ${url}`);
          return;
        }
        console.info(`[player] iframe failure confirmed, advancing: ${url}`);
        iframeFailedRef.current = true;
        advanceToNext();
      }, 3000);
    });
    return () => {
      off();
      if (pendingAdvanceTimer.current) { clearTimeout(pendingAdvanceTimer.current); pendingAdvanceTimer.current = null; }
    };
  }, [advanceToNext]);

  // Tell the main process which iframe URL is currently active so
  // did-fail-load can ignore sub-resource failures (ad iframes inside
  // embed pages) and only fast-advance for the actual embed iframe.
  useEffect(() => {
    const url = resolved?.type === "iframe" ? resolved.url : null;
    // New embed mounting — it hasn't loaded yet, so honor did-fail-load until
    // its onLoad fires (a genuine "can't connect" failure happens pre-load).
    if (url) iframeLoadedRef.current = false;
    // Drop any failure-advance scheduled for the previous embed.
    if (pendingAdvanceTimer.current) { clearTimeout(pendingAdvanceTimer.current); pendingAdvanceTimer.current = null; }
    window.pantoufa.setActiveIframe(url);
  }, [resolved?.url, resolved?.type]);

  // Resolve the active server only after user clicks (lazy-load to prevent
  // tokenized stream URLs from expiring while the user is reading the page).
  useEffect(() => {
    if (!userActivated) return;
    if (activeIdx === null || !sortedServers[activeIdx]) return;
    const srv = sortedServers[activeIdx];
    let cancelled = false;
    setResolved(null);
    setStatus("resolving");

    // Extraction is intermittently flaky: a transient Cloudflare check or a
    // slow embed can make a provider we CAN normally extract come back as an
    // iframe fallback (or throw). That used to silently drop the custom player
    // to the embed / advance, so the user had to manually re-click until
    // extraction happened to succeed. For cheap-to-extract providers we now
    // re-extract once automatically (busting the cache first) so the direct
    // stream lands on its own.
    (async () => {
      const fastRetry = FAST_REEXTRACT_PROVIDERS.has(srv.provider);
      const MAX_ATTEMPTS = fastRetry ? 2 : 1;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const r = await resolveVideo(srv.iframeUrl, srv.provider);
          if (cancelled) return;
          if (r.success && r.data?.videoUrl) {
            const gotDirect = r.data.type === "hls" || r.data.type === "mp4";
            // Expected a direct stream but got the iframe fallback → extraction
            // missed this round. Re-extract once before accepting the embed.
            if (!gotDirect && fastRetry && attempt < MAX_ATTEMPTS) {
              console.warn(`[player] ${srv.provider}: iframe fallback, re-extracting (attempt ${attempt}/${MAX_ATTEMPTS})`);
              invalidateResolveCache(srv.iframeUrl);
              await new Promise((res) => setTimeout(res, 800));
              continue;
            }
            console.info(`[player] ${srv.provider}: ${r.data.type} → ${r.data.videoUrl}`);
            setResolved({
              url: r.data.videoUrl,
              type: r.data.type as "hls" | "mp4" | "dailymotion" | "iframe",
              embed: srv.iframeUrl,
            });
            setStatus("playing");
            return;
          }
          // Extraction came up totally empty — retry once if cheap, else advance.
          if (attempt < MAX_ATTEMPTS) {
            console.warn(`[player] ${srv.provider}: extraction empty, retrying (attempt ${attempt}/${MAX_ATTEMPTS})`);
            invalidateResolveCache(srv.iframeUrl);
            await new Promise((res) => setTimeout(res, 800));
            continue;
          }
          console.warn(`[player] ${srv.provider}: extraction empty, advancing`);
          advanceToNext();
          return;
        } catch (e) {
          if (cancelled) return;
          if (attempt < MAX_ATTEMPTS) {
            console.warn(`[player] ${srv.provider}: resolve threw, retrying (attempt ${attempt}/${MAX_ATTEMPTS})`, e);
            invalidateResolveCache(srv.iframeUrl);
            await new Promise((res) => setTimeout(res, 800));
            continue;
          }
          console.warn(`[player] ${srv.provider}: resolve threw, advancing`, e);
          advanceToNext();
          return;
        }
      }
    })();

    return () => { cancelled = true; };
  }, [activeIdx, sortedServers, advanceToNext, retryNonce]);

  // Mark the embed we're capturing for once the iframe is rendering.
  // The captured-URL listener uses this to ignore stale captures from
  // a previous server / page. Also mute the window so the user doesn't
  // hear ad audio from the hidden iframe while it bootstraps the
  // Iframe-mount lifecycle. Advances to the next server if the embed
  // failed to load (set by iframe.onError → iframeFailedRef). Audio is
  // unmuted on mount so the user hears the embed's playback.
  useEffect(() => {
    if (resolved?.type !== "iframe") return;
    setMutedSafe(false);
    if (iframeFailedRef.current) advanceToNext();
  }, [resolved, advanceToNext]);

  // Some embed pages keep ad iframes loading forever, so `iframe.onLoad`
  // never fires and the "Loading embed player…" spinner gets stuck on
  // top of an already-usable player. Force-clear the spinner after a
  // grace period — the iframe is the source of truth from that point.
  useEffect(() => {
    if (resolved?.type !== "iframe") return;
    const t = setTimeout(() => setIframeLoaded(true), 8000);
    return () => clearTimeout(t);
  }, [resolved]);

  // Unmute the window when we swap from iframe → custom player so the
  // user hears their show, and on unmount so leaving the page doesn't
  // leave the system muted.
  useEffect(() => {
    if (resolved && resolved.type !== "iframe") setMutedSafe(false);
  }, [resolved]);
  useEffect(() => () => setMutedSafe(false), []);

  // Mirror `resolved` into a ref so the swap effect can read it
  // without re-firing on every resolved change. Without this, a
  // re-extract that flips resolved back to iframe causes the swap
  // effect to immediately re-fire with the OLD capturedStream — the
  // stale URL whose token just expired — and the player goes right
  // back into the failure loop.
  const resolvedRef = useRef(resolved);
  useEffect(() => { resolvedRef.current = resolved; }, [resolved]);

  // Centralized re-extract trigger. Counts attempts so we don't loop
  // forever on a doomed server; once the budget is spent we fall back
  // to the iframe so the user keeps seeing video instead of a stuck
  // loading spinner. The `fallbackReload` bump forces the iframe to
  // remount even when `resolved.url` happens to equal the embed URL
  // already (same-URL React reconciliation would otherwise reuse the
  // old element with its expired player state).
  const triggerReextract = useCallback((reason: string) => {
    if (reextractUsedRef.current) return;
    reextractUsedRef.current = true;
    reextractCount.current += 1;

    const embed = resolvedRef.current?.embed;

    if (reextractCount.current > MAX_REEXTRACTS_BEFORE_FALLBACK) {
      console.warn(
        `[player] ${reason}: re-extract budget exhausted (${reextractCount.current}), falling back to iframe`,
      );
      if (embed) {
        setFallbackReload((n) => n + 1);
        setResolved({ url: embed, type: "iframe", embed });
      } else {
        advanceToNext();
      }
      return;
    }

    console.warn(`[player] ${reason}: re-extracting (attempt ${reextractCount.current})`);
    import("../lib/api").then(({ invalidateResolveCache }) => {
      if (embed) invalidateResolveCache?.(embed);
      setRetryNonce((n) => n + 1);
    });
  }, [advanceToNext]);

  // Wire HLS / direct mp4 + stall watchdog. Skip when an iframe is
  // rendering — the provider's own player handles itself.
  useEffect(() => {
    if (!resolved || !videoRef.current) return;
    if (resolved.type === "dailymotion" || resolved.type === "iframe") return;
    const v = videoRef.current;
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    const proxied = proxify(resolved.url, resolved.embed);
    // Reset re-extract gate for the new stream — covers both HLS and
    // mp4 paths so the second error path also has a recovery shot.
    reextractUsedRef.current = false;

    let played = false;
    let advanced = false;
    let lastTime = 0;
    let lastTimeUpdate = Date.now();
    // Mid-stream stalls on progressive direct streams get an in-place reload
    // before we give up on the server (see checkStall).
    let inPlaceRecoveries = 0;
    const MAX_INPLACE_RECOVERIES = 2;
    // Absolute wall clock for initial load. Even if `progress` events
    // keep firing (slow CDN dripping bytes), we still hard-advance once
    // this elapses without `playing` firing. Without this the player
    // could buffer forever on a half-working stream.
    const loadStartedAt = Date.now();
    const INITIAL_LOAD_DEADLINE_MS = 22000;

    const checkStall = () => {
      if (advanced) return;
      const now = Date.now();
      const isInitialLoading = !played && !v.paused;
      const isBufferingMidStream = played && !v.paused && !v.ended && v.currentTime === lastTime;

      if (isInitialLoading && now - loadStartedAt > INITIAL_LOAD_DEADLINE_MS) {
        advanced = true;
        console.warn(`[player] Initial load exceeded ${INITIAL_LOAD_DEADLINE_MS}ms — advancing`);
        advanceToNext();
        return;
      }

      if (isInitialLoading || isBufferingMidStream) {
        const elapsed = now - lastTimeUpdate;
        if (elapsed > STALL_THRESHOLD_MS) {
          // Mid-stream stall on a progressive direct stream (vid3rb /
          // mp4upload / videa): these CDNs throttle throughput to ~2.5× the
          // file bitrate and intermittently drop connections, and Chromium
          // sometimes never revives the dropped media request on its own.
          // The signed URL is still valid (tokens live ~40 min), so reload
          // the SAME source in place and seek back instead of yanking the
          // user to a different server — vid3rb's "keeps loading" symptom.
          if (isBufferingMidStream && resolved.type !== "hls" && inPlaceRecoveries < MAX_INPLACE_RECOVERIES) {
            inPlaceRecoveries++;
            const pos = v.currentTime;
            console.warn(`[player] mid-stream stall ${elapsed}ms — in-place reload #${inPlaceRecoveries} @ ${pos.toFixed(1)}s`);
            try {
              v.load();
              v.addEventListener("loadedmetadata", () => {
                try {
                  if (pos > 0 && v.duration > 0 && pos < v.duration) v.currentTime = pos;
                  v.play().catch(() => {});
                } catch {}
              }, { once: true });
            } catch {}
            lastTimeUpdate = Date.now();
            return;
          }
          advanced = true;
          console.warn(`[player] Stalled for ${elapsed}ms (initial=${isInitialLoading}) — advancing to next server`);
          advanceToNext();
        }
      } else {
        lastTime = v.currentTime;
        lastTimeUpdate = now;
      }
    };

    const onPlaying = () => {
      played = true;
      lastTime = v.currentTime;
      lastTimeUpdate = Date.now();
    };

    const onTimeUpdate = () => {
      if (v.currentTime !== lastTime) {
        lastTime = v.currentTime;
        lastTimeUpdate = Date.now();
      }
    };

    const onProgress = () => {
      if (!played) {
        lastTimeUpdate = Date.now();
      }
    };

    // Fast recovery for chunk drops — the `stalled` event fires when the
    // browser can't download data quickly enough (unlike the 15s stall
    // timer which is the last resort). This catches transient CDN drops.
    const onStalled = () => {
      console.warn("[player] video stalled — chunk drop detected, attempting recovery");
      if (v.paused) {
        v.play().catch(() => {});
      }
      lastTimeUpdate = Date.now();
    };

    v.addEventListener("playing", onPlaying);
    v.addEventListener("timeupdate", onTimeUpdate);
    v.addEventListener("progress", onProgress);
    v.addEventListener("stalled", onStalled);
    
    const interval = setInterval(checkStall, 1000);

    if (resolved.type === "hls" && Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        startLevel: -1,
        backBufferLength: 90,
        // Bigger forward cushion to mask the throttled anime3rb/vid3rb CDN —
        // accumulate surplus during the throttled download so a delayed or
        // dropped fragment never surfaces as a mid-stream stall. (Mirrors the
        // mobile expo-video 300s forward-buffer change.)
        maxBufferLength: 90,
        maxMaxBufferLength: 600,
        // Don't let the 60MB default byte cap clip the 1080p cushion before the
        // time target is reached — let buffer time win over size.
        maxBufferSize: 120 * 1000 * 1000,
        // Generous timeouts.
        manifestLoadingTimeOut: 20000,
        manifestLoadingMaxRetry: 3,
        manifestLoadingRetryDelay: 1500,
        levelLoadingTimeOut: 20000,
        levelLoadingMaxRetry: 3,
        levelLoadingRetryDelay: 1500,
        // Bumped fragment retries — transient CDN errors are common.
        // 5 retries × 2s backoff = 10s of trying before declaring fatal.
        fragLoadingTimeOut: 30000,
        fragLoadingMaxRetry: 5,
        fragLoadingRetryDelay: 2000,
        // Proxy handles cookies/Referer — renderer XHR doesn't need creds.
        xhrSetup: (xhr) => { xhr.withCredentials = false; },
      });
      let recoveryUsed = false;
      let mediaRecoveryCount = 0;
      let networkRecoveryCount = 0;
      hls.loadSource(proxied);
      hls.attachMedia(v);
      hls.on(Hls.Events.FRAG_LOADED, () => { if (!played) lastTimeUpdate = Date.now(); });
      hls.on(Hls.Events.LEVEL_LOADED, () => { if (!played) lastTimeUpdate = Date.now(); });
      hls.on(Hls.Events.MANIFEST_PARSED, () => { if (!played) lastTimeUpdate = Date.now(); });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        // Non-fatal network errors — chunk drop, buffer stall, slow CDN.
        // Auto-run startLoad() to kick the stream back to life. When the
        // 8x limit is reached, do a hard reset: detach media, bust the URL
        // cache with a fresh timestamp, and re-attach. This forces
        // Chromium and hls.js to treat it as a completely new stream.
        if (!data.fatal) {
          // If the response carries a 401/403/410 status, the token is
          // expired regardless of whether hls.js considers it fatal.
          // Skip the recovery loop — retrying a dead URL wastes ~22s.
          const nfStatus = (data.response as any)?.code;
          if (nfStatus === 410 || nfStatus === 403 || nfStatus === 401) {
            triggerReextract(`HLS auth error ${nfStatus} (non-fatal)`);
            return;
          }
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            networkRecoveryCount++;
            if (networkRecoveryCount <= 8) {
              console.warn(`[player] non-fatal network ${data.details}, startLoad #${networkRecoveryCount}`);
              try { hls.startLoad(); } catch {}
            } else if (networkRecoveryCount <= 11) {
              console.warn(`[player] hard-resetting HLS engine (retry #${networkRecoveryCount})`);
              try { hls.detachMedia(); } catch {}
              const fresh = proxied.replace(
                /([?&])_p=\d+_[a-z0-9]+/,
                `$1_p=${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
              );
              const freshUrl = fresh.includes("?") ? fresh : `${fresh}?_p=${Date.now()}`;
              try { hls.loadSource(freshUrl); } catch {}
              try { hls.attachMedia(v); } catch {}
            } else {
              triggerReextract("hard recovery exhausted");
            }
          }
          return;
        }

        // Fatal from here on.

        // Proxy returned 410/403/401 → signed URL expired or rejected.
        const status = (data.response as any)?.code;
        if (status === 410 || status === 403 || status === 401) {
          triggerReextract(`HLS auth error ${status}`);
          return;
        }

        // Media errors — fragment parsing, decode failures. Recover up to 3x.
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          mediaRecoveryCount++;
          if (mediaRecoveryCount <= 3) {
            console.warn(`[player] media error (${data.details}), recoverMediaError #${mediaRecoveryCount}`);
            hls.recoverMediaError();
            return;
          }
        }

        // Network errors — manifest/level load timeouts. Recover up to 2x.
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          if (!recoveryUsed) {
            recoveryUsed = true;
            console.warn("[player] HLS fatal network, startLoad attempt", data.details);
            try { hls.startLoad(); } catch { advanced = true; advanceToNext(); }
            return;
          }
        }

        // All recoveries exhausted. Re-extract once before advancing.
        if (!reextractUsedRef.current) {
          triggerReextract("HLS all recoveries exhausted");
        } else {
          advanced = true; advanceToNext();
        }
      });
      hlsRef.current = hls;
    } else {
      // Progressive MP4. mp4upload serves a single large file over a slow,
      // non-standard port (:183). Routing it through the proxy means the
      // proxy buffers the WHOLE file via arrayBuffer() before returning a
      // byte, which blows past its 15-20s watchdog → all strategies abort →
      // 502 Bad Gateway → DEMUXER_ERROR_COULD_NOT_OPEN. Load it directly
      // instead: Chromium's native networking streams it with Range/partial
      // content, and the onBeforeSendHeaders interceptor still forces the
      // canonical www.mp4upload.com Referer on the <video> media request.
      //
      // videa also plays direct, for a different reason: pantoufa-video://
      // subresources are BLOCKED by Chromium from web (http://localhost dev)
      // origins with ERR_UNKNOWN_URL_SCHEME — the <video> dies instantly
      // with "Format error" (code 4) and we advance past a perfectly good
      // stream. (Packaged builds load from file://, where the custom scheme
      // works — which is why this only ever bit in dev.) videa's signed
      // static URL needs no cookies and accepts any/no Referer (verified:
      // 302 → videoN.videa.hu edge → 206 even with a localhost Referer),
      // so native streaming works in BOTH dev and packaged builds — and
      // skips the proxy's 4MB arrayBuffer chunking for a ~100MB file.
      // Other MP4 providers keep the proxy (they need its Referer/Origin
      // strategy racing and cookie sharing).
      // vid3rb also plays direct: its signed CDN URLs answer Range requests,
      // need no Referer/cookies and aren't IP-locked (noip=yes) — while the
      // proxy would buffer the whole ~300MB file before the first byte.
      const playsDirect = /mp4upload|videa\.hu|vidvaita|vidit|vid3rb\.com/i.test(resolved.url);
      v.src = playsDirect ? resolved.url : proxied;
    }

    return () => {
      clearInterval(interval);
      v.removeEventListener("playing", onPlaying);
      v.removeEventListener("timeupdate", onTimeUpdate);
      v.removeEventListener("progress", onProgress);
      v.removeEventListener("stalled", onStalled);
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    };
  }, [resolved, advanceToNext]);

  // Resume position — wait for metadata before seeking.
  useEffect(() => {
    if (!episodeUrl || !videoRef.current || !resolved) return;
    const v = videoRef.current;
    let cancelled = false;

    const doSeek = () => {
      if (cancelled) return;
      getProgress(episodeUrl).then((p) => {
        if (cancelled || !v) return;
        if (!p || p.positionMs < 5000) return;
        const target = p.positionMs / 1000;
        // Only seek if metadata is available and the target is valid.
        if (v.duration > 0 && target < v.duration) {
          try { v.currentTime = target; } catch {}
        } else {
          // Retry after metadata loads.
          const onMeta = () => {
            try {
              if (v.duration > 0 && target < v.duration) v.currentTime = target;
            } catch {}
            v.removeEventListener("loadedmetadata", onMeta);
          };
          v.addEventListener("loadedmetadata", onMeta, { once: true });
        }
      }).catch(() => {});
    };

    if (v.duration > 0) {
      doSeek();
    } else {
      v.addEventListener("loadedmetadata", doSeek, { once: true });
    }

    return () => { cancelled = true; };
  }, [episodeUrl, resolved]);

  // Wire video element ↔ custom-player React state
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onTime = () => setCurrentTime(v.currentTime);
    const onDur = () => setDuration(v.duration || 0);
    const onProg = () => {
      try {
        if (v.buffered.length > 0) setBuffered(v.buffered.end(v.buffered.length - 1));
      } catch {}
    };
    const onVol = () => { setVolume(v.volume); setMuted(v.muted); };
    const onRate = () => setPlaybackRate(v.playbackRate);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("durationchange", onDur);
    v.addEventListener("progress", onProg);
    v.addEventListener("volumechange", onVol);
    v.addEventListener("ratechange", onRate);
    return () => {
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("durationchange", onDur);
      v.removeEventListener("progress", onProg);
      v.removeEventListener("volumechange", onVol);
      v.removeEventListener("ratechange", onRate);
    };
  }, [resolved]);

  // Marks the completion badge once per episode when the LAST episode crosses
  // the 80% watched bar — so it flips without a detail-page revisit.
  const completionMarkedRef = useRef(false);
  useEffect(() => { completionMarkedRef.current = false; }, [episodeUrl]);

  // Save progress every 10s (and at unmount).
  useEffect(() => {
    if (!videoRef.current || !episodeUrl) return;
    const v = videoRef.current;
    let last = 0;
    const onTime = () => {
      const now = Date.now();
      // Mark the anime caught-up/finished the moment this episode crosses the
      // 80% watched threshold (same bar history uses). If it's the latest
      // available episode, the poster badge flips immediately instead of
      // waiting for the user to reopen the detail page. recordEpisodeWatched is
      // a no-op unless a completion record exists and this is the last episode.
      if (!completionMarkedRef.current && isFinite(v.duration) && v.duration > 0 && v.currentTime / v.duration >= 0.8) {
        completionMarkedRef.current = true;
        recordEpisodeWatched({
          animeHref: resolvedAnimeHref || animeParam || "",
          animeTitle: meta.animeTitle || animeTitleFromDetail,
          epNum: currentEpNumber ?? null,
        }).catch(() => {});
      }
      if (now - last < 10000) return;
      last = now;
      if (!isFinite(v.duration)) return;
      saveProgress({
        episodeHref: episodeUrl,
        episodeTitle: meta.episodeTitle || `${t.episode}`,
        animeTitle: meta.animeTitle || animeTitleFromDetail,
        animeHref: animeParam || "",
        image: imgParam || posterFromDetail || "",
        positionMs: Math.floor(v.currentTime * 1000),
        durationMs: Math.floor(v.duration * 1000),
        url4up: up4Param || undefined,
        epNum: currentEpNumber ?? undefined,
      }).catch(() => {});
    };
    v.addEventListener("timeupdate", onTime);
    return () => v.removeEventListener("timeupdate", onTime);
  }, [episodeUrl, meta, up4Param, resolved, animeParam, imgParam, posterFromDetail, animeTitleFromDetail, resolvedAnimeHref, currentEpNumber]);

  // Auto-hide controls
  const scheduleHide = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setControlsVisible(false), 3500);
  }, []);
  // Surface the skip-intro pill and (re)start its independent auto-fade timer.
  // Called when the eligible window opens and on any mouse move / key activity.
  const bumpSkipIntro = useCallback(() => {
    setSkipIntroVisible(true);
    if (skipHideTimer.current) clearTimeout(skipHideTimer.current);
    skipHideTimer.current = setTimeout(() => setSkipIntroVisible(false), SKIP_PILL_VISIBLE_MS);
  }, []);
  const showControls = useCallback(() => {
    setControlsVisible(true);
    scheduleHide();
    bumpSkipIntro();
  }, [scheduleHide, bumpSkipIntro]);
  useEffect(() => { scheduleHide(); return () => { if (hideTimer.current) clearTimeout(hideTimer.current); if (skipHideTimer.current) clearTimeout(skipHideTimer.current); }; }, [scheduleHide]);

  // Fullscreen tracking — DOM event for our custom video player,
  // IPC for iframe-embed players (streamwish, mp4upload, etc.) where
  // the fullscreen request originates from a cross-origin iframe
  // that the parent document can't observe directly.
  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    const unsub = window.pantoufa.onFullscreenChanged((fs) => setIsFullscreen(fs));
    return () => {
      document.removeEventListener("fullscreenchange", onFs);
      unsub();
    };
  }, []);

  // Prev/next episode derivation — match by normalized href OR episode
  // number (URL encoding differences shouldn't break navigation).
  const { prev, next } = useMemo(() => {
    if (siblings.length === 0) return { prev: null as Episode | null, next: null as Episode | null };
    const norm = (u: string) => {
      if (!u) return "";
      try { return decodeURIComponent(u).replace(/\/+$/, ""); }
      catch { return u.replace(/\/+$/, ""); }
    };
    const byNum = [...siblings].sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
    const needle = norm(episodeUrl);
    let idx = byNum.findIndex((e) => norm(e.href || "") === needle);
    if (idx === -1) {
      const m = episodeUrl.match(/الحلقة[\s\-_]*(\d+)/);
      if (m) {
        const num = parseInt(m[1], 10);
        idx = byNum.findIndex((e) => e.number === num);
      }
    }
    if (idx === -1) return { prev: null, next: null };
    return {
      prev: idx > 0 ? byNum[idx - 1] : null,
      next: idx + 1 < byNum.length ? byNum[idx + 1] : null,
    };
  }, [siblings, episodeUrl]);

  const navTo = useCallback((ep: Episode) => {
    if (!ep.href) return;
    // Match the anime4up sibling by episode number. Do NOT try to derive
    // the URL by slug-swapping from the current up4Param: witanime and
    // anime4up use different episode slugs, so that yields a 404 that
    // then poisons enrichment. If there's no number match here the
    // destination page re-resolves it from up4Siblings on its own.
    const matching4 = up4Siblings.find((u) => u.number === ep.number)?.href ?? null;
    const p = new URLSearchParams();
    if (matching4) p.set("up4", matching4);
    if (ep.screenshot) p.set("img", ep.screenshot);
    if (animeParam) p.set("anime", animeParam);
    const qs = p.toString();
    navigate(`/watch/${encodeURIComponent(ep.href)}${qs ? `?${qs}` : ""}`);
  }, [up4Siblings, animeParam, navigate]);

  // ── Offline download of the current episode ──
  const [dlStatus, setDlStatus] = useState<DownloadStatus | null>(null);
  const [dlProgress, setDlProgress] = useState(0);
  useEffect(() => {
    if (!episodeUrl) { setDlStatus(null); setDlProgress(0); return; }
    let cancelled = false;
    const sync = () => {
      getDownloadByEpisode(episodeUrl).then((d) => {
        if (cancelled) return;
        setDlStatus(d?.status ?? null);
        setDlProgress(d?.progress ?? 0);
      });
    };
    sync();
    const unsub = subscribeDownloads(sync);
    return () => { cancelled = true; unsub(); };
  }, [episodeUrl]);

  const startEpisodeDownload = useCallback(() => {
    if (!episodeUrl) return;
    startDownload({
      animeTitle: meta.animeTitle || animeTitleFromDetail || "",
      episodeTitle: meta.episodeTitle || (currentEpNumber != null ? `${t.episode} ${currentEpNumber}` : ""),
      epNum: currentEpNumber,
      image: imgParam || posterFromDetail || "",
      animeHref: resolvedAnimeHref || "",
      episodeHref: episodeUrl,
      url4up: effectiveUp4 || undefined,
    });
  }, [episodeUrl, meta, animeTitleFromDetail, currentEpNumber, imgParam, posterFromDetail, resolvedAnimeHref, effectiveUp4]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current; if (!v) return;
    if (v.paused) v.play().catch(() => {}); else v.pause();
  }, []);
  const onSeek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = videoRef.current; if (!v || !duration) return;
    v.currentTime = Number(e.target.value);
  }, [duration]);
  const onVolumeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = videoRef.current; if (!v) return;
    const val = Number(e.target.value);
    v.volume = val;
    v.muted = val === 0;
  }, []);
  const toggleMute = useCallback(() => {
    const v = videoRef.current; if (!v) return;
    v.muted = !v.muted;
  }, []);
  const setRate = useCallback((r: number) => {
    const v = videoRef.current; if (!v) return;
    v.playbackRate = r;
    setShowRateMenu(false);
  }, []);
  const skip = useCallback((delta: number) => {
    const v = videoRef.current; if (!v) return;
    v.currentTime = Math.max(0, Math.min((v.duration || 0), v.currentTime + delta));
  }, []);
  const skipIntro = useCallback(() => {
    const v = videoRef.current; if (!v) return;
    const target = v.currentTime + INTRO_SKIP_SECONDS;
    v.currentTime = v.duration ? Math.min(v.duration - 1, target) : target;
    showControls();
  }, [showControls]);
  const toggleFs = useCallback(() => {
    const el = playerRef.current; if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else el.requestFullscreen().catch(() => {});
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      switch (e.key) {
        case " ": case "k": e.preventDefault(); togglePlay(); showControls(); break;
        case "ArrowLeft": e.preventDefault(); skip(-10); showControls(); break;
        case "ArrowRight": e.preventDefault(); skip(10); showControls(); break;
        case "ArrowUp": {
          const v = videoRef.current; if (!v) return;
          e.preventDefault(); v.volume = Math.min(1, v.volume + 0.1); showControls(); break;
        }
        case "ArrowDown": {
          const v = videoRef.current; if (!v) return;
          e.preventDefault(); v.volume = Math.max(0, v.volume - 0.1); showControls(); break;
        }
        case "m": toggleMute(); showControls(); break;
        case "f": toggleFs(); break;
        case "Escape":
          if (isFullscreen && resolved?.type === "iframe") {
            e.preventDefault();
            toggleFs();
          }
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, skip, toggleMute, toggleFs, showControls]);

  const active = activeIdx !== null ? sortedServers[activeIdx] : null;
  const allBroken = sortedServers.length > 0 && sortedServers.every((s) => brokenIds.has(s.id));
  const animeTitle = meta.animeTitle || animeTitleFromDetail;
  // We expect anime4up servers (cross-source) but haven't landed any yet and
  // the retry loop hasn't given up — show a subtle "still searching" hint so
  // the user knows more servers are on the way.
  const searchingMoreServers =
    !!effectiveUp4 && !/anime4up/i.test(episodeUrl) && up4ServerCount === 0 && !enrichExhausted;
  // The "Skip Intro" affordance is eligible only in the custom player, during
  // the opening window (wide enough to catch cold-open/late openings), and only
  // for episodes long enough that an 85s jump won't overshoot the whole thing.
  // Actual visibility is gated by the auto-fade timer (skipIntroVisible).
  const showSkipIntroEligible =
    !!resolved && resolved.type !== "iframe" && resolved.type !== "dailymotion" &&
    duration > INTRO_WINDOW_END_SECONDS && currentTime > 1 && currentTime < INTRO_WINDOW_END_SECONDS;
  // Pop the pill up when the eligible window opens (and tuck it away when it
  // closes) without waiting for a mouse move.
  useEffect(() => {
    if (showSkipIntroEligible) bumpSkipIntro();
    else setSkipIntroVisible(false);
  }, [showSkipIntroEligible, bumpSkipIntro]);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 lg:flex-row lg:items-start">
      <div className="min-w-0 flex-1 space-y-4">
      {/* Top breadcrumb */}
      <div className="flex items-center gap-3">
        <Link to="/" className="text-text-muted hover:text-white">→ {t.home}</Link>
        {resolvedAnimeHref && (
          <Link
            to={`/anime/${encodeURIComponent(resolvedAnimeHref)}`}
            className="line-clamp-1 text-sm font-semibold text-accent hover:underline"
          >
            ← {animeTitle || t.openAnimePage}
          </Link>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-display text-base font-bold text-white">
            {meta.episodeTitle || t.loading}
          </h1>
        </div>
      </div>

      {/* Custom player — force LTR so seek bar fills left→right and
          prev/play/next buttons stay in their natural order regardless
          of the page-wide RTL direction. Also hide the mouse cursor
          while playing + controls hidden, restore on mousemove. */}
      <div
        ref={playerRef}
        dir="ltr"
        className={`group relative aspect-video w-full overflow-hidden rounded-xl border border-white/10 bg-black shadow-card ${
          isFullscreen && resolved?.type === "iframe"
            ? "!fixed !inset-0 !z-[9999] !h-screen !w-screen !rounded-none !border-none !aspect-auto"
            : ""
        } ${
          isPlaying && !controlsVisible ? "cursor-none" : "cursor-default"
        }`}
        onMouseMove={showControls}
        onMouseLeave={() => { if (isPlaying) setControlsVisible(false); }}
      >
        {status === "playing" && resolved ? (
          resolved.type === "iframe" || resolved.type === "dailymotion" ? (
            /* Iframe playback path.
             *
             * In "capturing" mode the iframe is rendered but visually
             * hidden — its only job is to bootstrap the provider's
             * player so we can intercept the real stream URL. While it
             * runs, the user sees a loading state on top.
             *
             * If we capture a URL, this branch disappears entirely
             * (resolved.type flips to "hls"/"mp4") and the <video>
             * branch below takes over.
             *
             * If 12s pass without a capture, captureMode flips to
             * "iframe-fallback" and the iframe becomes the user's
             * actual playback surface. Dailymotion is always rendered
             * as fallback — we never attempt the swap for it.
             */
             <>
               <iframe
                 key={`${resolved.url}-${fallbackReload}`}
                 src={resolved.url}
                 allowFullScreen
                 allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
                 onLoad={() => {
                   console.info(`[player] iframe loaded: ${resolved.url}`);
                   iframeLoadedRef.current = true;
                   setIframeLoaded(true);
                   // Cancel any pending failure-advance — the embed is alive.
                   if (pendingAdvanceTimer.current) {
                     clearTimeout(pendingAdvanceTimer.current);
                     pendingAdvanceTimer.current = null;
                   }
                 }}
                 onError={() => {
                   console.warn(`[player] iframe failed to load: ${resolved.url}`);
                   iframeFailedRef.current = true;
                   advanceToNext();
                 }}
                 className="h-full w-full border-0 bg-black"
                 title={`${active ? displayName(active) : "Video"} player`}
              />
               {!iframeLoaded && resolved.type === "iframe" && (
                 <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/95 text-text-muted">
                   <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                   <p className="text-sm">Loading embed player…</p>
                 </div>
               )}
               {/* Fullscreen overlay button for iframe embeds — cross-origin
                   fullscreen requests from inside the iframe can't be detected
                   by the parent document, so we provide our own fullscreen
                   toggle that reliably fills the entire screen. */}
               {iframeLoaded && !isFullscreen && (
                 <button
                   onClick={(e) => { e.stopPropagation(); toggleFs(); }}
                   className="absolute bottom-3 right-3 z-30 rounded-lg bg-black/70 p-2 text-white/80 backdrop-blur-sm transition hover:bg-black/90 hover:text-white border border-white/10"
                   title="Fullscreen"
                 >
                   <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" /></svg>
                 </button>
               )}
             </>
          ) : (
          <>
            <video
              ref={videoRef}
              autoPlay
              playsInline
              preload="auto"
              // No crossOrigin attribute — for direct mp4 src via our custom
              // pantoufa-video:// scheme, the CORS check fails even though
              // we set ACAO:*. Without crossOrigin the browser uses no-CORS
              // mode and just decodes the response.
              className="h-full w-full bg-black"
              onClick={togglePlay}
              onDoubleClick={toggleFs}
              onError={(e) => {
                const err = (e.target as HTMLVideoElement).error;
                const code = err?.code;
                console.warn(`[player] <video> error code=${code} message=${err?.message || ""}`);
                // Code 2 (MEDIA_ERR_NETWORK): proxy returned 410/403 → signed URL expired.
                // Code 3 (MEDIA_ERR_DECODE): a transient mid-stream proxy 502 / dropped chunk
                // often surfaces here, NOT as a true decode failure — so try one re-extract
                // before abandoning the server (triggerReextract is budgeted and falls back
                // to the iframe / advances once its retry budget is spent, so this can't loop).
                if ((code === 2 || code === 3) && resolved.url) {
                  triggerReextract(`mp4 ${code === 2 ? "network" : "decode"} error code=${code}`);
                  return;
                }
                if (code === 4) advanceToNext();
              }}
            />
            {/* Top title bar — fades with the controls */}
            <div
              className={`pointer-events-none absolute inset-x-0 top-0 flex items-start gap-3 bg-gradient-to-b from-black/80 via-black/25 to-transparent px-5 pb-12 pt-4 transition-opacity duration-300 ${
                controlsVisible || !isPlaying ? "opacity-100" : "opacity-0"
              }`}
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-white drop-shadow-md">
                  {meta.episodeTitle || animeTitle || ""}
                </p>
                {meta.episodeTitle && animeTitle && (
                  <p className="truncate text-xs text-white/55">{animeTitle}</p>
                )}
              </div>
              {active && (
                <span className="ms-auto shrink-0 rounded-full border border-white/10 bg-white/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-white/70 backdrop-blur-sm">
                  {displayName(active)}
                </span>
              )}
            </div>

            {/* Big play overlay when paused */}
            {!isPlaying && (
              <button
                type="button"
                onClick={togglePlay}
                className="absolute inset-0 flex items-center justify-center bg-black/40 backdrop-blur-[1px] transition"
              >
                <span className="flex h-20 w-20 items-center justify-center rounded-full bg-accent/90 shadow-glow ring-4 ring-white/10 transition duration-200 hover:scale-105">
                  <svg width="34" height="34" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z" /></svg>
                </span>
              </button>
            )}

            {/* Skip intro — modern pill, sits just above the control bar.
                Eligible across the opening window, but auto-fades after a few
                seconds (re-shows on mouse move) so it isn't glued on screen. */}
            {showSkipIntroEligible && (
              <button
                onClick={(e) => { e.stopPropagation(); skipIntro(); }}
                className={`group/skip absolute bottom-20 right-5 z-30 flex items-center gap-2 rounded-lg border border-white/25 bg-black/65 px-4 py-2.5 text-sm font-bold text-white shadow-card backdrop-blur-md transition-all duration-300 hover:-translate-y-0.5 hover:border-accent hover:bg-accent ${
                  skipIntroVisible ? "opacity-100" : "opacity-0 pointer-events-none"
                }`}
              >
                {t.skipIntro}
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="transition group-hover/skip:translate-x-0.5"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" /></svg>
              </button>
            )}

            {/* Controls overlay */}
            <div
              className={`absolute inset-x-0 bottom-0 flex flex-col gap-1.5 bg-gradient-to-t from-black/90 via-black/45 to-transparent px-4 pb-3 pt-16 transition-opacity duration-300 ${
                controlsVisible || !isPlaying ? "opacity-100" : "opacity-0 pointer-events-none"
              }`}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Seek bar — track thickens and thumb appears on hover */}
              <div className="group/seek relative flex items-center py-2">
                <div className="pointer-events-none absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-white/20 transition-all duration-150 group-hover/seek:h-1.5">
                  <div className="absolute inset-y-0 left-0 bg-white/30" style={{ width: `${duration ? (buffered / duration) * 100 : 0}%` }} />
                  <div className="absolute inset-y-0 left-0 bg-accent shadow-glow" style={{ width: `${duration ? (currentTime / duration) * 100 : 0}%` }} />
                </div>
                <input
                  type="range"
                  min={0}
                  max={duration || 0}
                  step="0.1"
                  value={Math.min(currentTime, duration || 0)}
                  onChange={onSeek}
                  aria-label="Seek"
                  className="relative h-1.5 w-full cursor-pointer appearance-none bg-transparent [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent [&::-webkit-slider-thumb]:shadow-glow [&::-webkit-slider-thumb]:opacity-0 [&::-webkit-slider-thumb]:transition-opacity group-hover/seek:[&::-webkit-slider-thumb]:opacity-100"
                />
              </div>

              {/* Bottom row */}
              <div className="flex items-center gap-1.5 text-white">
                <button onClick={togglePlay} title={isPlaying ? "Pause (k)" : "Play (k)"} className="rounded-lg p-2 transition hover:bg-white/15">
                  {isPlaying ? (
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
                  ) : (
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                  )}
                </button>
                <button onClick={() => skip(-10)} title="-10s (←)" className="rounded-lg p-2 transition hover:bg-white/15">
                  <svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z" /></svg>
                </button>
                <button onClick={() => skip(10)} title="+10s (→)" className="rounded-lg p-2 transition hover:bg-white/15">
                  <svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor"><path d="M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z" /></svg>
                </button>
                <button
                  onClick={() => prev && navTo(prev)}
                  disabled={!prev}
                  title="Previous episode"
                  className="rounded-lg p-2 transition hover:bg-white/15 disabled:opacity-30 disabled:hover:bg-transparent"
                >
                  <svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" /></svg>
                </button>
                <button
                  onClick={() => next && navTo(next)}
                  disabled={!next}
                  title="Next episode"
                  className="rounded-lg p-2 transition hover:bg-white/15 disabled:opacity-30 disabled:hover:bg-transparent"
                >
                  <svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6h2v12h-2z" /></svg>
                </button>

                {/* Volume */}
                <div
                  className="relative flex items-center gap-1"
                  onMouseEnter={() => setShowVolumeBar(true)}
                  onMouseLeave={() => setShowVolumeBar(false)}
                >
                  <button onClick={toggleMute} title="Mute (m)" className="rounded-lg p-2 transition hover:bg-white/15">
                    {muted || volume === 0 ? (
                      <svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0021 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 003.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" /></svg>
                    ) : (
                      <svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0014 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" /></svg>
                    )}
                  </button>
                  <input
                    type="range" min={0} max={1} step={0.05}
                    value={muted ? 0 : volume}
                    onChange={onVolumeChange}
                    aria-label="Volume"
                    className={`h-1 cursor-pointer appearance-none rounded-full bg-white/25 transition-all duration-200 ${
                      showVolumeBar ? "w-20 opacity-100" : "w-0 opacity-0"
                    } [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white`}
                  />
                </div>

                <span className="ms-2 text-xs font-medium tabular-nums text-white/85">
                  {formatTime(currentTime)} <span className="text-white/40">/ {formatTime(duration)}</span>
                </span>

                <span className="flex-1" />

                {/* Playback rate */}
                <div className="relative">
                  <button
                    onClick={() => setShowRateMenu((v) => !v)}
                    className="rounded-lg px-2.5 py-1.5 text-xs font-bold transition hover:bg-white/15"
                  >
                    {playbackRate}×
                  </button>
                  {showRateMenu && (
                    <div className="absolute bottom-full end-0 mb-2 w-20 overflow-hidden rounded-lg border border-white/10 bg-bg/95 p-1 shadow-card backdrop-blur-md">
                      {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((r) => (
                        <button
                          key={r}
                          onClick={() => setRate(r)}
                          className={`block w-full rounded-md px-2 py-1 text-xs transition hover:bg-white/10 ${
                            playbackRate === r ? "font-bold text-accent" : "text-white/80"
                          }`}
                        >
                          {r}×
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <button onClick={toggleFs} title="Fullscreen (f)" className="rounded-lg p-2 transition hover:bg-white/15">
                  {isFullscreen ? (
                    <svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" /></svg>
                  ) : (
                    <svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" /></svg>
                  )}
                </button>
              </div>
            </div>
          </>
          )
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-text-muted">
            {serverError ? (
              <>
                <p className="text-sm text-red-400">Failed to load video servers.</p>
                <button
                  onClick={() => setRetryServersNonce((n) => n + 1)}
                  className="rounded-full bg-accent hover:bg-accent/80 text-white font-semibold text-xs px-4 py-2 transition shadow-glow"
                >
                  Retry Loading Servers
                </button>
              </>
            ) : !loadingServers && activeIdx !== null && !userActivated ? (
              <button
                onClick={() => activateServer(activeIdx)}
                className="flex items-center gap-2 rounded-full bg-accent px-6 py-3 text-base font-bold text-white shadow-glow hover:bg-accent/80 transition"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                {t.playNow ?? "▶ Play"}
              </button>
            ) : (
              <>
                {!allBroken && <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />}
                <p className="text-sm">
                  {loadingServers ? t.loadingServers
                    : allBroken ? t.noVideo
                    : status === "resolving" && active ? t.resolving(displayName(active))
                    : t.noVideo}
                </p>
                {allBroken && !loadingServers && (
                  <p className="text-xs text-red-400">CDN servers may be blocked by your ISP. Try a VPN.</p>
                )}
                {status === "resolving" && active && !allBroken && (
                  <button
                    onClick={advanceToNext}
                    className="mt-1 rounded-full border border-white/20 bg-white/5 px-4 py-1.5 text-xs font-semibold text-white hover:border-white/40 hover:bg-white/10"
                  >
                    {t.skipServer}
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Quick actions row */}
      <div dir="ltr" className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => prev && navTo(prev)}
            disabled={!prev}
            className="flex items-center gap-1.5 rounded-full border border-white/10 bg-surface px-3 py-1.5 text-xs font-semibold text-white hover:border-white/30 disabled:opacity-30 disabled:hover:border-white/10"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 16.59L10.83 12l4.58-4.59L14 6l-6 6 6 6 1.41-1.41z" /></svg>
            {t.episode} {prev?.number ?? ""}
          </button>
          <button
            onClick={() => next && navTo(next)}
            disabled={!next}
            className="flex items-center gap-1.5 rounded-full border border-white/10 bg-surface px-3 py-1.5 text-xs font-semibold text-white hover:border-white/30 disabled:opacity-30 disabled:hover:border-white/10"
          >
            {t.episode} {next?.number ?? ""}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z" /></svg>
          </button>
        </div>
        <div className="flex items-center gap-2">
          {/* Offline download */}
          <button
            onClick={startEpisodeDownload}
            disabled={dlStatus === "downloading" || dlStatus === "resolving" || dlStatus === "completed"}
            title={t.downloadEpisode}
            className="flex items-center gap-1.5 rounded-full border border-white/10 bg-surface px-3 py-1.5 text-xs font-semibold text-white transition hover:border-white/30 disabled:opacity-60"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55l3.3-3.3 1.4 1.4L12 17.4l-4.7-4.75 1.4-1.4 3.3 3.3V3h2zM5 19h14v2H5z" /></svg>
            {dlStatus === "completed" ? t.downloaded
              : dlStatus === "downloading" ? `${t.downloading} ${Math.round(dlProgress * 100)}%`
              : dlStatus === "resolving" ? t.downloadResolving
              : dlStatus === "failed" ? t.downloadRetry
              : t.download}
          </button>
          {resolvedAnimeHref && (
            <Link
              to={`/anime/${encodeURIComponent(resolvedAnimeHref)}`}
              className="flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-3 py-1.5 text-xs font-semibold text-accent hover:bg-accent/20"
            >
              {t.openAnimePage}
            </Link>
          )}
        </div>
      </div>

      {/* Server picker */}
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 font-display text-sm font-bold uppercase tracking-wider text-text-secondary">
            {t.servers} ({sortedServers.length})
            {(loadingServers || searchingMoreServers) && (
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
            )}
          </h2>
          <button
            onClick={refreshServers}
            disabled={loadingServers}
            title={t.refreshServers}
            className="flex items-center gap-1.5 rounded-full border border-white/10 bg-surface px-3 py-1.5 text-xs font-semibold text-text-secondary transition hover:border-white/30 hover:text-white disabled:opacity-40 disabled:hover:border-white/10"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className={loadingServers ? "animate-spin" : ""}>
              <path d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
            </svg>
            {t.refreshServers}
          </button>
        </div>
        {searchingMoreServers && sortedServers.length > 0 && (
          <p className="text-xs text-text-muted">{t.loadingMoreServers}</p>
        )}
        {sortedServers.length === 0 && !loadingServers ? (
          searchingMoreServers ? (
            <p className="text-text-muted">{t.loadingMoreServers}</p>
          ) : (
            <p className="text-text-muted">{t.noServers}</p>
          )
        ) : (
          <div className="flex flex-wrap gap-2">
            {sortedServers.map((s, i) => {
              const broken = brokenIds.has(s.id);
              return (
                <button
                  key={s.id}
                  onClick={() => {
                    if (broken) setBrokenIds((prev) => { const c = new Set(prev); c.delete(s.id); return c; });
                    activateServer(i);
                  }}
                  className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                    activeIdx === i
                      ? "border-accent bg-accent text-white shadow-glow"
                      : broken
                      ? "border-white/5 bg-bg text-text-muted line-through hover:text-white"
                      : "border-white/10 bg-surface text-text-secondary hover:border-white/30 hover:text-white"
                  }`}
                >
                  {displayName(s)}
                  {s.source && (
                    <span className="ms-1.5 opacity-60">· {s.source === "anime4up" ? "4up" : s.source === "anime3rb" ? "3rb" : "wit"}</span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </section>
      </div>

      {/* Episode list sidebar — all episodes, selectable. Highlights the one
          currently playing and scrolls/jumps the player on click. */}
      {siblings.length > 0 && (
        <aside className="w-full shrink-0 lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:w-72">
          <h2 className="mb-2 font-display text-sm font-bold uppercase tracking-wider text-text-secondary">
            {t.allEpisodes} ({siblings.length})
          </h2>
          <div className="grid grid-cols-5 gap-1.5 overflow-y-auto pe-1 lg:grid-cols-4 lg:max-h-[calc(100vh-9rem)]">
            {[...siblings]
              .sort((a, b) => (a.number ?? 0) - (b.number ?? 0))
              .map((ep) => {
                const isCurrent = currentEpNumber != null && ep.number === currentEpNumber;
                return (
                  <button
                    key={ep.href || ep.number}
                    onClick={() => !isCurrent && navTo(ep)}
                    title={ep.title}
                    className={`rounded-md border px-2 py-2 text-center text-xs font-semibold tabular-nums transition ${
                      isCurrent
                        ? "border-accent bg-accent text-white shadow-glow"
                        : "border-white/10 bg-surface text-text-secondary hover:border-white/30 hover:text-white"
                    }`}
                  >
                    {ep.number ?? "•"}
                  </button>
                );
              })}
          </div>
        </aside>
      )}
    </div>
  );
}
