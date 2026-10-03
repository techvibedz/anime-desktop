export function shouldRunEpisodeNotifier(inserted: unknown[] | null): boolean {
  return (inserted?.length ?? 0) > 0;
}
