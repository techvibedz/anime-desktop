// Mirrors the API exposed by electron/preload.ts via contextBridge.
// Lets the renderer's TS see `window.pantoufa` without importing Electron.

export type ScrapeJob = {
  url: string;
  injectBefore?: string;
  injectAfter: string;
  timeoutMs: number;
  isVideoJob?: boolean;
  priority?: boolean;
};

export type UpdateInfo = {
  version: string;
  releaseNotes?: string;
};

declare global {
  interface Window {
    pantoufa: {
      scrape: (job: ScrapeJob) => Promise<any>;
      openExternal: (url: string) => Promise<boolean>;
      setVideoReferer: (embedUrl: string | null) => Promise<boolean>;
      installUpdate: () => Promise<boolean>;
      notify: (opts: { title: string; body: string; data?: unknown }) => Promise<boolean>;
      onNotificationClick: (handler: (data: unknown) => void) => () => void;
      checkForUpdates: () => Promise<{ ok: boolean; error?: string }>;
      onAuthCallback: (handler: (url: string) => void) => () => void;
      onUpdateAvailable: (handler: (info: UpdateInfo) => void) => () => void;
      onUpdateDownloaded: (handler: (info: UpdateInfo) => void) => () => void;
      onUpdateError: (handler: (info: { message: string }) => void) => () => void;
      onVideoCaptured: (handler: (info: { url: string }) => void) => () => void;
      setMuted: (muted: boolean) => Promise<boolean>;
      onNetworkChanged: (handler: () => void) => () => void;
      onIframeFailed: (handler: (info: { url: string }) => void) => () => void;
      onFullscreenChanged: (handler: (fullscreen: boolean) => void) => () => void;
      setActiveIframe: (url: string | null) => Promise<void>;
      directExtract: (
        provider: string,
        iframeUrl: string,
        opts?: { background?: boolean },
      ) => Promise<{ url: string; type: "hls" | "mp4"; subtitles?: { url: string; label?: string; lang?: string }[]; denied?: boolean } | null>;
      probeMedia: (url: string, iframeUrl?: string) => Promise<{ ok: boolean; status: number }>;
      cancelBackgroundScrapes: () => Promise<{ cancelled: number }>;
      fetchText: (url: string) => Promise<string | null>;
      fetchHtml: (
        url: string,
        referer?: string,
        opts?: { attempts?: number; timeoutMs?: number },
      ) => Promise<string | null>;
      fetchJson: (opts: { url: string; method?: string; body?: string; headers?: Record<string, string> }) => Promise<string | null>;
      resolveWitServers: (url: string) => Promise<{
        servers: { id: string; name: string; iframeUrl: string; provider?: string }[];
        episodeTitle: string;
        animeTitle: string;
      } | null>;
      downloadStart: (opts: { id: string; url: string; provider: string }) => Promise<{ ok: boolean; total?: number }>;
      downloadDelete: (id: string) => Promise<boolean>;
      downloadQuery: (id: string) => Promise<{ exists: boolean; valid: boolean; size: number }>;
      onDownloadProgress: (handler: (info: { id: string; bytes: number; total: number }) => void) => () => void;
      downloadFileUrl: (id: string) => string;
    };
  }
}

export {};
