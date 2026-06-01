// Preload script — bridges the renderer (React) and the main process.
// Exposes a small typed API on `window.pantoufa`.

import { contextBridge, ipcRenderer } from "electron";

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
  fetchHtml: (url: string, referer?: string) =>
    ipcRenderer.invoke("pantoufa:fetch-html", { url, referer }) as Promise<string | null>,
});
