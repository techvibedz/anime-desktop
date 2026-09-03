// Client-side fuzzy title matching. Ported from the mobile app (lib/fuzzy.ts).
//
// The source sites' own search engines (witanime/anime4up WordPress search,
// anime3rb's slug/catalog match) are EXACT/substring based: a one-letter typo
// ("narto"), a different spacing ("full metal" vs "fullmetal"), or a colon
// dropped ("re zero" vs "Re:Zero") makes them return nothing or bury the real
// title under junk. This module scores how close a free-text query is to a
// candidate title so the app can re-rank whatever the sources DID return so the
// best match floats to the top.

// Normalize for fuzzy comparison: lowercase, strip diacritics, fold Arabic
// orthographic variants, and reduce to alphanumeric + Arabic letters separated
// by single spaces. Keeps both Latin and Arabic so an Arabic query still ranks.
export function normFuzzy(s: string): string {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")  // strip Latin diacritics (é → e)
    .toLowerCase()
    .replace(/[ً-ْ]/g, "")  // strip Arabic harakat
    .replace(/[آأإ]/g, "ا") // أ إ آ → ا
    .replace(/ة/g, "ه")     // ة → ه
    .replace(/ى/g, "ي")     // ى → ي
    .replace(/[^a-z0-9ء-ي ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Levenshtein edit distance with an early-out cap.
export function levenshtein(a: string, b: string, max = 99): number {
  if (a === b) return 0;
  const la = a.length, lb = b.length;
  if (!la) return lb;
  if (!lb) return la;
  if (Math.abs(la - lb) > max) return max + 1;
  let prev = new Array(lb + 1);
  let curr = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      const v = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    const tmp = prev; prev = curr; curr = tmp;
  }
  return prev[lb];
}

// How well a single query token is covered by any title token. Returns 0..1.
function tokenMatch(qt: string, titleTokens: string[]): number {
  let best = 0;
  for (const tt of titleTokens) {
    if (tt === qt) return 1;
    let s = 0;
    if (qt.length >= 3 && (tt.startsWith(qt) || qt.startsWith(tt))) s = 0.9;
    else if (qt.length >= 4 && tt.length >= 4 && levenshtein(qt, tt, 1) <= 1) s = 0.82;
    else if (qt.length >= 6 && tt.length >= 6 && levenshtein(qt, tt, 2) <= 2) s = 0.66;
    if (s > best) best = s;
  }
  return best;
}

// Similarity of `query` to `title`, 0..1.
export function fuzzyScore(query: string, title: string): number {
  const q = normFuzzy(query);
  const t = normFuzzy(title);
  if (!q || !t) return 0;
  if (q === t) return 1;

  const qTokens = q.split(" ").filter(Boolean);
  const tTokens = t.split(" ").filter(Boolean);
  if (!qTokens.length || !tTokens.length) return 0;

  let sum = 0;
  for (const qt of qTokens) sum += tokenMatch(qt, tTokens);
  let coverage = sum / qTokens.length;
  if (t.startsWith(q)) coverage = Math.min(1, coverage + 0.1);
  else if (t.includes(q)) coverage = Math.min(1, coverage + 0.05);

  const qc = qTokens.join("");
  const tc = tTokens.join("");
  let compactSim = 0;
  if (qc && tc.includes(qc)) {
    compactSim = 0.85 + 0.1 * Math.min(1, qc.length / tc.length);
  } else if (qc.length >= 4 && Math.abs(qc.length - tc.length) <= Math.ceil(qc.length * 0.4)) {
    const d = levenshtein(qc, tc, Math.ceil(qc.length * 0.4));
    compactSim = 1 - d / Math.max(qc.length, tc.length);
  }

  return Math.max(coverage, compactSim);
}

/** Broader source queries used alongside the complete phrase. WordPress
 * source search treats multi-word text as one exact-ish phrase; querying a few
 * meaningful pieces recovers misspellings such as "naruto shuppudin" via
 * "naruto", while fuzzyScore still ranks the closest full title first. */
export function wordSearchFallbacks(query: string, limit = 4): string[] {
  const tokens = normFuzzy(query).split(" ").filter(Boolean);
  if (tokens.length < 2) return [];
  const noise = new Set([
    "the", "and", "of", "in", "no", "to", "season", "part", "cour",
    "anime", "series", "الجزء", "الموسم", "انمي",
  ]);
  const out: string[] = [];
  for (const token of tokens) {
    if (token.length < 3 || noise.has(token) || out.includes(token)) continue;
    out.push(token);
    if (out.length >= limit) break;
  }
  return out;
}

/** Query plan shared with the mobile app: search the exact text, its normalized
 * spelling, and meaningful words concurrently. Results are still ranked
 * against the full user query, so broad word hits cannot outrank exact ones. */
export function sourceSearchQueries(query: string, limit = 6): string[] {
  const out: string[] = [];
  const add = (value: string) => {
    const trimmed = value.replace(/\s+/g, " ").trim();
    const key = trimmed.toLowerCase();
    if (trimmed && !out.some((item) => item.toLowerCase() === key)) out.push(trimmed);
  };
  add(query);
  add(normFuzzy(query));
  for (const word of wordSearchFallbacks(query)) add(word);
  return out.slice(0, limit);
}
