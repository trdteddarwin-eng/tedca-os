// Send ONE real cold email to a mail-tester.com address, rendered through the
// LIVE engine path — same fillTemplate() (tokens + spintax), same compliance
// footer, same sendEmailSMTP() (plain text + List-Unsubscribe header).
//
// Unlike scripts/test-send.mjs this adds NO "[TEST]" subject prefix and leaves
// spintax resolved, because both would skew the SpamAssassin score. What
// mail-tester scores here is byte-for-byte what a real lead receives.
//
// Not written to the emails table and does not consume the daily cap.
//
// Usage: node server/scripts/mailtester-send.mjs <test-xxxx@srv1.mail-tester.com> [from@inbox]
import { db } from "../src/db.js";
import { sendEmailSMTP, smtpInboxes, smtpFirstName } from "../src/smtp.js";
import { fillTemplate } from "../src/engine.js";

const to = process.argv[2];
if (!to || !/(srv\d*\.mail-tester\.com|gmail\.com)$/i.test(to)) {
  console.error("usage: node server/scripts/mailtester-send.mjs <test-xxxx@srv1.mail-tester.com> [from@inbox]");
  process.exit(1);
}

const inboxes = smtpInboxes();
const from = process.argv[3] || inboxes[0];
if (!from) {
  console.error("No SMTP inboxes registered — run ingest-zapmail.mjs first.");
  process.exit(1);
}
if (!inboxes.includes(from)) {
  console.error(`${from} is not a registered SMTP inbox. Available:\n  ${inboxes.join("\n  ")}`);
  process.exit(1);
}

const get = (k) => db.prepare("SELECT value FROM settings WHERE key=?").get(k)?.value || "";

// A representative scraped lead, so every token fills the way it would live.
const lead = {
  business_name: "Bergen Glow Med Spa",
  ceo_name: "Jamie Whitfield",
  category: "med spa",
  city: "Miami",
  rating: 4.8,
  review_count: 212,
};

const sender = smtpFirstName(from) || "Ted";
const footer = get("compliance_footer");
const subject = fillTemplate(get("email_subject"), lead, sender);
const body = fillTemplate(get("email_body"), lead, sender) + (footer ? `\n\n${footer}` : "");

console.log(`sending  ${from}  →  ${to}\n`);
try {
  const r = await sendEmailSMTP({ from, to, subject, body });
  console.log("✓ accepted by SMTP — messageId:", r.id);
  console.log("\n--- exactly what mail-tester will score ---");
  console.log("From:", `"${sender}" <${from}>`);
  console.log("Subject:", subject);
  console.log("\n" + body);
} catch (e) {
  console.error("✗ send failed:", e.message);
  process.exit(1);
}
