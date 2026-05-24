// Mirrors the API exposed by electron/preload.ts via contextBridge.
// Lets the renderer's TS see `window.pantoufa` without importing Electron.

export type ScrapeJob = {
  url: string;
  injectBefore?: string;
  injectAfter: string;
  timeoutMs: number;
  isVideoJob?: boolean;
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
      onAuthCallback: (handler: (url: string) => void) => () => void;
      onUpdateAvailable: (handler: (info: UpdateInfo) => void) => () => void;
      onUpdateDownloaded: (handler: (info: UpdateInfo) => void) => () => void;
      onVideoCaptured: (handler: (info: { url: string }) => void) => () => void;
      setMuted: (muted: boolean) => Promise<boolean>;
      onIframeFailed: (handler: (info: { url: string }) => void) => () => void;
      onFullscreenChanged: (handler: (fullscreen: boolean) => void) => () => void;
      directExtract: (
        provider: string,
        iframeUrl: string,
      ) => Promise<{ url: string; type: "hls" | "mp4" } | null>;
    };
  }
}

export {};
