// Private attachment storage in Cloudflare R2 (binding MAIL_ATTACHMENTS,
// shared by the Pages project and the mail worker). R2 objects are private
// by default -- this module never generates a public bucket URL; the only
// way to read an object back should be an authenticated, access-checked
// route in your own app (see docs/architecture.md's "Routes" section).
//
// Deliberately R2, not a public-URL file host (Cloudinary and similar):
// mail attachments should never get a permanent public URL, so every byte
// has to go through your app's own auth + per-mailbox access check.

export function attachmentKey(accountId: string, ownerId: string, attachmentId: string): string {
  return `att/${accountId}/${ownerId}/${attachmentId}`;
}

export function rawEmailKey(accountId: string, id: string, failed = false): string {
  const d = new Date();
  const ym = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  return `${failed ? "failed" : "raw"}/${accountId || "unrouted"}/${ym}/${id}.eml`;
}

/**
 * Deletes R2 objects whose key is no longer referenced by any
 * mail_attachments row (forwarding shares a storage_key between rows).
 * Call AFTER the referencing rows were deleted.
 */
export async function deleteUnreferencedObjects(db: D1Database, bucket: R2Bucket | undefined, keys: string[]): Promise<void> {
  if (!bucket) return;
  for (const key of new Set(keys)) {
    try {
      const still = await db.prepare(`SELECT 1 AS x FROM mail_attachments WHERE storage_key = ? LIMIT 1`).bind(key).first();
      if (!still) await bucket.delete(key);
    } catch (err) {
      console.error("attachment object cleanup failed", err instanceof Error ? err.message : err);
    }
  }
}

/** Filenames are display data and Content-Disposition input: strip path parts and control chars. */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>|*?:]/g, "_").replace(/^\.+/, "").trim();
  return (cleaned || "attachment").slice(0, 180);
}

// Types the attachment preview route will render inline. Everything else
// (HTML, SVG, scripts, office files, archives, executables) is
// download-only, served as an attachment with nosniff.
const PREVIEWABLE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain", "text/csv"]);

export function isPreviewable(mimeType: string): boolean {
  return PREVIEWABLE.has(mimeType.toLowerCase());
}

// Upload validation: refuse obviously executable payloads outright.
const BLOCKED_EXTENSIONS = new Set([
  "exe", "msi", "bat", "cmd", "com", "scr", "pif", "vbs", "vbe", "js", "jse", "wsf", "wsh", "ps1", "jar", "apk", "app", "dmg", "hta", "cpl", "lnk", "reg", "iso",
]);

export function isBlockedFilename(name: string): boolean {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return BLOCKED_EXTENSIONS.has(ext);
}

export function normalizeMimeType(value: string | null | undefined): string {
  const t = (value ?? "").split(";")[0]!.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(t) ? t : "application/octet-stream";
}
