// Taste engine — pure logic (no RN imports, unit-tested in tasteCore.test.ts).
//
// Turns the user's real viewing behaviour into a taste profile and ranks
// candidate anime against it:
//
//   1) groupForTaste()   raw watch-history rows → one TasteAnime per show,
//                        with episode timestamps (pace, last activity).
//   2) classifyAnime()   finished / binged / watching / stalled / dropped /
//                        sampled → a signed weight. Dropping a show early is a
//                        NEGATIVE signal; finishing or bingeing is a strong
//                        positive one.
//   3) buildProfile()    signed weights spread over each show's AniList
//                        genres, themes (tags), length and studio → affinities.
//   4) scoreCandidate()  candidate media vs profile + community endorsements
//                        from the user's own favourites → score, match %, and
//                        structured reasons the UI turns into Arabic text.
//   5) rankTaste()       exclusions, filters and diversity (no rail of six
//                        near-identical shows).

/* ── Shapes ─────────────────────────────────────────────────────────── */

export interface TasteMedia {
  id: number;
  title: string;
  titleEnglish: string | null;
  image: string | null;
  format: string | null;
  episodes: number | null;
  status: string | null;
  averageScore: number | null;
  popularity: number | null;
  seasonYear: number | null;
  genres: string[];
  tags: { name: string; rank: number }[];
  studios: string[];
  isAdult?: boolean;
  /** AniList PREQUEL/PARENT anime — a sequel is only a pick once these are seen. */
  prequelIds?: number[];
}

/** One history row, as groupForTaste reads it. */
export interface TasteEntry {
  animeTitle: string;
  animeHref: string;
  image: string;
  epNum: number | null;
  updatedAt: number;
  /** Watched past 80% (or explicitly completed). */
  completed: boolean;
}

export interface TasteAnime {
  key: string;
  title: string;
  href: string;
  image: string;
  /** Distinct episodes the user finished. */
  watchedEps: number;
  /** Distinct episodes the user opened at all. */
  touchedEps: number;
  /** Highest episode number reached. */
  maxEp: number;
  firstAt: number;
  lastAt: number;
  /** Distinct calendar days with a finished episode. */
  activeDays: number;
  /** Most finished episodes on a single day. */
  bestDay: number;
  /** Completion record: watched the finale of a finished show, or ✓-marked. */
  finished: boolean;
  marked: boolean;
  /** Caught up with an airing show. */
  caughtUp: boolean;
  media?: TasteMedia | null;
}

export type Verdict = "finished" | "binged" | "watching" | "stalled" | "dropped" | "sampled";

export interface Classified {
  verdict: Verdict;
  /** Signed: >0 liked, <0 disliked. */
  weight: number;
}

/* ── 1. Grouping ────────────────────────────────────────────────────── */

const DAY = 24 * 60 * 60 * 1000;

function dayOf(ts: number, tzOffsetMin: number): string {
  return new Date(ts - tzOffsetMin * 60_000).toISOString().slice(0, 10);
}

