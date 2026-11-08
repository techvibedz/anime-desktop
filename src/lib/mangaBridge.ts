// Anime → manga bridge: "the anime ended here — continue from chapter N".
//
// Read path: get_manga_bridge RPC (shared row + community vote summary). A
// miss (or a stale airing show) asks the companion edge function's "bridge"
// mode once, which grounds itself on AniList and stores the answer for every
// device. Opening resolves the manga in the Arabic manga sources and jumps
// straight into the reader at the continue chapter.

import { storage as AsyncStorage } from "./storage";
import { anilistPost } from "./malInfo";
import { invokeAiFunction } from "./companion";
import { animeTitleKey } from "./history";
import { isSupabaseConfigured, supabase } from "./supabase";
import {
  bridgeSearchTitles,
  pickChapter,
  resolveBridgeView,
  type BridgePayload,
  type BridgeView,
  type BridgeVote,
} from "./mangaBridgeCore";
import { BRIDGE_MATCH_EXACT, bridgeNames, bridgeQueryPlan, rankBridgeCards } from "./mangaBridgeMatch";

export * from "./mangaBridgeCore";

export interface BridgeInfo {
  key: string;
  payload: BridgePayload;
  votes: BridgeVote[];
  mine: number | null;
  view: BridgeView;
}

const CACHE_PREFIX = "@manga_bridge_v1:";
const CACHE_TTL = 12 * 60 * 60 * 1000;
const AIRING_STALE_MS = 4 * 24 * 60 * 60 * 1000;

/** Per-season key shared by every device (title key already carries season words). */
export function bridgeKey(animeTitle: string, season: number): string {
  const base = animeTitleKey(animeTitle);
  if (!base) return "";
  return season > 1 ? `${base}|s${season}` : base;
}

const mem = new Map<string, BridgeInfo | null>();
const inflight = new Map<string, Promise<BridgeInfo | null>>();

async function readRpc(key: string): Promise<{ payload: BridgePayload | null; updatedAt: number; votes: BridgeVote[]; mine: number | null } | null> {
  const { data, error } = await supabase.rpc("get_manga_bridge", { p_anime_key: key });
  if (error || !data || typeof data !== "object") return null;
  const d = data as { payload?: BridgePayload | null; updated_at?: string | null; votes?: { ch: number | string; n: number }[]; mine?: number | string | null };
  return {
    payload: d.payload ?? null,
    updatedAt: d.updated_at ? Date.parse(d.updated_at) : 0,
    votes: (d.votes ?? []).map((v) => ({ ch: Number(v.ch), n: Number(v.n) })).filter((v) => v.ch > 0 && v.n > 0),
    mine: d.mine != null ? Number(d.mine) : null,
  };
}

/**
 * Bridge info for an anime season, or null when unknown / not applicable.
 * `refresh` skips the local caches (after voting).
 */
