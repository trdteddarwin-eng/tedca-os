// End-to-end test of the auto-reply Concierge WITHOUT needing real inbound mail.
// Inserts a throwaway lead in 'emailed' state, simulates that lead sending an
// interested reply, runs the real handleReply() (live AI classify + real SMTP
// auto-reply), prints the resulting state, then deletes the throwaway data.
//
// In test mode the auto-reply is delivered to TEST_RECIPIENT, so you SEE exactly
// what the system wrote back.
//
// Run with env loaded (needs OPENROUTER_API_KEY + TEST_RECIPIENT):
//   node --env-file-if-exists=../../.env --env-file=../.env scripts/test-autoreply.mjs
import { db } from "../src/db.js";
import { smtpInboxes } from "../src/smtp.js";
import { handleReply, bindReplyLogger } from "../src/replies.js";

bindReplyLogger((e) => console.log(`   · [${e.level}] ${e.actor}: ${e.message}`));

const inbox = smtpInboxes()[0];
if (!inbox) {
  console.error("No SMTP inboxes registered.");
  process.exit(1);
}

const fakeEmail = "owner@fake-medspa-test.example";
const testMode = db.prepare("SELECT value FROM settings WHERE key='test_mode'").get()?.value === "1";

// 1. plant a throwaway lead that has already been emailed from this inbox
db.prepare("DELETE FROM leads WHERE email=?").run(fakeEmail);
const info = db
  .prepare(
    `INSERT INTO leads (business_name, email, email_status, status, inbox_used, last_touch_at, followup_due_at)
     VALUES (?, ?, 'valid', 'emailed', ?, datetime('now'), datetime('now','+3 days'))`
  )
  .run("Fake Test Med Spa", fakeEmail, inbox);
const leadId = Number(info.lastInsertRowid);
console.log(`Planted lead #${leadId} <${fakeEmail}> as 'emailed' via ${inbox}`);
console.log(`test_mode = ${testMode ? "ON (auto-reply → TEST_RECIPIENT)" : "OFF (would go to the lead!)"}\n`);

// 2. simulate the lead replying with an interested message
const msg = {
  id: `TEST-AUTOREPLY:${leadId}`,
  from: `Jamie Owner <${fakeEmail}>`,
  subject: "Re: quick question about Fake Test Med Spa",
  messageIdHeader: "<test-reply-thread@fake-medspa-test.example>",
  body: "hey yeah this is actually interesting, we definitely miss calls when we're with clients. can you send that 90 second video?",
};
console.log("Simulating inbound reply → running the Concierge (handleReply)…\n");
await handleReply(inbox, msg);

// 3. inspect what happened
const lead = db.prepare("SELECT status, followup_due_at FROM leads WHERE id=?").get(leadId);
const emails = db
  .prepare("SELECT direction, kind, inbox, substr(replace(body,char(10),' '),1,90) b FROM emails WHERE lead_id=? ORDER BY id")
  .all(leadId);
console.log("\n--- RESULT ---");
console.log(`lead.status      → ${lead.status}   (expected: replied)`);
console.log(`followup_due_at  → ${lead.followup_due_at}   (expected: null = follow-ups stopped)`);
console.log("email trail:");
for (const e of emails) console.log(`   ${e.direction}/${e.kind} via ${e.inbox}: ${e.b}`);

// 4. clean up so the CRM stays pristine
db.prepare("DELETE FROM emails WHERE lead_id=?").run(leadId);
db.prepare("DELETE FROM leads WHERE id=?").run(leadId);
db.prepare("DELETE FROM seen_messages WHERE id=?").run(msg.id);
console.log("\nCleaned up throwaway test data ✓");