export function groupForTaste(
  entries: readonly TasteEntry[],
  keyOf: (e: TasteEntry) => string,
  tzOffsetMin = 0,
): TasteAnime[] {
  const groups = new Map<string, TasteEntry[]>();
  for (const e of entries) {
    if (!e || !e.updatedAt) continue;
    const key = keyOf(e);
    if (!key) continue;
    const list = groups.get(key);
    if (list) list.push(e);
    else groups.set(key, [e]);
  }
  const out: TasteAnime[] = [];
  for (const [key, list] of groups) {
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    const touched = new Set<string>();
    const watched = new Set<string>();
    const perDay = new Map<string, number>();
    let maxEp = 0;
    let firstAt = Infinity;
    let lastAt = 0;
    let image = "";
    let href = "";
    for (const e of list) {
      const ek = e.epNum != null ? `n${e.epNum}` : `t${e.updatedAt}`;
      touched.add(ek);
      if (e.epNum != null) maxEp = Math.max(maxEp, e.epNum);
      firstAt = Math.min(firstAt, e.updatedAt);
      lastAt = Math.max(lastAt, e.updatedAt);
      if (!image && e.image) image = e.image;
      if (!href && e.animeHref?.includes("/anime/")) href = e.animeHref;
      if (e.completed && !watched.has(ek)) {
        watched.add(ek);
        const d = dayOf(e.updatedAt, tzOffsetMin);
        perDay.set(d, (perDay.get(d) ?? 0) + 1);
      }
    }
    out.push({
      key,
      title: list.find((e) => e.animeTitle)?.animeTitle || "",
      href: href || list.find((e) => e.animeHref)?.animeHref || "",
      image,
      watchedEps: watched.size,
      touchedEps: touched.size,
      maxEp,
      firstAt: Number.isFinite(firstAt) ? firstAt : lastAt,
      lastAt,
      activeDays: perDay.size,
      bestDay: Math.max(0, ...perDay.values()),
      finished: false,
      marked: false,
      caughtUp: false,
    });
  }
  return out.sort((a, b) => b.lastAt - a.lastAt);
}

/* ── 2. Classification ──────────────────────────────────────────────── */

/** Idle this long without finishing → the show was put down. */
export const DROP_IDLE_DAYS = 21;

export function totalEpisodes(a: TasteAnime): number | null {
  const n = a.media?.episodes;
  return typeof n === "number" && n > 0 ? n : null;
}

export function classifyAnime(a: TasteAnime, now: number): Classified {
  const total = totalEpisodes(a);
  const idleDays = (now - a.lastAt) / DAY;
  const pace = a.activeDays > 0 ? a.watchedEps / a.activeDays : 0;
  const binge = a.watchedEps >= 4 && (pace >= 3.5 || a.bestDay >= 5);
  // Long-ago activity fades; a dislike stays meaningful longer.
  const recency = Math.max(0.35, Math.pow(0.5, Math.max(0, now - a.lastAt) / (180 * DAY)));

  const finished =
    a.finished || a.marked ||
    (total != null && total > 1 && a.watchedEps >= Math.max(1, Math.ceil(total * 0.85))) ||
    (total === 1 && a.watchedEps >= 1);
  if (finished) return { verdict: binge ? "binged" : "finished", weight: (binge ? 3.5 : 3) * recency };

  if (a.caughtUp) return { verdict: "watching", weight: 2.2 * recency };

  if (idleDays < DROP_IDLE_DAYS) {
    if (a.watchedEps <= 1 && a.touchedEps <= 1) return { verdict: "sampled", weight: 0.3 };
    if (binge) return { verdict: "binged", weight: 2.5 * recency };
    return { verdict: "watching", weight: (1 + Math.min(1, a.watchedEps / 10)) * recency };
  }

  // Idle and unfinished.
  const progress = total ? a.maxEp / total : null;
  const early = a.watchedEps <= 3 || (progress != null && progress < 0.25 && a.watchedEps < 8);
  if (early) {
    // One episode opened long ago is weak evidence; three abandoned is strong.
    const strength = a.touchedEps <= 1 ? 0.5 : a.watchedEps <= 1 ? 1.2 : 2;
    return { verdict: "dropped", weight: -strength * Math.max(0.6, recency) };
  }
  // Watched a big chunk then stopped: they liked it (long shows are put down
  // for time, not taste), just less than a finished one.
  if (a.watchedEps >= 12) return { verdict: "stalled", weight: 1.2 * recency };
  return { verdict: "stalled", weight: -0.4 * Math.max(0.6, recency) };
}

/* ── 3. Profile ─────────────────────────────────────────────────────── */

export type LengthBucket = "movie" | "short" | "medium" | "long";

export function lengthBucket(m: Pick<TasteMedia, "format" | "episodes">): LengthBucket {
  if (m.format === "MOVIE") return "movie";
  const n = m.episodes ?? 0;
  if (n > 0 && n <= 13) return "short";
  if (n > 0 && n <= 30) return "medium";
  if (n > 30) return "long";
  return "medium";
}

