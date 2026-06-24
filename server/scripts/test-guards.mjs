// Verify the critical reply-path fixes: one-click unsubscribe + once-per-lead loop guard.
import { db } from "../src/db.js";
import { smtpInboxes } from "../src/smtp.js";
import { handleReply, bindReplyLogger, isSuppressed } from "../src/replies.js";

bindReplyLogger((e) => console.log(`   · ${e.message}`));
const inbox = smtpInboxes()[0];

function plant(email) {
  db.prepare("DELETE FROM emails WHERE lead_id IN (SELECT id FROM leads WHERE email=?)").run(email);
  db.prepare("DELETE FROM leads WHERE email=?").run(email);
  db.prepare("DELETE FROM suppressions WHERE email=?").run(email);
  const i = db.prepare("INSERT INTO leads (business_name,email,email_status,status,inbox_used,followup_due_at) VALUES (?,?,'valid','emailed',?,datetime('now','+3 days'))").run("Guard Test Biz", email, inbox);
  return Number(i.lastInsertRowid);
}
const out = (id) => db.prepare("SELECT COUNT(*) c FROM emails WHERE lead_id=? AND direction='out' AND kind='reply'").get(id).c;
const status = (id) => db.prepare("SELECT status FROM leads WHERE id=?").get(id).status;

// ── TEST A: one-click unsubscribe (subject 'unsubscribe', empty body) ──────────
const a = "unsub@guard-test.example";
const idA = plant(a);
await handleReply(inbox, { id: "G-unsub", from: `X <${a}>`, subject: "unsubscribe", messageIdHeader: "<g1>", body: "" });
console.log(`\nTEST A — one-click unsubscribe:`);
console.log(`  status=${status(idA)} (want do_not_contact) | suppressed=${isSuppressed(a)} (want true) | auto-replies=${out(idA)} (want 0)`);
const passA = status(idA) === "do_not_contact" && isSuppressed(a) && out(idA) === 0;
console.log(`  ${passA ? "✅ PASS" : "❌ FAIL"}`);

// ── TEST B: once-per-lead loop guard (interested reply twice) ──────────────────
const b = "loop@guard-test.example";
const idB = plant(b);
await handleReply(inbox, { id: "G-1", from: `Y <${b}>`, subject: "Re: quick question", messageIdHeader: "<g2>", body: "yes interested send the video" });
const after1 = out(idB);
await handleReply(inbox, { id: "G-2", from: `Y <${b}>`, subject: "Re: quick question", messageIdHeader: "<g3>", body: "this is my out of office auto-reply, I am away until monday" });
const after2 = out(idB);
console.log(`\nTEST B — autoresponder loop guard:`);
console.log(`  auto-replies after 1st=${after1} (want 1), after 2nd=${after2} (want still 1)`);
const passB = after1 === 1 && after2 === 1;
console.log(`  ${passB ? "✅ PASS" : "❌ FAIL"}`);

// cleanup
for (const e of [a, b]) {
  db.prepare("DELETE FROM emails WHERE lead_id IN (SELECT id FROM leads WHERE email=?)").run(e);
  db.prepare("DELETE FROM leads WHERE email=?").run(e);
  db.prepare("DELETE FROM suppressions WHERE email=?").run(e);
}
console.log(`\ncleaned up ✓`);
console.log(passA && passB ? "\nALL GUARDS PASS ✅" : "\nSOME GUARDS FAILED ❌");
