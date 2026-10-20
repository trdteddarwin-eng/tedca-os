// Verify the lead-queue behaviours that a zero-send day depends on.
// Plants throwaway rows, asserts, cleans up. Sends nothing, spends no credits.
//   node --env-file=../.env scripts/test-queue.mjs
import { db } from "../src/db.js";
import { queuePick, queueCounts, blockedEmailDomain, batchTemplates, fillTemplate, queueRunway, verifyLead } from "../src/engine.js";

const TAG = "ZZTEST-queue";
let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "✅" : "❌"} ${name}: got ${JSON.stringify(got)}${ok ? "" : `, want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

function cleanup() {
  db.prepare("DELETE FROM leads WHERE business_name LIKE ?").run(`${TAG}%`);
  db.prepare("DELETE FROM lead_batches WHERE name LIKE ?").run(`${TAG}%`);
}
cleanup();

// ── plant: one active batch (priority 5) and one paused batch (priority 1) ────
const mkBatch = (name, status, priority, subject = null, body = null) =>
  Number(db.prepare("INSERT INTO lead_batches (name, source, status, priority, template_subject, template_body, row_count) VALUES (?, 'csv', ?, ?, ?, ?, 1)")
    .run(name, status, priority, subject, body).lastInsertRowid);
const mkLead = (name, batchId, emailStatus, email = null, supplied = 0) =>
  Number(db.prepare("INSERT INTO leads (business_name, email, email_status, status, banked, batch_id, supplied_email, scraped_at) VALUES (?, ?, ?, 'scraped', 0, ?, ?, datetime('now'))")
    .run(name, email, emailStatus, batchId, supplied).lastInsertRowid);

const activeB = mkBatch(`${TAG} active`, "active", 5, "{business_name} — batch subject", "batch body for {first_name}");
const pausedB = mkBatch(`${TAG} paused`, "paused", 1);

const before = queueCounts();
const lActive = mkLead(`${TAG} A`, activeB, null);
const lPaused = mkLead(`${TAG} P`, pausedB, null);
const lDeadSupplied = mkLead(`${TAG} D`, activeB, "invalid", "nope@example.com", 1);
const lReady = mkLead(`${TAG} R`, activeB, "valid", "someone@zztest.invalid", 1); // .invalid: unroutable, so even a leaked row cannot be emailed
// supplied address on an unresolvable host → the provider call throws → "error"
const lTransient = mkLead(`${TAG} T`, activeB, null, "someone@zztest.invalid", 1);

try {
console.log("\nTEST 1 — a paused batch is held out of the queue");
const picked = queuePick(50).map(Number);
check("active batch lead is queued", picked.includes(lActive), true);
check("paused batch lead is NOT queued", picked.includes(lPaused), false);

console.log("\nTEST 2 — a lead that already failed verification is never re-picked");
check("invalid supplied lead is NOT queued", picked.includes(lDeadSupplied), false);
check("valid lead IS queued", picked.includes(lReady), true);

console.log("\nTEST 3 — counts only include alive rows (the old bank number counted corpses)");
const after = queueCounts();
check("ready +1", after.ready - before.ready, 1);
check("pending +2 (paused batch excluded)", after.pending - before.pending, 2);

console.log("\nTEST 4 — a ready lead sorts ahead of an unverified one");
check("ready before pending", picked.indexOf(lReady) < picked.indexOf(lActive), true);

console.log("\nTEST 5 — send gate: free-mail allowed only for a SUPPLIED address");
check("found gmail blocked", blockedEmailDomain("owner@gmail.com"), true);
check("supplied gmail allowed", blockedEmailDomain("owner@gmail.com", { allowFreeMail: true }), false);
check("platform blocked even when supplied", blockedEmailDomain("sundar@google.com", { allowFreeMail: true }), true);
check("normal business domain fine", blockedEmailDomain("dr@smiledental.com"), false);

console.log("\nTEST 6 — per-batch copy override");
const t = batchTemplates(activeB);
check("batch subject used", t.subject, "{business_name} — batch subject");
const rendered = fillTemplate(t.body, { business_name: "Smile Dental", ceo_name: "Ana Reyes" }, "Ted");
check("batch body renders", rendered, "batch body for Ana");
check("no override → falls back to settings", batchTemplates(pausedB), { subject: null, body: null });

console.log("\nTEST 7 — runway is a number, not a lie");
const r = queueRunway();
check("days is finite", Number.isFinite(r.days), true);
check("perDay never exceeds daily_target", r.perDay <= Number(db.prepare("SELECT value FROM settings WHERE key='daily_target'").get().value), true);

console.log("\nTEST 8 — a transient provider failure must NEVER stamp a lead dead");
// The 2026-08-26 incident: a network blip stamped 232 leads email_status='unknown'
// and removed them from every future pool. A 429 (rate limit) or a 401 (expired key)
// is US failing, not a verdict on the address — verifyLead must return "error" and
// leave the row untouched. Simulated by intercepting fetch, so no credit is spent.
const realFetch = globalThis.fetch;
for (const [label, status] of [["429 rate limit", 429], ["401 expired key", 401], ["500 provider down", 500]]) {
  db.prepare("UPDATE leads SET status='scraped', email_status=NULL WHERE id=?").run(lTransient);
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "simulated" }), { status, headers: { "Content-Type": "application/json" } });
  let verdict;
  try { verdict = await verifyLead(lTransient, () => {}); } finally { globalThis.fetch = realFetch; }
  const row = db.prepare("SELECT status, email_status FROM leads WHERE id=?").get(lTransient);
  check(`${label} → "error"`, verdict, "error");
  check(`${label} → row untouched`, { s: row.status, e: row.email_status }, { s: "scraped", e: null });
  check(`${label} → still queued`, queuePick(200).map(Number).includes(lTransient), true);
}

console.log("\nTEST 9 — a real verdict about the address IS recorded");
db.prepare("UPDATE leads SET status='scraped', email_status=NULL WHERE id=?").run(lTransient);
globalThis.fetch = async () => new Response(JSON.stringify({ email_status: "invalid", credits_charged: 0.2 }), { status: 200, headers: { "Content-Type": "application/json" } });
let v9; try { v9 = await verifyLead(lTransient, () => {}); } finally { globalThis.fetch = realFetch; }
const row9 = db.prepare("SELECT status, email_status FROM leads WHERE id=?").get(lTransient);
check("invalid verdict returns false", v9, false);
check("invalid verdict is stamped", { s: row9.status, e: row9.email_status }, { s: "skipped", e: "invalid" });
check("stamped lead leaves the queue", queuePick(200).map(Number).includes(lTransient), false);

} finally {
  cleanup(); // must run even if an assertion throws — these rows sit in the LIVE queue
}
console.log(`\n${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