/** Tags worth learning from (themes, not trivia or content warnings). */
const MIN_TAG_RANK = 55;
const IGNORED_TAGS = new Set([
  "Male Protagonist", "Female Protagonist", "Ensemble Cast", "Primarily Adult Cast",
  "Primarily Teen Cast", "Primarily Male Cast", "Primarily Female Cast", "Primarily Child Cast",
  "Episodic", "Heterosexual", "Nudity", "Ecchi", "Large Breasts", "Fan Service", "Kuudere",
  "Tsundere", "Anti-Hero", "Twins", "Time Skip", "Coming of Age",
]);

export function usableTags(m: Pick<TasteMedia, "tags">): { name: string; rank: number }[] {
  return (m.tags ?? []).filter((t) => t && t.rank >= MIN_TAG_RANK && !IGNORED_TAGS.has(t.name));
}

export interface SeedRef {
  title: string;
  anilistId: number;
  verdict: Verdict;
  weight: number;
}

export interface TasteProfile {
  genres: Record<string, number>;
  /** Genres the user clearly avoids (dislike evidence outweighs likes). */
  avoided: string[];
  tags: Record<string, number>;
  lengths: Record<LengthBucket, number>;
  studios: Record<string, number>;
  /** Positive seeds, strongest first (for endorsements + reasons). */
  seeds: SeedRef[];
  /** Media ids the user already engaged with (never recommended back). */
  seenIds: Set<number>;
  /** Prequels of watched shows (Naruto when Shippuden was watched): already
   *  seen or deliberately skipped — never a "discovery". */
  relatedIds: Set<number>;
  stats: {
    analysed: number;
    finished: number;
    binged: number;
    watching: number;
    dropped: number;
    /** finished / (finished + dropped + idle-stalled), 0..100. */
    completionRate: number;
    /** Median episode the user drops at (dropped shows only). */
    dropAt: number | null;
    /** Average finished episodes per active day across everything. */
    pace: number;
  };
}

/** Explicit "not interested" taps: learned as a mild dislike. */
export interface HiddenMedia {
  id: number;
  genres: string[];
  tags: { name: string; rank: number }[];
}

