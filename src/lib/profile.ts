// Profile editing — display name, bio, and avatar.
//
// Backend-light, consistent with the rest of the app: there is no `profiles`
// table. We persist editable fields into Supabase Auth `user_metadata`
// (`full_name`, `bio`, `avatar_url`), which the profile screen already reads
// from. The avatar image is uploaded to the public `avatars` storage bucket
// under the user's own folder (`<uid>/<ts>.jpg`) and its public URL is stored
// on the metadata.

import { supabase, isSupabaseConfigured } from "./supabase";

export interface ProfileUpdate {
  name: string;
  bio: string;
  /** Avatar picked from the desktop file picker. */
  avatarFile?: File | null;
  /** Base64-encoded JPEG (no data: prefix; data: prefix tolerated). */
  avatarBase64?: string | null;
}

export type ProfileResult =
  | { ok: true; avatarUrl: string | null }
  | { ok: false; error: string };

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/^data:[^,]+,/, "").replace(/[^A-Za-z0-9+/=]/g, "");
  return Uint8Array.from(atob(clean), (c) => c.charCodeAt(0));
}

async function uploadAvatar(image: File | string, userId: string): Promise<string | null> {
  let body: File | Uint8Array;
  if (typeof image === "string") {
    body = base64ToBytes(image);
    if (!body.length) return null;
  } else {
    body = image;
  }
  // Fresh path each save → URL changes → the CDN can't serve a stale cached
  // avatar after an update.
  const path = `${userId}/${Date.now()}.jpg`;
  const { error } = await supabase.storage
    .from("avatars")
    .upload(path, body, {
      contentType: typeof image === "string" ? "image/jpeg" : image.type || "image/jpeg",
      upsert: true,
    });
  if (error) throw new Error(error.message);
  const { data } = supabase.storage.from("avatars").getPublicUrl(path);
  return data.publicUrl ?? null;
}

export async function updateProfile(input: ProfileUpdate): Promise<ProfileResult> {
  if (!isSupabaseConfigured) return { ok: false, error: "not_configured" };

  try {
    const { data: userData } = await supabase.auth.getUser();
    const user = userData?.user ?? null;
    if (!user) return { ok: false, error: "not_signed_in" };

    let avatarUrl: string | null =
      (user.user_metadata?.avatar_url as string) ||
      (user.user_metadata?.picture as string) ||
      null;

    const image: File | string | null = input.avatarFile ?? (input.avatarBase64 || null);
    if (image) {
      avatarUrl = await uploadAvatar(image, user.id);
    }

    const name = input.name.trim();
    const bio = input.bio.trim();

    const { error } = await supabase.auth.updateUser({
      data: {
        full_name: name,
        name, // keep both keys in sync (screen falls back to `name`)
        bio,
        ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
      },
    });
    if (error) return { ok: false, error: error.message };

    return { ok: true, avatarUrl };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "failed" };
  }
}
