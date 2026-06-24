// Connectivity test: log into every Zapmail inbox over IMAP and confirm we can
// read the mailbox. This is the "reading" counterpart to test-send.mjs.
// Usage: node server/scripts/test-imap.mjs
import { smtpInboxes } from "../src/smtp.js";
import { listImapReplies } from "../src/imap.js";

const inboxes = smtpInboxes();
if (!inboxes.length) {
  console.error("No SMTP inboxes registered — run ingest-zapmail.mjs first.");
  process.exit(1);
}

let ok = 0;
for (const email of inboxes) {
  try {
    const msgs = await listImapReplies(email, 3);
    console.log(`✓ ${email.padEnd(34)} IMAP read OK — ${msgs.length} recent msg(s) in INBOX`);
    ok++;
  } catch (e) {
    console.log(`✗ ${email.padEnd(34)} IMAP FAILED — ${e.message}`);
  }
}
console.log(`\n${ok}/${inboxes.length} inboxes readable over IMAP`);
process.exit(ok === inboxes.length ? 0 : 1);
