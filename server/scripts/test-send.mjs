// Fire ONE real SMTP email from the first Zapmail inbox to a test recipient,
// using the live subject/body templates + compliance footer — exactly what a
// lead would receive. Proves: app-password auth works, mail delivers, footer
// renders. Does NOT touch the scrape/verify pipeline and is NOT logged to the
// emails table, so it costs nothing and doesn't consume the daily cap.
//
// Usage: node server/scripts/test-send.mjs [recipient@example.com]
import { db } from "../src/db.js";
import { sendEmailSMTP, smtpInboxes } from "../src/smtp.js";

const to = process.argv[2] || "trdteddarwin@gmail.com";
const from = smtpInboxes()[0];
if (!from) {
  console.error("No SMTP inboxes registered — run ingest-zapmail.mjs first.");
  process.exit(1);
}

const get = (k) => db.prepare("SELECT value FROM settings WHERE key=?").get(k)?.value || "";

// representative fake lead so {tokens} fill in like a real send
const lead = { business_name: "Bergen Glow Med Spa", first: "Jamie", category: "med spa", rating: "4.8", review_count: "212" };
const fill = (t) =>
  t
    .replaceAll("{business_name}", lead.business_name)
    .replaceAll("{first_name}", lead.first)
    .replaceAll("{category}", lead.category)
    .replaceAll("{rating}", lead.rating)
    .replaceAll("{review_count}", lead.review_count);

const footer = get("compliance_footer");
const subject = "[TEST] " + fill(get("email_subject"));
const body = fill(get("email_body")) + (footer ? `\n\n${footer}` : "");

console.log(`sending test  ${from}  →  ${to}`);
try {
  const r = await sendEmailSMTP({ from, to, subject, body });
  console.log("✓ accepted by Gmail SMTP — messageId:", r.id);
  console.log("\n--- exactly what landed in the inbox ---");
  console.log("From:", from);
  console.log("Subject:", subject);
  console.log("\n" + body);
} catch (e) {
  console.error("✗ send failed:", e.message);
  process.exit(1);
}