export function buildProfile(
  anime: readonly TasteAnime[],
  now: number,
  hidden: readonly HiddenMedia[] = [],
): TasteProfile {
  const genres: Record<string, number> = {};
  const tags: Record<string, number> = {};
  const lengths: Record<LengthBucket, number> = { movie: 0, short: 0, medium: 0, long: 0 };
  const studios: Record<string, number> = {};
  const seeds: SeedRef[] = [];
  const seenIds = new Set<number>();
  const relatedIds = new Set<number>();
  let pos = 0;
  let finished = 0, binged = 0, watching = 0, dropped = 0, stalledIdle = 0;
  const dropEps: number[] = [];
  let paceEps = 0, paceDays = 0;

  // Dislikes count at half strength: sampling and putting a show down says
  // less about taste than finishing one does. Without this, users who try
  // many shows ended up with every genre negative.
  const NEG = 0.5;
  const genrePos: Record<string, number> = {};
  const genreNeg: Record<string, number> = {};
  const add = (rec: Record<string, number>, k: string, v: number) => { rec[k] = (rec[k] ?? 0) + (v < 0 ? v * NEG : v); };

  for (const a of anime) {
    const c = classifyAnime(a, now);
    if (c.verdict === "finished") finished++;
    else if (c.verdict === "binged") { binged++; if (a.finished || a.marked) finished++; }
    else if (c.verdict === "watching") watching++;
    else if (c.verdict === "dropped") { dropped++; if (a.maxEp > 0) dropEps.push(a.maxEp); }
    else if (c.verdict === "stalled" && c.weight < 0) stalledIdle++;
    paceEps += a.watchedEps;
    paceDays += a.activeDays;

    const m = a.media;
    if (!m) continue;
    seenIds.add(m.id);
    for (const id of m.prequelIds ?? []) relatedIds.add(id);
    const w = c.weight;
    if (w > 0) pos += w;
    for (const g of m.genres ?? []) {
      add(genres, g, w);
      if (w > 0) genrePos[g] = (genrePos[g] ?? 0) + w;
      else genreNeg[g] = (genreNeg[g] ?? 0) - w;
    }
    for (const t of usableTags(m)) add(tags, t.name, w * (t.rank / 100));
    lengths[lengthBucket(m)] += w;
    for (const s of (m.studios ?? []).slice(0, 1)) add(studios, s, w);
    if (w >= 0.8) seeds.push({ title: m.title, anilistId: m.id, verdict: c.verdict, weight: w });
  }
  for (const h of hidden) {
    seenIds.add(h.id);
    for (const g of h.genres ?? []) add(genres, g, -0.6);
    for (const t of (h.tags ?? []).filter((x) => x.rank >= MIN_TAG_RANK)) add(tags, t.name, -0.6 * (t.rank / 100));
  }

  // Normalise by the total positive evidence so affinities are ~-1..1
  // whatever the history size.
  const norm = Math.max(3, pos);
  for (const rec of [genres, tags, studios] as Record<string, number>[]) {
    for (const k of Object.keys(rec)) rec[k] /= norm;
  }
  for (const k of Object.keys(lengths) as LengthBucket[]) lengths[k] /= norm;

  const totalNeg = Object.values(genreNeg).reduce((a, b) => Math.max(a, b), 0);
  const avoided = Object.keys(genreNeg)
    .filter((g) => genreNeg[g] >= 2 * (genrePos[g] ?? 0) && genreNeg[g] >= 1.5 && genreNeg[g] >= totalNeg * 0.4)
    .sort((a, b) => genreNeg[b] - genreNeg[a]);

  dropEps.sort((a, b) => a - b);
  const finishedDen = finished + dropped + stalledIdle;
  return {
    genres, avoided, tags, lengths, studios,
    seeds: seeds.sort((a, b) => b.weight - a.weight),
    seenIds,
    relatedIds,
    stats: {
      analysed: anime.filter((a) => a.media).length,
      finished,
      binged,
      watching,
      dropped,
      completionRate: finishedDen ? Math.round((finished / finishedDen) * 100) : 0,
      dropAt: dropEps.length ? dropEps[Math.floor((dropEps.length - 1) / 2)] : null,
      pace: paceDays ? Math.round((paceEps / paceDays) * 10) / 10 : 0,
    },
  };
}

/** Strongest liked genres (positive affinity only), best first. */
export function topAffinities(rec: Record<string, number>, k: number): { name: string; value: number }[] {
  return Object.entries(rec)
    .filter(([, v]) => v > 0.02)
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([name, value]) => ({ name, value }));
}

/** Strongest disliked genres/themes. */
export function bottomAffinities(rec: Record<string, number>, k: number): { name: string; value: number }[] {
  return Object.entries(rec)
    .filter(([, v]) => v < -0.04)
    .sort((a, b) => a[1] - b[1])
    .slice(0, k)
    .map(([name, value]) => ({ name, value }));
}

/** The length bucket the user does best with (null = no clear preference). */
export function preferredLength(p: TasteProfile): LengthBucket | null {
  const entries = (Object.entries(p.lengths) as [LengthBucket, number][]).sort((a, b) => b[1] - a[1]);
  const [best, second] = entries;
  if (!best || best[1] <= 0.05) return null;
  return !second || best[1] - second[1] > 0.08 ? best[0] : null;
}

/* ── 4. Scoring ─────────────────────────────────────────────────────── */

/** Community endorsement: seed `seedId` lists the candidate with `rating` upvotes. */
export interface Endorsement {
  seedId: number;
  rating: number;
}

