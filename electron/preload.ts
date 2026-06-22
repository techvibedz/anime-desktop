// Preload script — bridges the renderer (React) and the main process.
// Exposes a small typed API on `window.pantoufa`.

import { contextBridge, ipcRenderer } from "electron";

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

contextBridge.exposeInMainWorld("pantoufa", {
  scrape: (job: ScrapeJob) => ipcRenderer.invoke("pantoufa:scrape", job),
  openExternal: (url: string) => ipcRenderer.invoke("pantoufa:open-external", url),
  setVideoReferer: (embedUrl: string | null) =>
    ipcRenderer.invoke("pantoufa:set-video-referer", embedUrl),
  installUpdate: () => ipcRenderer.invoke("pantoufa:install-update"),
  onAuthCallback: (handler: (url: string) => void) => {
    const listener = (_evt: unknown, url: string) => handler(url);
    ipcRenderer.on("pantoufa:auth-callback", listener);
    return () => ipcRenderer.removeListener("pantoufa:auth-callback", listener);
  },
  onUpdateAvailable: (handler: (info: UpdateInfo) => void) => {
    const listener = (_evt: unknown, info: UpdateInfo) => handler(info);
    ipcRenderer.on("pantoufa:update-available", listener);
    return () => ipcRenderer.removeListener("pantoufa:update-available", listener);
  },
  onUpdateDownloaded: (handler: (info: UpdateInfo) => void) => {
    const listener = (_evt: unknown, info: UpdateInfo) => handler(info);
    ipcRenderer.on("pantoufa:update-downloaded", listener);
    return () => ipcRenderer.removeListener("pantoufa:update-downloaded", listener);
  },
  onUpdateError: (handler: (info: { message: string }) => void) => {
    const listener = (_evt: unknown, info: { message: string }) => handler(info);
    ipcRenderer.on("pantoufa:update-error", listener);
    return () => ipcRenderer.removeListener("pantoufa:update-error", listener);
  },
  onVideoCaptured: (handler: (info: { url: string }) => void) => {
    const listener = (_evt: unknown, info: { url: string }) => handler(info);
    ipcRenderer.on("pantoufa:video-captured", listener);
    return () => ipcRenderer.removeListener("pantoufa:video-captured", listener);
  },
  setMuted: (muted: boolean) => ipcRenderer.invoke("pantoufa:set-muted", muted),
  onIframeFailed: (handler: (info: { url: string }) => void) => {
    const listener = (_evt: unknown, info: { url: string }) => handler(info);
    ipcRenderer.on("pantoufa:iframe-failed", listener);
    return () => ipcRenderer.removeListener("pantoufa:iframe-failed", listener);
  },
  onFullscreenChanged: (handler: (fullscreen: boolean) => void) => {
    const listener = (_evt: unknown, fullscreen: boolean) => handler(fullscreen);
    ipcRenderer.on("pantoufa:fullscreen-changed", listener);
    return () => ipcRenderer.removeListener("pantoufa:fullscreen-changed", listener);
  },
  setActiveIframe: (url: string | null) =>
    ipcRenderer.invoke("pantoufa:set-active-iframe", url),
  directExtract: (provider: string, iframeUrl: string) =>
    ipcRenderer.invoke("pantoufa:direct-extract", { provider, iframeUrl }) as Promise<
      { url: string; type: "hls" | "mp4" } | null
    >,
  // Privileged HTML GET from the main process (no CORS). Used to read
  // anime4up episode pages directly instead of rendering them headless.
  fetchHtml: (url: string, referer?: string, opts?: { attempts?: number; timeoutMs?: number }) =>
    ipcRenderer.invoke("pantoufa:fetch-html", { url, referer, ...opts }) as Promise<string | null>,
  // Privileged JSON/text fetch (AniList, translate) from the main process.
  fetchJson: (opts: { url: string; method?: string; body?: string; headers?: Record<string, string> }) =>
    ipcRenderer.invoke("pantoufa:fetch-json", opts) as Promise<string | null>,

  // ── Offline downloads ──
  downloadStart: (opts: { id: string; url: string; provider: string }) =>
    ipcRenderer.invoke("pantoufa:download-start", opts) as Promise<{ ok: boolean; total?: number }>,
  downloadDelete: (id: string) =>
    ipcRenderer.invoke("pantoufa:download-delete", id) as Promise<boolean>,
  onDownloadProgress: (handler: (info: { id: string; bytes: number; total: number }) => void) => {
    const listener = (_evt: unknown, info: { id: string; bytes: number; total: number }) => handler(info);
    ipcRenderer.on("pantoufa:download-progress", listener);
    return () => ipcRenderer.removeListener("pantoufa:download-progress", listener);
  },
  // Playback URL for a completed download (served by the pantoufa-file scheme).
  downloadFileUrl: (id: string) => `pantoufa-file://x/${encodeURIComponent(id)}`,
});