export function getMangaBridge(ctx: {
  animeTitle: string;
  altTitle?: string;
  season?: number;
  totalEpisodes?: number | null;
  refresh?: boolean;
}): Promise<BridgeInfo | null> {
  const key = bridgeKey(ctx.animeTitle, ctx.season ?? 0);
  if (!key || !isSupabaseConfigured) return Promise.resolve(null);
  if (!ctx.refresh && mem.has(key)) return Promise.resolve(mem.get(key) ?? null);
  const existing = inflight.get(key);
  if (existing && !ctx.refresh) return existing;
  const p = (async (): Promise<BridgeInfo | null> => {
    try {
      if (!ctx.refresh) {
        const raw = await AsyncStorage.getItem(CACHE_PREFIX + key).catch(() => null);
        if (raw) {
          const c = JSON.parse(raw) as { at: number; info: BridgeInfo | null };
          if (Date.now() - c.at < CACHE_TTL) {
            // Re-derive the view so logic changes apply to cached rows too.
            const info = c.info ? { ...c.info, view: resolveBridgeView(c.info.payload, c.info.votes) } : null;
            mem.set(key, info);
            return info;
          }
        }
      }
      let row = await readRpc(key);
      if (!row) return mem.get(key) ?? null; // network/RPC failure: keep what we had
      const stale = !!row.payload?.airing && Date.now() - row.updatedAt > AIRING_STALE_MS;
      if (!row.payload || stale) {
        const res = await invokeAiFunction<{ payload?: BridgePayload }>({
          mode: "bridge",
          animeKey: key,
          animeTitle: ctx.animeTitle,
          altTitle: ctx.altTitle || undefined,
          seasonNumber: ctx.season || undefined,
          totalEpisodes: ctx.totalEpisodes || undefined,
          force: stale || undefined,
        }, 32_000);
        if (res.ok && res.data.payload) row = { ...row, payload: res.data.payload };
        else if (!row.payload) return null; // try again next visit
      }
      const payload = row.payload!;
      const info: BridgeInfo = {
        key,
        payload,
        votes: row.votes,
        mine: row.mine,
        view: resolveBridgeView(payload, row.votes),
      };
      mem.set(key, info);
      AsyncStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ at: Date.now(), info })).catch(() => {});
      return info;
    } catch {
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

export async function voteMangaBridge(key: string, endChapter: number): Promise<boolean> {
  if (!key || !(endChapter > 0) || endChapter >= 10000) return false;
  try {
    const { error } = await supabase.rpc("vote_manga_bridge", { p_anime_key: key, p_end_chapter: endChapter });
    if (error) return false;
    mem.delete(key);
    await AsyncStorage.removeItem(CACHE_PREFIX + key).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

type MangaCard = import("./manga/types").MangaCard;

const MATCH_PREFIX = "@manga_bridge_match_v2:";
const MATCH_TTL = 14 * 24 * 60 * 60 * 1000;
/** Whole lookup budget; wave 2 starts early if wave 1 is slow or empty. */
const SEARCH_BUDGET_MS = 14_000;
const WAVE2_AFTER_MS = 4_500;
const DETAIL_BUDGET_MS = 10_000;
const ANILIST_BUDGET_MS = 5_000;
const matchMem = new Map<string, MangaCard[]>();
const matchInflight = new Map<string, Promise<MangaCard[]>>();

function matchKey(payload: BridgePayload, animeTitle: string): string {
  return [payload.anilistMangaId ?? "", ...bridgeSearchTitles(payload, animeTitle)].join("|").toLowerCase();
}

/**
 * Extra names for the work from AniList: the manga entry itself when the
 * payload knows its id, else the anime's SOURCE relation. Covers payloads the
 * AI left without titles and adds the official synonyms sources title by.
 */
async function anilistNames(payload: BridgePayload, animeTitle: string): Promise<string[]> {
  const fields = "title { romaji english } synonyms";
  const relation = `relations { edges { relationType node { type ${fields} } } }`;
  const body = payload.anilistMangaId
    ? { query: `query($id:Int){ Media(id:$id, type:MANGA){ ${fields} } }`, variables: { id: payload.anilistMangaId } }
    : payload.anilistAnimeId
      ? { query: `query($id:Int){ Media(id:$id, type:ANIME){ ${relation} } }`, variables: { id: payload.anilistAnimeId } }
      : { query: `query($s:String){ Media(search:$s, type:ANIME){ ${relation} } }`, variables: { s: animeTitle } };
  try {
    // Main-process POST (DoH, no CORS); capped so a slow AniList never stalls the lookup.
    const json = await Promise.race([
      anilistPost(body.query, body.variables as Record<string, unknown>),
      new Promise<null>((r) => setTimeout(() => r(null), ANILIST_BUDGET_MS)),
    ]);
    if (!json) return [];
    const media = json?.data?.Media;
    type Node = { type?: string; title?: { romaji?: string; english?: string }; synonyms?: string[] };
    const node: Node | undefined = payload.anilistMangaId
      ? media
      : (media?.relations?.edges ?? []).find(
          (e: { relationType?: string; node?: Node }) => e?.relationType === "SOURCE" && e.node?.type === "MANGA",
        )?.node;
    if (!node) return [];
    return [node.title?.english, node.title?.romaji, ...(node.synonyms ?? [])].filter(
      (x): x is string => typeof x === "string" && !!x.trim(),
    );
  } catch {
    return [];
  }
}

/**
 * Resolve the bridged manga to ranked source cards (best first). Wave 1
 * searches the full names in parallel; wave 2 (colon halves, key words,
 * AniList names) starts when wave 1 settles without an exact hit or runs
 * slow. Every returned card is scored against ALL names, so a short query
 * like "kimetsu" still lands on "Kimetsu No Yaiba". Hits are cached on disk.
 */
function resolveBridgeManga(payload: BridgePayload, animeTitle: string): Promise<MangaCard[]> {
  const key = matchKey(payload, animeTitle);
  if (!key) return Promise.resolve([]);
  const cached = matchMem.get(key);
  if (cached?.length) return Promise.resolve(cached);
  const existing = matchInflight.get(key);
  if (existing) return existing;
  const p = (async (): Promise<MangaCard[]> => {
    try {
      const raw = await AsyncStorage.getItem(MATCH_PREFIX + key).catch(() => null);
      if (raw) {
        const c = JSON.parse(raw) as { at: number; cards: MangaCard[] };
        if (c?.cards?.length && Date.now() - c.at < MATCH_TTL) {
          matchMem.set(key, c.cards);
          return c.cards;
        }
      }
      const { searchMergedManga } = await import("./manga/aggregate");
      const thin = !payload.mangaTitle && !payload.mangaTitleEnglish;
      const aniP = anilistNames(payload, animeTitle);
      // A payload without titles has nothing better to search than AniList's names.
      let names = bridgeNames(payload, animeTitle, thin ? await aniP : []);
      const pool = new Map<string, MangaCard>();
      const rank = () => rankBridgeCards(names, [...pool.values()]);
      const searched = new Set<string>();

      const ranked = await new Promise<ReturnType<typeof rank>>((resolve) => {
        let done = false;
        let pending = 0;
        let wave2Started = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(budget);
          clearTimeout(wave2Timer);
          resolve(rank());
        };
        const consider = (cards: MangaCard[]) => {
          if (done) return;
          for (const c of cards) pool.set(`${c.source}|${c.id}`, c);
          const top = rank()[0];
          if (top && top.score >= BRIDGE_MATCH_EXACT) finish();
        };
        const settle = () => {
          pending -= 1;
          if (pending > 0 || done) return;
          if (!wave2Started) startWave2();
          else finish();
        };
        const run = (queries: string[]) => {
          for (const q of queries) {
            const k = q.toLowerCase();
            if (searched.has(k)) continue;
            searched.add(k);
            pending += 1;
            searchMergedManga(q, undefined, consider).then(consider, () => {}).finally(settle);
          }
        };
        const startWave2 = () => {
          if (wave2Started || done) return;
          wave2Started = true;
          pending += 1; // hold the wave open until its queries are queued
          void aniP.then((extra) => {
            if (!done && extra.length && !thin) names = bridgeNames(payload, animeTitle, extra);
            if (!done) {
              const plan = bridgeQueryPlan(names);
              run([...plan.first, ...plan.second]);
            }
            settle();
          });
        };
        const budget = setTimeout(finish, SEARCH_BUDGET_MS);
        const wave2Timer = setTimeout(startWave2, WAVE2_AFTER_MS);
        const first = bridgeQueryPlan(names).first;
        if (first.length) run(first);
        else startWave2();
      });

      const cards = ranked.slice(0, 4).map((r) => r.card);
      if (cards.length) {
        matchMem.set(key, cards);
        AsyncStorage.setItem(MATCH_PREFIX + key, JSON.stringify({ at: Date.now(), cards })).catch(() => {});
      }
      return cards;
    } catch {
      return [];
    } finally {
      matchInflight.delete(key);
    }
  })();
  matchInflight.set(key, p);
  return p;
}

/** Warm the manga lookup in the background so the read button opens fast. */
export function prefetchBridgeManga(payload: BridgePayload, animeTitle: string): void {
  void resolveBridgeManga(payload, animeTitle);
}

/**
 * Find the bridged manga in the Arabic manga sources and return the route to
 * open it at `chapter` (reader), or its detail page when that chapter isn't
 * uploaded. Desktop: the caller navigates (react-router) to `path`.
 * The top candidates are checked in parallel; the best-ranked one that
 * actually carries the chapter wins, so a near-duplicate card with an empty
 * or short chapter list never blocks the jump.
 */
export async function openBridgeChapter(
  payload: BridgePayload,
  animeTitle: string,
  chapter: number | null,
): Promise<{ kind: "reader" | "detail"; path: string } | { kind: "notfound" }> {
  const [{ fetchMergedDetail }, nav, cards] = await Promise.all([
    import("./manga/aggregate"),
    import("./manga/nav"),
    resolveBridgeManga(payload, animeTitle),
  ]);
  if (!cards.length) return { kind: "notfound" };
  const card = cards[0];
  if (chapter != null) {
    type Merged = import("./manga/types").MergedMangaDetail;
    type Hit = { card: MangaCard; ch: Merged["chapters"][number]; title: string; cover: string | null };
    const candidates = cards.slice(0, 3);
    const hit = await new Promise<Hit | null>((resolve) => {
      let done = false;
      // undefined = still loading · null = no such chapter · Hit = has it
      const hits: (Hit | null | undefined)[] = candidates.map(() => undefined);
      const finish = (h: Hit | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(h);
      };
      // The best-ranked candidate whose answer is known wins: a hit at index
      // i opens once every better-ranked candidate has missed.
      const decide = () => {
        for (const h of hits) {
          if (h === undefined) return;
          if (h) return finish(h);
        }
        finish(null);
      };
      const timer = setTimeout(() => finish(hits.find((h) => h) ?? null), DETAIL_BUDGET_MS);
      candidates.forEach((c, i) => {
        // Any stage (anchor source first, then the cross-source merge) counts.
        const check = (detail: Merged) => {
          if (hits[i]) return;
          const ch = pickChapter(detail.chapters, chapter);
          if (ch) {
            hits[i] = { card: c, ch, title: detail.title || c.title, cover: detail.cover ?? c.cover ?? null };
            decide();
          }
        };
        const miss = () => {
          if (hits[i] === undefined) hits[i] = null;
          decide();
        };
        fetchMergedDetail(c.source, c.id, { onUpdate: check }).then((d) => { check(d); miss(); }, miss);
      });
    });
    if (hit) {
      return {
        kind: "reader",
        path: nav.mangaReaderPath({
          source: hit.card.source,
          mangaId: hit.card.id,
          mangaTitle: hit.title,
          cover: hit.cover,
          chapter: { source: hit.ch.source, mangaId: hit.ch.mangaId, id: hit.ch.id, number: hit.ch.number },
        }),
      };
    }
  }
  return { kind: "detail", path: nav.mangaDetailPath({ source: card.source, id: card.id, title: card.title, cover: card.cover }) };
}
