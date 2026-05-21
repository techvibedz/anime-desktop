import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useParams, useSearchParams, Link, useNavigate } from "react-router-dom";
import Hls from "hls.js";
import {
  fetchVideoServers, resolveVideo, fetchEpisodes,
  type VideoServer, type Episode,
} from "../lib/api";
import { saveProgress, getProgress } from "../lib/history";
import { toAnimeUrl } from "../lib/favorites";
import { t } from "../lib/i18n";

type ServerWithSource = VideoServer & { source?: string };

const PROVIDER_RANK: Record<string, number> = {
  dailymotion: 0, mp4upload: 1, streamwish: 2, videa: 3, voe: 4,
  share4max: 5, doodstream: 6, uqload: 7, okru: 8, generic: 10, vk: 11,
};
function rank(p: string) { return PROVIDER_RANK[p] ?? 50; }

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

export function WatchPage() {
  const { episode } = useParams<{ episode: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const episodeUrl = episode ? decodeURIComponent(episode) : "";
  const up4Param = params.get("up4");
  const imgParam = params.get("img");
  const animeParam = params.get("anime");

  const [servers, setServers] = useState<ServerWithSource[]>([]);
  const [meta, setMeta] = useState<{ episodeTitle: string; animeTitle: string }>({ episodeTitle: "", animeTitle: "" });
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const [resolved, setResolved] = useState<{ url: string; type: "hls" | "mp4"; embed: string } | null>(null);
  const [status, setStatus] = useState<"idle" | "resolving" | "playing" | "failed">("idle");
  const [loadingServers, setLoadingServers] = useState(true);
  const [serverError, setServerError] = useState(false);
  const [retryServersNonce, setRetryServersNonce] = useState(0);
  const [brokenIds, setBrokenIds] = useState<Set<string>>(new Set());
  const [retryNonce, setRetryNonce] = useState(0);

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

  const sortedServers = useMemo(
    () => [...servers].sort((a, b) => rank(a.provider) - rank(b.provider)),
    [servers],
  );

  // Fetch server list once.
  useEffect(() => {
    if (!episodeUrl) return;
    let cancelled = false;
    setLoadingServers(true);
    setServerError(false);
    fetchVideoServers(episodeUrl, up4Param || undefined)
      .then((r) => {
        if (cancelled) return;
        setServers(r.data.servers);
        setMeta({ episodeTitle: r.data.episodeTitle, animeTitle: r.data.animeTitle });
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[player] failed to fetch video servers", err);
        setServerError(true);
      })
      .finally(() => { if (!cancelled) setLoadingServers(false); });
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
    fetchEpisodes(resolvedAnimeHref)
      .then((r) => {
        if (cancelled) return;
        setSiblings(r.data.episodes);
        setUp4Siblings(r.data.episodes4up || []);
        if (r.data.title) setAnimeTitleFromDetail(r.data.title);
        if (r.data.poster) setPosterFromDetail(r.data.poster);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [resolvedAnimeHref]);

  // Auto-pick the highest-ranked NON-broken server.
  useEffect(() => {
    if (sortedServers.length === 0) return;
    const firstGood = sortedServers.findIndex((s) => !brokenIds.has(s.id));
    if (activeIdx === null || (activeIdx !== null && brokenIds.has(sortedServers[activeIdx]?.id))) {
      if (firstGood >= 0) setActiveIdx(firstGood);
    }
  }, [sortedServers, brokenIds, activeIdx]);

  const advanceToNext = useCallback(() => {
    if (activeIdx === null) return;
    const failedId = sortedServers[activeIdx]?.id;
    if (failedId) setBrokenIds((prev) => new Set(prev).add(failedId));
    setStatus("failed");
  }, [activeIdx, sortedServers]);

  // Resolve the active server with auto-retry once.
  useEffect(() => {
    if (activeIdx === null || !sortedServers[activeIdx]) return;
    const srv = sortedServers[activeIdx];
    let cancelled = false;
    setResolved(null);
    setStatus("resolving");

    async function attempt(attemptNum: number): Promise<void> {
      try {
        const r = await resolveVideo(srv.iframeUrl, srv.provider);
        if (cancelled) return;
        if (r.success && r.data?.videoUrl) {
          console.info(`[player] ${srv.provider}: ${r.data.type} → ${r.data.videoUrl}`);
          setResolved({
            url: r.data.videoUrl,
            type: r.data.type as "hls" | "mp4",
            embed: srv.iframeUrl,
          });
          setStatus("playing");
          return;
        }
        if (attemptNum < 2) {
          console.warn(`[player] ${srv.provider}: extraction empty, retrying`);
          await new Promise((r) => setTimeout(r, 800));
          if (!cancelled) return attempt(attemptNum + 1);
        } else {
          advanceToNext();
        }
      } catch (e) {
        if (cancelled) return;
        if (attemptNum < 2) {
          console.warn(`[player] ${srv.provider}: resolve threw, retrying`, e);
          await new Promise((r) => setTimeout(r, 800));
          if (!cancelled) return attempt(attemptNum + 1);
        } else {
          advanceToNext();
        }
      }
    }
    void attempt(1);

    return () => { cancelled = true; };
  }, [activeIdx, sortedServers, advanceToNext, retryNonce]);

  // Wire HLS / direct mp4 + stall watchdog
  useEffect(() => {
    if (!resolved || !videoRef.current) return;
    const v = videoRef.current;
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    const proxied = proxify(resolved.url, resolved.embed);
    
    let played = false;
    let advanced = false;
    let lastTime = 0;
    let lastTimeUpdate = Date.now();

    const checkStall = () => {
      if (advanced) return;
      const now = Date.now();
      const isInitialLoading = !played && !v.paused;
      const isBufferingMidStream = played && !v.paused && !v.ended && v.currentTime === lastTime;

      if (isInitialLoading || isBufferingMidStream) {
        const elapsed = now - lastTimeUpdate;
        if (elapsed > STALL_THRESHOLD_MS) {
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

    v.addEventListener("playing", onPlaying);
    v.addEventListener("timeupdate", onTimeUpdate);
    v.addEventListener("progress", onProgress);
    
    const interval = setInterval(checkStall, 1000);

    if (resolved.type === "hls" && Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        // Default to best quality available, hls.js will adapt down if bw is low.
        startLevel: -1,
        // Keep 90s of back-buffer for instant seeks; trim aggressively to bound RAM.
        backBufferLength: 90,
        maxBufferLength: 60,
        maxMaxBufferLength: 300,
        // Generous timeouts/retries — proxy + first-byte CDN latency can be slow.
        manifestLoadingTimeOut: 20000,
        manifestLoadingMaxRetry: 2,
        levelLoadingTimeOut: 20000,
        levelLoadingMaxRetry: 2,
        fragLoadingTimeOut: 30000,
        fragLoadingMaxRetry: 3,
        // Proxy handles cookies/Referer — renderer XHR doesn't need creds.
        xhrSetup: (xhr) => { xhr.withCredentials = false; },
      });
      let recoveryUsed = false;
      hls.loadSource(proxied);
      hls.attachMedia(v);
      hls.on(Hls.Events.FRAG_LOADED, () => { if (!played) lastTimeUpdate = Date.now(); });
      hls.on(Hls.Events.LEVEL_LOADED, () => { if (!played) lastTimeUpdate = Date.now(); });
      hls.on(Hls.Events.MANIFEST_PARSED, () => { if (!played) lastTimeUpdate = Date.now(); });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        if (!recoveryUsed) {
          recoveryUsed = true;
          console.warn("[player] HLS fatal, attempting recovery", data);
          try {
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
            else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
            else { advanced = true; advanceToNext(); }
          } catch { advanced = true; advanceToNext(); }
          return;
        }
        advanced = true; advanceToNext();
      });
      hlsRef.current = hls;
    } else {
      v.src = proxied;
    }

    return () => {
      clearInterval(interval);
      v.removeEventListener("playing", onPlaying);
      v.removeEventListener("timeupdate", onTimeUpdate);
      v.removeEventListener("progress", onProgress);
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    };
  }, [resolved, advanceToNext]);

  // Resume position
  useEffect(() => {
    if (!episodeUrl || !videoRef.current || !resolved) return;
    getProgress(episodeUrl).then((p) => {
      if (p && p.positionMs > 5000 && videoRef.current) {
        videoRef.current.currentTime = p.positionMs / 1000;
      }
    });
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

  // Save progress every 10s (and at unmount).
  useEffect(() => {
    if (!videoRef.current || !episodeUrl) return;
    const v = videoRef.current;
    let last = 0;
    const onTime = () => {
      const now = Date.now();
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
      }).catch(() => {});
    };
    v.addEventListener("timeupdate", onTime);
    return () => v.removeEventListener("timeupdate", onTime);
  }, [episodeUrl, meta, up4Param, resolved, animeParam, imgParam, posterFromDetail, animeTitleFromDetail]);

  // Auto-hide controls
  const scheduleHide = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setControlsVisible(false), 3500);
  }, []);
  const showControls = useCallback(() => {
    setControlsVisible(true);
    scheduleHide();
  }, [scheduleHide]);
  useEffect(() => { scheduleHide(); return () => { if (hideTimer.current) clearTimeout(hideTimer.current); }; }, [scheduleHide]);

  // Fullscreen tracking
  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
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
    const matching4 = up4Siblings.find((u) => u.number === ep.number)?.href ?? null;
    const p = new URLSearchParams();
    if (matching4) p.set("up4", matching4);
    if (ep.screenshot) p.set("img", ep.screenshot);
    if (animeParam) p.set("anime", animeParam);
    const qs = p.toString();
    navigate(`/watch/${encodeURIComponent(ep.href)}${qs ? `?${qs}` : ""}`);
  }, [up4Siblings, animeParam, navigate]);

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
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, skip, toggleMute, toggleFs, showControls]);

  const active = activeIdx !== null ? sortedServers[activeIdx] : null;
  const allBroken = sortedServers.length > 0 && sortedServers.every((s) => brokenIds.has(s.id));
  const animeTitle = meta.animeTitle || animeTitleFromDetail;

  return (
    <div className="mx-auto max-w-4xl space-y-4">
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
          of the page-wide RTL direction. */}
      <div
        ref={playerRef}
        dir="ltr"
        className="group relative aspect-video w-full overflow-hidden rounded-xl border border-white/10 bg-black shadow-card"
        onMouseMove={showControls}
        onMouseLeave={() => { if (isPlaying) setControlsVisible(false); }}
      >
        {status === "playing" && resolved ? (
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
                // MediaError.code: 1=ABORTED, 2=NETWORK, 3=DECODE, 4=SRC_UNSUPPORTED.
                // ABORTED is normal (we triggered it). NETWORK is often transient
                // and hls.js handles its own recovery. Only DECODE / UNSUPPORTED
                // should hard-advance.
                const err = (e.target as HTMLVideoElement).error;
                const code = err?.code;
                console.warn(`[player] <video> error code=${code} message=${err?.message || ""}`);
                if (code === 3 || code === 4) advanceToNext();
              }}
            />
            {/* Big play overlay when paused */}
            {!isPlaying && (
              <button
                type="button"
                onClick={togglePlay}
                className="absolute inset-0 flex items-center justify-center bg-black/30"
              >
                <span className="flex h-16 w-16 items-center justify-center rounded-full bg-accent shadow-glow">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z" /></svg>
                </span>
              </button>
            )}
            {/* Controls overlay */}
            <div
              className={`absolute inset-x-0 bottom-0 flex flex-col gap-1 bg-gradient-to-t from-black/95 via-black/55 to-transparent px-4 pb-3 pt-12 transition-opacity duration-200 ${
                controlsVisible || !isPlaying ? "opacity-100" : "opacity-0 pointer-events-none"
              }`}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Seek bar */}
              <div className="relative">
                <div className="pointer-events-none absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-white/15">
                  <div className="h-full bg-white/30" style={{ width: `${duration ? (buffered / duration) * 100 : 0}%` }} />
                  <div className="absolute inset-y-0 left-0 bg-accent" style={{ width: `${duration ? (currentTime / duration) * 100 : 0}%` }} />
                </div>
                <input
                  type="range"
                  min={0}
                  max={duration || 0}
                  step="0.1"
                  value={Math.min(currentTime, duration || 0)}
                  onChange={onSeek}
                  className="relative h-4 w-full cursor-pointer appearance-none bg-transparent [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent [&::-webkit-slider-thumb]:shadow-glow"
                />
              </div>

              {/* Bottom row */}
              <div className="flex items-center gap-3 text-white">
                <button onClick={togglePlay} title={isPlaying ? "Pause (k)" : "Play (k)"} className="rounded-full p-1.5 hover:bg-white/10">
                  {isPlaying ? (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
                  ) : (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                  )}
                </button>
                <button onClick={() => skip(-10)} title="-10s (←)" className="rounded-full p-1.5 hover:bg-white/10">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z" /></svg>
                </button>
                <button onClick={() => skip(10)} title="+10s (→)" className="rounded-full p-1.5 hover:bg-white/10">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z" /></svg>
                </button>
                <button
                  onClick={() => prev && navTo(prev)}
                  disabled={!prev}
                  title="Previous episode"
                  className="rounded-full p-1.5 hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" /></svg>
                </button>
                <button
                  onClick={() => next && navTo(next)}
                  disabled={!next}
                  title="Next episode"
                  className="rounded-full p-1.5 hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6h2v12h-2z" /></svg>
                </button>

                {/* Volume */}
                <div
                  className="relative flex items-center gap-2"
                  onMouseEnter={() => setShowVolumeBar(true)}
                  onMouseLeave={() => setShowVolumeBar(false)}
                >
                  <button onClick={toggleMute} title="Mute (m)" className="rounded-full p-1.5 hover:bg-white/10">
                    {muted || volume === 0 ? (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0021 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 003.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" /></svg>
                    ) : (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0014 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" /></svg>
                    )}
                  </button>
                  <input
                    type="range" min={0} max={1} step={0.05}
                    value={muted ? 0 : volume}
                    onChange={onVolumeChange}
                    className={`h-1 cursor-pointer appearance-none rounded-full bg-white/25 transition-all ${
                      showVolumeBar ? "w-20 opacity-100" : "w-0 opacity-0"
                    } [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white`}
                  />
                </div>

                <span className="ms-1 text-xs tabular-nums text-white/80">
                  {formatTime(currentTime)} / {formatTime(duration)}
                </span>

                <span className="flex-1" />

                {/* Playback rate */}
                <div className="relative">
                  <button
                    onClick={() => setShowRateMenu((v) => !v)}
                    className="rounded-md px-2 py-1 text-xs font-semibold hover:bg-white/10"
                  >
                    {playbackRate}×
                  </button>
                  {showRateMenu && (
                    <div className="absolute bottom-full end-0 mb-2 w-20 rounded-md border border-white/10 bg-bg/95 p-1 shadow-card backdrop-blur-md">
                      {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((r) => (
                        <button
                          key={r}
                          onClick={() => setRate(r)}
                          className={`block w-full rounded px-2 py-1 text-xs hover:bg-white/10 ${
                            playbackRate === r ? "text-accent" : ""
                          }`}
                        >
                          {r}×
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <button onClick={toggleFs} title="Fullscreen (f)" className="rounded-full p-1.5 hover:bg-white/10">
                  {isFullscreen ? (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" /></svg>
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" /></svg>
                  )}
                </button>
              </div>
            </div>
          </>
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
            ) : (
              <>
                {!allBroken && <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />}
                <p className="text-sm">
                  {loadingServers ? t.loadingServers
                    : allBroken ? t.noVideo
                    : status === "resolving" && active ? t.resolving(displayName(active))
                    : t.noVideo}
                </p>
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
        {resolvedAnimeHref && (
          <Link
            to={`/anime/${encodeURIComponent(resolvedAnimeHref)}`}
            className="flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-3 py-1.5 text-xs font-semibold text-accent hover:bg-accent/20"
          >
            {t.openAnimePage}
          </Link>
        )}
      </div>

      {/* Server picker */}
      <section className="space-y-2">
        <h2 className="font-display text-sm font-bold uppercase tracking-wider text-text-secondary">
          {t.servers} ({sortedServers.length})
        </h2>
        {sortedServers.length === 0 && !loadingServers ? (
          <p className="text-text-muted">{t.noServers}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {sortedServers.map((s, i) => {
              const broken = brokenIds.has(s.id);
              return (
                <button
                  key={s.id}
                  onClick={() => {
                    if (broken) setBrokenIds((prev) => { const c = new Set(prev); c.delete(s.id); return c; });
                    setActiveIdx(i);
                    setRetryNonce((n) => n + 1);
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
                    <span className="ms-1.5 opacity-60">· {s.source === "anime4up" ? "4up" : "wit"}</span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
