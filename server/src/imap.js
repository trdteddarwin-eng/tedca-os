// IMAP reply reader for Zapmail (app-password) inboxes. The Gmail-API inboxes
// read replies via gmail.js; these have no OAuth, so we pull recent INBOX
// messages over IMAP and hand them to the same Concierge (replies.js) in the
// SAME shape gmail.getMessage() returns: { id, from, subject, messageIdHeader, body }.
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { imapConfig } from "./smtp.js";

// Fetch recent INBOX messages (last `sinceDays`) for one Zapmail inbox.
export async function listImapReplies(email, sinceDays = 3) {
  const cfg = imapConfig(email);
  if (!cfg) throw new Error(`${email} is not a registered SMTP/IMAP inbox`);

  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: true,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
    emitLogs: false,
    // timeouts so one dead/hung inbox can't freeze the whole reply poll
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 60000,
  });

  const out = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const since = new Date(Date.now() - sinceDays * 86400000);
      let uids = [];
      try {
        uids = await client.search({ since }, { uid: true });
      } catch {
        uids = [];
      }
      if (!uids) uids = [];
      // cap at the 20 most recent so a busy mailbox can't stall the loop
      for (const uid of uids.slice(-20)) {
        const msg = await client.fetchOne(uid, { source: true }, { uid: true });
        if (!msg || !msg.source) continue;
        const p = await simpleParser(msg.source);
        out.push({
          // prefer the global Message-ID for dedupe — survives IMAP UIDVALIDITY resets
          id: p.messageId ? `mid:${p.messageId}` : `${email}:${uid}`,
          from: p.from?.text || "",
          subject: p.subject || "",
          messageIdHeader: p.messageId || null,
          body: (p.text || p.html || "").toString().slice(0, 4000),
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    try {
      await client.logout();
    } catch {
      /* already closed */
    }
  }
  return out;
}