export type TasteReason =
  | { kind: "because"; seed: string; verdict: Verdict }
  | { kind: "genres"; genres: string[] }
  | { kind: "theme"; tag: string }
  | { kind: "length"; bucket: LengthBucket }
  | { kind: "acclaimed"; score: number }
  | { kind: "studio"; studio: string };

export interface ScoredCandidate {
  media: TasteMedia;
  score: number;
  /** 0..100 display match. */
  match: number;
  reasons: TasteReason[];
}

function affinityOf(rec: Record<string, number>, key: string): number {
  return rec[key] ?? 0;
}

export function scoreCandidate(
  m: TasteMedia,
  p: TasteProfile,
  endorsements: readonly Endorsement[] = [],
): ScoredCandidate {
  // Genres: mean affinity × sqrt(n) — rewards several matching genres
  // without letting a 7-genre show win on breadth alone.
  const gs = (m.genres ?? []).map((g) => ({ g, a: affinityOf(p.genres, g) }));
  const genreScore = gs.length ? gs.reduce((s, x) => s + x.a, 0) / Math.sqrt(gs.length) : 0;
  const tg = usableTags(m).map((t) => ({ t: t.name, a: affinityOf(p.tags, t.name) * (t.rank / 100) }));
  const tagScore = tg.length ? tg.reduce((s, x) => s + x.a, 0) / Math.sqrt(tg.length) : 0;
  const bucket = lengthBucket(m);
  const lengthFit = p.lengths[bucket] ?? 0;
  const studio = (m.studios ?? [])[0];
  const studioFit = studio ? Math.max(0, affinityOf(p.studios, studio)) : 0;
  const quality = m.averageScore != null ? Math.max(-1, Math.min(1, (m.averageScore - 72) / 18)) : 0;

  // Endorsements from the user's own liked shows, scaled by how much they
  // liked that show and how strongly the community links the two.
  const seedWeight = new Map(p.seeds.map((s) => [s.anilistId, s]));
  let endorse = 0;
  let bestSeed: { seed: SeedRef; part: number } | null = null;
  for (const e of endorsements) {
    const seed = seedWeight.get(e.seedId);
    if (!seed) continue;
    const part = Math.min(1, Math.log2(1 + Math.max(0, e.rating)) / 7) * Math.min(1.5, seed.weight / 2.5);
    endorse += part;
    if (!bestSeed || part > bestSeed.part) bestSeed = { seed, part };
  }
  endorse = Math.min(1.6, endorse);

  const score =
    1.15 * genreScore +
    1.0 * tagScore +
    0.45 * lengthFit +
    0.25 * studioFit +
    0.6 * quality +
    0.9 * endorse;

  // Display match: logistic squash into a believable 55–99 range.
  const match = Math.round(50 + 46 / (1 + Math.exp(-(score - 1.05) * 1.5)));

  const reasons: TasteReason[] = [];
  if (bestSeed && bestSeed.part >= 0.25) {
    reasons.push({ kind: "because", seed: bestSeed.seed.title, verdict: bestSeed.seed.verdict });
  }
  const likedGenres = gs.filter((x) => x.a > 0.12).sort((a, b) => b.a - a.a).slice(0, 2).map((x) => x.g);
  if (likedGenres.length) reasons.push({ kind: "genres", genres: likedGenres });
  const bestTag = tg.filter((x) => x.a > 0.08).sort((a, b) => b.a - a.a)[0];
  if (bestTag && reasons.length < 3) reasons.push({ kind: "theme", tag: bestTag.t });
  if (lengthFit > 0.15 && preferredLength(p) === bucket && reasons.length < 3) reasons.push({ kind: "length", bucket });
  if (studio && studioFit > 0.25 && reasons.length < 3) reasons.push({ kind: "studio", studio });
  if (m.averageScore != null && m.averageScore >= 84 && reasons.length < 3) reasons.push({ kind: "acclaimed", score: m.averageScore });

  return { media: m, score, match: Math.max(1, Math.min(99, match)), reasons };
}

