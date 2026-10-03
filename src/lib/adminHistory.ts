export interface WatchSummaryRow {
  user_id: string;
  episodes_started: number | string | null;
  episodes_completed: number | string | null;
}

export interface AdminHistoryRow {
  episode_href?: string | null;
  episode_title?: string | null;
  anime_title?: string | null;
  anime_href?: string | null;
  image?: string | null;
  image_fallback?: string | null;
  position_ms?: number | string | null;
  duration_ms?: number | string | null;
  completed?: boolean | null;
  updated_at?: string | null;
}

function firstImage(primary?: string | null, fallback?: string | null): string {
  return primary?.trim() || fallback?.trim() || "";
}

export interface AdminWatchEntry {
  episodeHref: string;
  episodeTitle: string;
  animeTitle: string;
  animeHref: string;
  image: string;
  positionMs: number;
  durationMs: number;
  completed: boolean;
  updatedAt: string;
  progress: number;
}

export function mergeWatchSummaries<T extends { userId: string }>(
  users: T[],
  summaries: WatchSummaryRow[],
): (T & { episodesStarted: number; episodesCompleted: number })[] {
  const byUser = new Map(summaries.map((row) => [row.user_id, row]));
  return users.map((user) => {
    const summary = byUser.get(user.userId);
    return {
      ...user,
      episodesStarted: Number(summary?.episodes_started) || 0,
      episodesCompleted: Number(summary?.episodes_completed) || 0,
    };
  });
}

export function mapAdminHistoryRow(row: AdminHistoryRow): AdminWatchEntry {
  const positionMs = Number(row.position_ms) || 0;
  const durationMs = Number(row.duration_ms) || 0;
  return {
    episodeHref: row.episode_href ?? "",
    episodeTitle: row.episode_title ?? "",
    animeTitle: row.anime_title ?? "",
    animeHref: row.anime_href ?? "",
    image: firstImage(row.image, row.image_fallback),
    positionMs,
    durationMs,
    completed: row.completed === true,
    updatedAt: row.updated_at ?? "",
    progress: durationMs > 0 ? Math.max(0, Math.min(positionMs / durationMs, 1)) : 0,
  };
}
