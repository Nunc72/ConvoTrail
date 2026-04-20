import { ImapFlow } from "imapflow";

export interface ImapTestResult {
  ok: boolean;
  error?: string;
  mailboxCount?: number;
  serverGreeting?: string;
}

export async function testImapConnection(params: {
  host: string;
  port: number;
  secure?: boolean;
  user: string;
  pass: string;
}): Promise<ImapTestResult> {
  const client = new ImapFlow({
    host: params.host,
    port: params.port,
    secure: params.secure ?? true,
    auth: { user: params.user, pass: params.pass },
    logger: false,
    socketTimeout: 10_000,
  });

  try {
    await client.connect();
    const boxes = await client.list();
    await client.logout();
    return { ok: true, mailboxCount: boxes.length };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    try { await client.logout(); } catch {}
    return { ok: false, error: msg };
  }
}