/* ── 5. Ranking ─────────────────────────────────────────────────────── */

export type TasteFilter = "all" | "short" | "finished" | "movie" | "airing";

export function passesFilter(m: TasteMedia, f: TasteFilter): boolean {
  switch (f) {
    case "short": return m.format !== "MOVIE" && (m.episodes ?? 99) <= 13;
    case "finished": return m.status === "FINISHED" && m.format !== "MOVIE";
    case "movie": return m.format === "MOVIE";
    case "airing": return m.status === "RELEASING";
    default: return true;
  }
}

function genreOverlap(a: readonly string[], b: readonly string[]): number {
  if (!a.length || !b.length) return 0;
  const sb = new Set(b);
  let shared = 0;
  for (const g of a) if (sb.has(g)) shared++;
  return shared / (a.length + b.length - shared);
}

/** First two Latin words — a crude franchise key ("Shingeki no Kyojin ..."). */
export function franchiseKey(title: string): string {
  return (title || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(" ");
}

export function rankTaste(
  candidates: readonly TasteMedia[],
  p: TasteProfile,
  opts: {
    endorsements?: ReadonlyMap<number, Endorsement[]>;
    excluded?: (m: TasteMedia) => boolean;
    filter?: TasteFilter;
    cap?: number;
  } = {},
): ScoredCandidate[] {
  const cap = opts.cap ?? 30;
  const seenFranchises = new Set<string>();
  for (const s of p.seeds) seenFranchises.add(franchiseKey(s.title));
  const scored: ScoredCandidate[] = [];
  const ids = new Set<number>();
  for (const m of candidates) {
    if (!m || ids.has(m.id) || p.seenIds.has(m.id) || p.relatedIds.has(m.id)) continue;
    if (m.isAdult || (m.genres ?? []).includes("Hentai")) continue;
    // Ecchi only for users whose own history leans that way.
    if ((m.genres ?? []).includes("Ecchi") && (p.genres.Ecchi ?? 0) <= 0.15) continue;
    // "Season 4" of a show the user never started is not a recommendation.
    if ((m.prequelIds ?? []).length && !(m.prequelIds ?? []).some((id) => p.seenIds.has(id))) continue;
    if (opts.excluded?.(m)) continue;
    if (!passesFilter(m, opts.filter ?? "all")) continue;
    ids.add(m.id);
    const sc = scoreCandidate(m, p, opts.endorsements?.get(m.id) ?? []);
    // A sequel/side story of something already watched is not a discovery.
    if (seenFranchises.has(franchiseKey(m.title))) sc.score -= 0.6;
    scored.push(sc);
  }
  scored.sort((a, b) => b.score - a.score || (b.media.popularity ?? 0) - (a.media.popularity ?? 0));

  // Greedy diversity: each pick penalises later candidates that share its
  // genre mix or franchise.
  const out: ScoredCandidate[] = [];
  const pool = scored.slice(0, Math.max(cap * 3, 60));
  while (out.length < cap && pool.length) {
    let bestIdx = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i];
      let penalty = 0;
      for (const o of out) {
        penalty = Math.max(penalty, genreOverlap(c.media.genres, o.media.genres) * 0.35);
        if (franchiseKey(c.media.title) === franchiseKey(o.media.title)) penalty = Math.max(penalty, 1);
      }
      const val = c.score - penalty;
      if (val > bestVal) { bestVal = val; bestIdx = i; }
    }
    out.push(pool.splice(bestIdx, 1)[0]);
  }
  return out;
}

/** Stable signature of what the ranking depends on (to know when to recompute). */
export function profileSignature(anime: readonly TasteAnime[], hiddenIds: readonly number[]): string {
  const parts = anime
    .map((a) => `${a.key}:${a.watchedEps}:${a.finished || a.marked ? 1 : 0}`)
    .sort();
  return `${parts.join(",")}|h${[...hiddenIds].sort((a, b) => a - b).join(",")}`;
}
