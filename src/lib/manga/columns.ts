// Split-column manga pages (desktop port of mobile lib/manga/tiles.ts).
//
// Some hijala uploads cut every page into a LEFT and a RIGHT half —
// `01_001.jpg` + `01_002.jpg`, equal sizes (345x15000 each; Fight Class 3
// ch.144). Stacked, each half rendered full-width: "half a page, blown up".
// joinColumnPages folds such runs back into one page entry and the reader lays
// the columns out side by side (seam continuity measured left|right 2–12 vs
// top|bottom 67–255 mean pixel diff, so _001 = left). Chromium draws the tall
// halves natively, so unlike mobile there is no tiling here.

const COLUMNS_MARK = "#pantoufa-cols=";
const COLUMN_PART = /^(.*?)(\d+)_0*(\d+)\.([a-z0-9]+)$/i;

/** Stem = host + file name without the `_00N` part. Directories are ignored on
 * purpose: Blogger stores every file under its own unique hash directory
 * (`/img/b/<hash>/s0/01_001.jpg`), and the runs are consecutive pages of one
 * chapter anyway. */
function columnPart(url: string): { stem: string; index: number } | null {
  let host: string;
  let name: string;
  try {
    const u = new URL(url);
    host = u.hostname;
    name = decodeURIComponent(u.pathname.split("/").pop() ?? "");
  } catch {
    return null;
  }
  const m = COLUMN_PART.exec(name);
  return m ? { stem: `${host}|${m[1]}${m[2]}.${m[4].toLowerCase()}`, index: Number(m[3]) } : null;
}

/** Folds `N_001, N_002[, N_003…]` runs (same directory + stem) into one entry:
 * the first column's URL carrying the rest after a fragment. Fragments never
 * reach the server, so a consumer that ignores them still loads column 1. */
export function joinColumnPages(pages: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    const first = columnPart(pages[i]);
    if (!first || first.index !== 1) { out.push(pages[i]); continue; }
    const run = [pages[i]];
    while (i + run.length < pages.length) {
      const next = columnPart(pages[i + run.length]);
      if (!next || next.stem !== first.stem || next.index !== run.length + 1) break;
      run.push(pages[i + run.length]);
    }
    if (run.length < 2) { out.push(pages[i]); continue; }
    out.push(`${run[0]}${COLUMNS_MARK}${run.slice(1).map(encodeURIComponent).join(",")}`);
    i += run.length - 1;
  }
  return out;
}

/** Column URLs of a page entry, left to right (a plain page → [itself]). */
export function pageColumns(uri: string): string[] {
  const at = uri.indexOf(COLUMNS_MARK);
  if (at < 0) return [uri];
  const rest = uri.slice(at + COLUMNS_MARK.length).split(",").filter(Boolean).map((part) => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
  return [uri.slice(0, at), ...rest];
}

