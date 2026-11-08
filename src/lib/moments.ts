// Shared moments — "look what happens at 14:32" links.
//
// A moment is a short public row (shared_moments) with everything needed to
// reopen the episode at a timestamp. The share link points at the web page on
// pantoufa-join.pages.dev (/m/<id>), which renders a rich preview and hands
// off to the app via intent://moment/<id>; inside the app /moment/[id] loads
// the row and opens the player at that second.

import { storage as AsyncStorage } from "./storage";
import { isSupabaseConfigured, supabase } from "./supabase";

export const MOMENT_WEB_BASE = "https://pantoufa-join.pages.dev/m/";

export interface Moment {
  id: string;
  episode_href: string;
  anime_href: string | null;
  anime_title: string;
  ep_num: number | null;
  image: string | null;
  t_sec: number;
  note: string | null;
  sharer_name: string | null;
  url4up: string | null;
  url3rb: string | null;
}

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
export function genMomentId(len = 8): string {
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return out;
}

export function momentLink(id: string): string {
  return MOMENT_WEB_BASE + id;
}

const ID_RE = /^[A-Za-z0-9]{6,12}$/;
export function isMomentId(id: string | null | undefined): id is string {
  return !!id && ID_RE.test(id);
}

const httpsOrNull = (u?: string | null) => (u && /^https:\/\//.test(u) ? u.slice(0, 1000) : null);

export async function createMoment(input: {
  episodeHref: string;
  animeHref?: string | null;
  animeTitle: string;
  epNum?: number | null;
  image?: string | null;
  tSec: number;
  sharerName?: string | null;
  url4up?: string | null;
  url3rb?: string | null;
}): Promise<{ ok: true; id: string; url: string } | { ok: false; reason: "signin" | "rate_limited" | "invalid" | "error" }> {
  if (!isSupabaseConfigured) return { ok: false, reason: "error" };
  const episodeHref = httpsOrNull(input.episodeHref);
  const title = (input.animeTitle || "").trim().slice(0, 200);
  if (!episodeHref || !title) return { ok: false, reason: "invalid" };
  const { data: s } = await supabase.auth.getSession();
  if (!s?.session) return { ok: false, reason: "signin" };
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = genMomentId();
    const { error } = await supabase.from("shared_moments").insert({
      id,
      episode_href: episodeHref,
      anime_href: httpsOrNull(input.animeHref),
      anime_title: title,
      ep_num: input.epNum != null && input.epNum >= 0 && input.epNum <= 5000 ? Math.round(input.epNum) : null,
      image: httpsOrNull(input.image),
      t_sec: Math.max(0, Math.min(20000, Math.round(input.tSec))),
      sharer_name: (input.sharerName || "").trim().slice(0, 60) || null,
      url4up: httpsOrNull(input.url4up),
      url3rb: httpsOrNull(input.url3rb),
    });
    if (!error) return { ok: true, id, url: momentLink(id) };
    if (error.code === "23505") continue; // id collision — try another
    if (/rate_limited/i.test(error.message || "")) return { ok: false, reason: "rate_limited" };
    return { ok: false, reason: "error" };
  }
  return { ok: false, reason: "error" };
}

export async function fetchMoment(id: string): Promise<Moment | null> {
  if (!isMomentId(id) || !isSupabaseConfigured) return null;
  try {
    const { data, error } = await supabase.from("shared_moments").select("*").eq("id", id).maybeSingle();
    if (error || !data) return null;
    return data as Moment;
  } catch {
    return null;
  }
}

/* ── Pending moment (link tapped while signed out) ── */
const PENDING_KEY = "@moment_pending";
let pending: string | null = null;

export function setPendingMoment(id: string): void {
  if (!isMomentId(id)) return;
  pending = id;
  AsyncStorage.setItem(PENDING_KEY, id).catch(() => {});
}

export async function takePendingMoment(): Promise<string | null> {
  if (!pending) {
    try {
      const stored = await AsyncStorage.getItem(PENDING_KEY);
      if (isMomentId(stored)) pending = stored;
    } catch {}
  }
  const id = pending;
  pending = null;
  AsyncStorage.removeItem(PENDING_KEY).catch(() => {});
  return id;
}
