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
});
