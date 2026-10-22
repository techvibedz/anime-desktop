// Admin-only manga activity reads (RPCs in supabase/manga-activity.sql; the
// server rejects anyone but the admin email).

import { supabase } from "./supabase";

export interface AdminMangaSummary {
  userId: string;
  mangaCount: number;
  readingCount: number;
  lastReadAt: string | null;
}

export interface AdminMangaEntry {
  key: string;
  source: string;
  title: string;
  cover: string | null;
  chapterNumber: string | null;
  page: number;
  total: number;
  inLibrary: boolean;
  updatedAt: string;
}

export async function fetchAdminMangaSummary(): Promise<AdminMangaSummary[]> {
  const { data, error } = await supabase.rpc("admin_manga_summary");
  if (error || !Array.isArray(data)) return [];
  return data.map((r: any) => ({
    userId: r.user_id,
    mangaCount: Number(r.manga_count) || 0,
    readingCount: Number(r.reading_count) || 0,
    lastReadAt: r.last_read_at ?? null,
  }));
}

export async function fetchAdminUserManga(userId: string): Promise<AdminMangaEntry[]> {
  const { data, error } = await supabase.rpc("admin_user_manga", { p_user_id: userId });
  if (error || !Array.isArray(data)) return [];
  return data.map((r: any) => ({
    key: r.manga_key,
    source: r.source,
    title: r.title || "",
    cover: r.cover ?? null,
    chapterNumber: r.chapter_number ?? null,
    page: Number(r.page) || 0,
    total: Number(r.total) || 0,
    inLibrary: !!r.in_library,
    updatedAt: r.updated_at,
  }));
}
