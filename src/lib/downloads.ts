// Offline episode downloads (desktop).
//
// A download is a single progressive .mp4 streamed to <userData>/downloads by
// the main process, plus a metadata entry in a localStorage index. The video
// URL is resolved the same way the player does (lib/api → resolveDownloadUrl),
// preferring vid3rb's direct 1080p .mp4. Live progress arrives over the
// pantoufa:download-progress IPC event; a tiny pub/sub re-renders the Downloads
// screen as progress ticks. Ported from the mobile app (lib/downloads.ts).

import { storage } from "./storage";
import { resolveDownloadUrl } from "./api";

export type DownloadStatus = "resolving" | "downloading" | "completed" | "failed";

export interface DownloadItem {
  id: string;
  animeTitle: string;
  episodeTitle: string;
  epNum: number | null;
  image: string;
  animeHref: string;
  episodeHref: string;
  url4up?: string;
  url3rb?: string;
  server?: DownloadMeta["server"];
  status: DownloadStatus;
  progress: number; // 0..1
  bytes: number;
  totalBytes: number;
  createdAt: number;
}

export interface DownloadMeta {
  animeTitle: string;
  episodeTitle: string;
  epNum: number | null;
  image: string;
  animeHref: string;
  episodeHref: string;
  url4up?: string;
  url3rb?: string;
  server?: { name: string; iframeUrl: string; provider: string; quality: string; videoUrl?: string };
}

const INDEX_KEY = "@downloads_index_v1";

let items: DownloadItem[] | null = null;
let loadPromise: Promise<DownloadItem[]> | null = null;
const pending = new Set<string>();
const operationVersions = new Map<string, number>();
const listeners = new Set<() => void>();
let lastEmit = 0;
let progressWired = false;

function emit(force = false) {
  const now = Date.now();
  if (!force && now - lastEmit < 400) return;
  lastEmit = now;
  for (const fn of listeners) { try { fn(); } catch {} }
}

export function subscribeDownloads(fn: () => void): () => void {
  listeners.add(fn);
  wireProgress();
  return () => { listeners.delete(fn); };
}

// Subscribe ONCE to the main-process progress stream and fan it out to the
// in-memory items + listeners.
function wireProgress() {
  if (progressWired) return;
  progressWired = true;
  window.pantoufa.onDownloadProgress?.(({ id, bytes, total }) => {
    if (!items) return;
    const i = items.findIndex((x) => x.id === id);
    if (i === -1) return;
    items[i] = {
      ...items[i],
      bytes,
      totalBytes: total > 0 ? total : items[i].totalBytes,
      progress: total > 0 ? Math.min(1, bytes / total) : items[i].progress,
    };
    emit();
  });
}

export function idFor(episodeHref: string): string {
  let h = 0;
  const s = episodeHref || String(Math.random());
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return "dl_" + (h >>> 0).toString(36);
}

async function persist() {
  try { await storage.setItem(INDEX_KEY, JSON.stringify(items ?? [])); } catch {}
}

async function load(): Promise<DownloadItem[]> {
  if (items) return items;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const raw = await storage.getItem(INDEX_KEY);
      const parsed: DownloadItem[] = raw ? JSON.parse(raw) : [];
      let changed = false;
      items = await Promise.all(parsed.map(async (it) => {
        const file = await window.pantoufa.downloadQuery?.(it.id).catch(() => null);
        if (file?.valid) {
          if (it.status !== "completed" || it.totalBytes !== file.size) changed = true;
          return { ...it, status: "completed" as DownloadStatus, progress: 1, bytes: file.size, totalBytes: file.size };
        }
        if (it.status !== "failed") changed = true;
        return { ...it, status: "failed" as DownloadStatus, progress: 0 };
      }));
      if (changed) await persist();
    } catch {
      items = [];
    }
    return items!;
  })().finally(() => { loadPromise = null; });
  return loadPromise;
}

export async function getDownloads(): Promise<DownloadItem[]> {
  const list = await load();
  return [...list].sort((a, b) => b.createdAt - a.createdAt);
}

export async function getDownloadByEpisode(episodeHref: string): Promise<DownloadItem | undefined> {
  const list = await load();
  return list.find((it) => it.id === idFor(episodeHref));
}

/** Playback URL for a completed download (served by the pantoufa-file scheme). */
export function downloadFileUrl(id: string): string {
  return window.pantoufa.downloadFileUrl?.(id) ?? "";
}

