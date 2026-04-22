// Supabase Storage plumbing for draft attachments. The bucket is private;
// all access is gated through authenticated backend routes.
import { supabaseAdmin } from "./supabase.js";

export const ATT_BUCKET = "convotrail-attachments";
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MB / file, matches most SMTP caps

let bucketReady = false;
// Idempotent first-run bucket creation. Runs on the first attachment upload
// so we don't reach out to Supabase during normal traffic.
export async function ensureAttachmentsBucket(): Promise<void> {
  if (bucketReady || !supabaseAdmin) return;
  const { data, error } = await supabaseAdmin.storage.listBuckets();
  if (error) throw new Error(`listBuckets: ${error.message}`);
  if (!data?.some(b => b.name === ATT_BUCKET)) {
    const r = await supabaseAdmin.storage.createBucket(ATT_BUCKET, {
      public: false,
      fileSizeLimit: MAX_ATTACHMENT_BYTES,
    });
    if (r.error) throw new Error(`createBucket: ${r.error.message}`);
  }
  bucketReady = true;
}

export async function uploadAttachment(
  key: string,
  body: Buffer,
  contentType: string | undefined,
): Promise<void> {
  if (!supabaseAdmin) throw new Error("admin key not configured");
  await ensureAttachmentsBucket();
  const r = await supabaseAdmin.storage.from(ATT_BUCKET).upload(key, body, {
    contentType: contentType || "application/octet-stream",
    upsert: false,
  });
  if (r.error) throw new Error(`upload: ${r.error.message}`);
}

export async function downloadAttachmentBytes(key: string): Promise<Buffer> {
  if (!supabaseAdmin) throw new Error("admin key not configured");
  const r = await supabaseAdmin.storage.from(ATT_BUCKET).download(key);
  if (r.error) throw new Error(`download: ${r.error.message}`);
  return Buffer.from(await r.data.arrayBuffer());
}

export async function deleteAttachments(keys: string[]): Promise<void> {
  if (!supabaseAdmin || keys.length === 0) return;
  const r = await supabaseAdmin.storage.from(ATT_BUCKET).remove(keys);
  if (r.error) throw new Error(`remove: ${r.error.message}`);
}
