// User issue-reports. A report is one row in the Supabase `reports` table; an
// optional screenshot is uploaded to the public `report-screenshots` bucket and
// its URL is stored on the row. View incoming reports in the Supabase dashboard
// (Table editor → reports). No server code needed — the client writes directly
// under RLS (insert-only for anon/authenticated).

import { supabase, isSupabaseConfigured } from "./supabase";
import { APP_VERSION } from "./appVersion";

export interface ReportInput {
  message: string;
  category?: string | null;
  email?: string | null;
  /** Screenshot picked from the desktop file picker. */
  screenshotFile?: File | null;
  /** Base64-encoded JPEG (no data: prefix; data: prefix tolerated). */
  screenshotBase64?: string | null;
}

export type ReportResult = { ok: true } | { ok: false; error: string };

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/^data:[^,]+,/, "").replace(/[^A-Za-z0-9+/=]/g, "");
  return Uint8Array.from(atob(clean), (c) => c.charCodeAt(0));
}

async function uploadScreenshot(
  file: File | null | undefined,
  base64: string | null | undefined,
  userId: string,
): Promise<string | null> {
  try {
    const bytes = !file && base64 ? base64ToBytes(base64) : null;
    if (!file && !bytes?.length) return null;
    const path = `${userId}/${Date.now()}.jpg`;
    const { error } = await supabase.storage
      .from("report-screenshots")
      .upload(path, file ?? bytes!, {
        contentType: file?.type || "image/jpeg",
        upsert: false,
      });
    if (error) return null;
    const { data } = supabase.storage.from("report-screenshots").getPublicUrl(path);
    return data.publicUrl ?? null;
  } catch {
    return null;
  }
}

export async function submitReport(input: ReportInput): Promise<ReportResult> {
  if (!isSupabaseConfigured) return { ok: false, error: "not_configured" };
  const message = (input.message || "").trim();
  if (!message) return { ok: false, error: "empty" };

  try {
    const { data: userData } = await supabase.auth.getUser();
    const user = userData?.user ?? null;

    const screenshot_url = await uploadScreenshot(
      input.screenshotFile,
      input.screenshotBase64,
      user?.id ?? "anon",
    );

    const { error } = await supabase.from("reports").insert({
      user_id: user?.id ?? null,
      email: (input.email || "").trim() || user?.email || null,
      category: input.category ?? null,
      message,
      screenshot_url,
      app_version: APP_VERSION,
      platform: "win32",
      device: navigator.platform || null,
      os_version: navigator.userAgent,
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "failed" };
  }
}