function upsert(item: DownloadItem) {
  if (!items) items = [];
  const i = items.findIndex((x) => x.id === item.id);
  if (i === -1) items.push(item);
  else items[i] = item;
}

function patch(id: string, p: Partial<DownloadItem>) {
  if (!items) return;
  const i = items.findIndex((x) => x.id === id);
  if (i !== -1) items[i] = { ...items[i], ...p };
}

/**
 * Start (or restart) a download. Resolves a direct .mp4 URL, then streams it to
 * disk via the main process with live progress. Idempotent: an already-completed
 * episode just returns its id.
 */
export async function startDownload(meta: DownloadMeta): Promise<string> {
  await load();
  wireProgress();
  const id = idFor(meta.episodeHref);
  if (pending.has(id)) return id;

  const existing = items!.find((x) => x.id === id);
  if (existing && existing.status === "completed") return id;
  if (existing && existing.status === "downloading") return id;
  pending.add(id);
  const operation = (operationVersions.get(id) ?? 0) + 1;
  operationVersions.set(id, operation);
  const isCurrent = () => operationVersions.get(id) === operation;

  const item: DownloadItem = {
    id,
    animeTitle: meta.animeTitle,
    episodeTitle: meta.episodeTitle,
    epNum: meta.epNum,
    image: meta.image,
    animeHref: meta.animeHref,
    episodeHref: meta.episodeHref,
    url4up: meta.url4up,
    url3rb: meta.url3rb,
    server: meta.server,
    status: "resolving",
    progress: 0,
    bytes: 0,
    totalBytes: 0,
    createdAt: existing?.createdAt ?? Date.now(),
  };
  upsert(item);
  await persist();
  emit(true);

  try {
    const resolved = await resolveDownloadUrl({
      episodeHref: meta.episodeHref,
      url4up: meta.url4up,
      url3rb: meta.url3rb,
      epNum: meta.epNum,
      animeTitle: meta.animeTitle,
      server: meta.server,
    });
    if (!resolved) {
      patch(id, { status: "failed" });
      await persist();
      emit(true);
      return id;
    }
    if (!isCurrent()) return id;

    patch(id, { status: "downloading", server: meta.server });
    await persist();
    emit(true);

    let res = await window.pantoufa.downloadStart({ id, url: resolved.url, provider: resolved.provider });
    // A picked CDN token can expire while the dialog is open or while a retry
    // waits in the list. Refresh that exact server once before declaring the
    // download failed; the main process removes the partial file between runs.
    if (!res?.ok && meta.server && isCurrent()) {
      const refreshed = await resolveDownloadUrl({
        episodeHref: meta.episodeHref,
        url4up: meta.url4up,
        url3rb: meta.url3rb,
        epNum: meta.epNum,
        animeTitle: meta.animeTitle,
        server: { ...meta.server, videoUrl: undefined },
      });
      if (refreshed) {
        res = await window.pantoufa.downloadStart({ id, url: refreshed.url, provider: refreshed.provider });
      }
    }
    if (!isCurrent()) return id;
    if (!res?.ok) {
      patch(id, { status: "failed" });
    } else {
      patch(id, { status: "completed", progress: 1, totalBytes: res.total ?? 0 });
    }
    await persist();
    emit(true);
  } catch {
    if (isCurrent()) {
      patch(id, { status: "failed" });
      await persist();
      emit(true);
    }
  } finally {
    if (isCurrent()) pending.delete(id);
  }
  return id;
}

export async function retryDownload(id: string): Promise<void> {
  const list = await load();
  const it = list.find((x) => x.id === id);
  if (!it) return;
  await startDownload({
    animeTitle: it.animeTitle,
    episodeTitle: it.episodeTitle,
    epNum: it.epNum,
    image: it.image,
    animeHref: it.animeHref,
    episodeHref: it.episodeHref,
    url4up: it.url4up,
    url3rb: it.url3rb,
    server: it.server,
  });
}

export async function deleteDownload(id: string): Promise<void> {
  await load();
  operationVersions.set(id, (operationVersions.get(id) ?? 0) + 1);
  pending.delete(id);
  try { await window.pantoufa.downloadDelete(id); } catch {}
  items = items!.filter((x) => x.id !== id);
  await persist();
  emit(true);
}

/** Human-readable total size of completed downloads (for the screen header). */
export function formatBytes(n: number): string {
  if (!n || n <= 0) return "0 MB";
  const mb = n / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(0)} MB`;
}
