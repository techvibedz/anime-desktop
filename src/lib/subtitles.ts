// WebVTT parsing for sidecar subtitle tracks. Anime4up's CDN ships the Arabic
// subtitle as a separate .vtt file (its HLS master has no subtitle rendition),
// so the player fetches it and renders the active cue itself — a native
// <track> would show Chromium's black caption box, which the design forbids.

export type SubtitleCue = { start: number; end: number; text: string };

// "00:11.080" / "1:02:03,500" → seconds. Returns null on anything else.
export function parseTimestamp(raw: string): number | null {
  const m = String(raw || "").trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/);
  if (!m) return null;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const min = parseInt(m[2], 10);
  const sec = parseInt(m[3], 10);
  const ms = m[4] ? parseInt(m[4].padEnd(3, "0"), 10) : 0;
  return h * 3600 + min * 60 + sec + ms / 1000;
}

function cleanCueText(raw: string): string {
  return String(raw || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#0?39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

export function parseVtt(raw: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const blocks = String(raw || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length === 0) continue;
    if (/^WEBVTT/i.test(lines[0]) || /^NOTE\b/i.test(lines[0]) || /^STYLE\b/i.test(lines[0])) continue;
    // Optional numeric/name cue id before the timing line.
    const timingIndex = lines[0].includes("-->") ? 0 : 1;
    const timing = lines[timingIndex]?.match(/(\S+)\s*-->\s*(\S+)/);
    if (!timing) continue;
    const start = parseTimestamp(timing[1]);
    const end = parseTimestamp(timing[2]);
    if (start == null || end == null || end <= start) continue;
    const text = cleanCueText(lines.slice(timingIndex + 1).join("\n"));
    if (!text) continue;
    cues.push({ start, end, text });
  }
  return cues.sort((a, b) => a.start - b.start);
}

export function cueAt(cues: readonly SubtitleCue[], timeSec: number): string | null {
  if (!Number.isFinite(timeSec)) return null;
  let lo = 0;
  let hi = cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cue = cues[mid];
    if (timeSec < cue.start) hi = mid - 1;
    else if (timeSec > cue.end) lo = mid + 1;
    else return cue.text;
  }
  return null;
}
