// Extract episode number from a recently-updated card title or href.
// Examples it has to handle:
//   "ون بيس - الحلقة 1095"
//   "Spy x Family الحلقة 12"
//   "/episode/spy-x-family-الحلقة-12/"
// Returns null if no number is found.
export function extractEpisodeNumber(...sources: (string | null | undefined)[]): number | null {
  for (const src of sources) {
    if (!src) continue;
    let s = src;
    try { s = decodeURIComponent(src); } catch {}
    const m =
      s.match(/الحلقة[\s\-_]*(\d+)/i) ||
      s.match(/episode[\s\-_]*(\d+)/i) ||
      s.match(/\bep[\s\-_]*(\d+)/i) ||
      s.match(/-(\d+)(?:[-/]|$)/);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}
