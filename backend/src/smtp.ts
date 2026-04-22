// SMTP send + IMAP APPEND to Sent folder.
// MIME is built once (MailComposer), sent raw via SMTP, then appended
// to the Sent folder so the user's own Sent mailbox stays consistent.
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type Mail from "nodemailer/lib/mailer/index.js";
import { ImapFlow } from "imapflow";

export interface SendInput {
  smtp: { host: string; port: number; user: string; pass: string };
  imap: { host: string; port: number; user: string; pass: string };
  fromEmail: string;
  fromName?: string | null;
  to: string;            // single or comma-separated addresses
  cc?: string;
  bcc?: string;
  subject: string;
  text: string;
  inReplyTo?: string | null;   // RFC822 Message-ID of original, e.g. "<abc@example.com>"
  references?: string | null;
  sentFolder?: string;
  attachments?: Array<{ filename: string; content: Buffer; contentType?: string }>;
}

export interface SendResult {
  ok: boolean;
  messageId?: string;
  appended?: { folder: string; uid: number; uidValidity: number } | null;
  warning?: string;
  error?: string;
}

function splitAddresses(s: string | undefined): string[] {
  if (!s) return [];
  return s.split(/[,;]/).map(x => x.trim()).filter(Boolean);
}

async function buildMime(opts: Mail.Options): Promise<{ raw: Buffer; messageId: string }> {
  const composer = new MailComposer(opts);
  const raw: Buffer = await new Promise((resolve, reject) => {
    composer.compile().build((err, msg) => {
      if (err) reject(err);
      else resolve(msg);
    });
  });
  // Extract Message-ID from the raw header block
  const headEnd = raw.indexOf("\r\n\r\n");
  const headers = raw.toString("utf8", 0, headEnd > 0 ? headEnd : Math.min(raw.length, 8192));
  const m = headers.match(/^Message-ID:\s*(.+)$/im);
  const messageId = m ? m[1].trim() : "";
  return { raw, messageId };
}

export async function sendMail(input: SendInput): Promise<SendResult> {
  // 1. Build MIME
  const fromHeader = input.fromName ? `"${input.fromName.replace(/"/g, "'")}" <${input.fromEmail}>` : input.fromEmail;
  const mailOpts: Mail.Options = {
    from: fromHeader,
    to: input.to,
    cc: input.cc || undefined,
    bcc: input.bcc || undefined,
    subject: input.subject,
    text: input.text,
  };
  if (input.inReplyTo) {
    mailOpts.inReplyTo = input.inReplyTo;
    mailOpts.references = input.references || input.inReplyTo;
  }
  if (input.attachments && input.attachments.length > 0) {
    mailOpts.attachments = input.attachments.map(a => ({
      filename: a.filename,
      content: a.content,
      contentType: a.contentType || "application/octet-stream",
    }));
  }

  let raw: Buffer, messageId: string;
  try {
    ({ raw, messageId } = await buildMime(mailOpts));
  } catch (e: unknown) {
    return { ok: false, error: `MIME build failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  // 2. Send via SMTP (raw)
  const smtp = nodemailer.createTransport({
    host: input.smtp.host,
    port: input.smtp.port,
    secure: input.smtp.port === 465,
    auth: { user: input.smtp.user, pass: input.smtp.pass },
    connectionTimeout: 15_000,
    socketTimeout: 30_000,
  });
  try {
    await smtp.sendMail({
      envelope: {
        from: input.fromEmail,
        to: [...splitAddresses(input.to), ...splitAddresses(input.cc), ...splitAddresses(input.bcc)],
      },
      raw,
    });
  } catch (e: unknown) {
    return { ok: false, error: `SMTP: ${e instanceof Error ? e.message : String(e)}` };
  }

  // 3. APPEND to Sent (best-effort; message is already delivered).
  //    Folder path must match what sync.ts uses (SPECIAL-USE \\Sent) so the
  //    row we insert here dedups against the same row when sync later runs.
  //    iCloud calls it "Sent Messages"; generic IMAP typically "Sent".
  const client = new ImapFlow({
    host: input.imap.host,
    port: input.imap.port,
    secure: true,
    auth: { user: input.imap.user, pass: input.imap.pass },
    logger: false,
    socketTimeout: 15_000,
  });
  try {
    await client.connect();
    let folder = input.sentFolder || "";
    if (!folder) {
      const list = await client.list();
      folder = list.find(m => m.specialUse === "\\Sent")?.path || "Sent";
    }
    const res = await client.append(folder, raw, ["\\Seen"]);
    await client.logout();
    if (res && typeof res.uid === "number" && typeof res.uidValidity !== "undefined") {
      return {
        ok: true, messageId,
        appended: { folder, uid: res.uid, uidValidity: Number(res.uidValidity) },
      };
    }
    // Server doesn't support UIDPLUS — skip DB insert; next sync will pick it up.
    return { ok: true, messageId, appended: null, warning: "Saved to Sent (no UIDPLUS — message will appear after next sync)" };
  } catch (e: unknown) {
    try { await client.logout(); } catch { /* ignore */ }
    return {
      ok: true, messageId, appended: null,
      warning: `Mail sent, but saving to Sent folder failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export { splitAddresses };
