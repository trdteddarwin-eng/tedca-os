#!/usr/bin/env node
// 30-minute cold-email status to Telegram, with the REAL copy that went out.
//
// Shows the last actually-sent email (spintax already resolved, real business
// name) rather than the template — the template tells you what COULD go out,
// this tells you what DID. Read-only against the DB; sends nothing but Telegram.
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { sendTelegram } from "./src/telegram.js";

const db = new DatabaseSync(path.join(import.meta.dirname, "data/tedca-os.db"), { readOnly: true });
const one = (sql, ...a) => db.prepare(sql).get(...a);
const all = (sql, ...a) => db.prepare(sql).all(...a);

const et = new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", weekday: "short" });
const run = one("SELECT id,status,started_at,summary FROM runs ORDER BY id DESC LIMIT 1") || {};
const sent = all("SELECT kind,COUNT(*) c FROM emails WHERE direction='out' AND sent_at>=date('now') GROUP BY kind");
const initial = sent.find((r) => r.kind === "initial")?.c || 0;
const follow = sent.find((r) => r.kind === "followup")?.c || 0;
const last30 = one("SELECT COUNT(*) c FROM emails WHERE direction='out' AND sent_at>=datetime('now','-30 minutes')").c;
const replies = one("SELECT COUNT(*) c FROM emails WHERE direction='in' AND sent_at>=date('now')").c;
const bounced = one("SELECT COUNT(*) c FROM leads WHERE status='bounced' AND last_touch_at>=date('now')").c;
const fails = one("SELECT COUNT(*) c FROM activity_events WHERE ts>=date('now') AND message LIKE '%did not go through%'").c;
const ready = one("SELECT COUNT(*) c FROM leads WHERE status='scraped' AND email_status='valid' AND email IS NOT NULL").c;
const byInbox = all(
  "SELECT substr(inbox,1,instr(inbox,'@')-1) n, COUNT(*) c FROM emails WHERE direction='out' AND sent_at>=date('now') GROUP BY inbox ORDER BY c DESC"
).map((r) => `${r.n} ${r.c}`).join(" · ");

let credits = "?";
try {
  const { fetchCredits } = await import("./src/keys.js");
  const c = await fetchCredits("anymailfinder");
  if (c && c.remaining != null) credits = `${c.remaining} (~${Math.floor(c.remaining / 2)} lookups)`;
} catch { /* leave as ? */ }

// the most recent email that actually went out, exactly as the owner received it
const lastMail = one(
  "SELECT e.subject, e.body, e.inbox, e.kind, e.sent_at, l.business_name, l.email FROM emails e LEFT JOIN leads l ON l.id=e.lead_id WHERE e.direction='out' AND e.kind IN ('initial','followup') ORDER BY e.id DESC LIMIT 1"
);

const lines = [
  `📬 COLD EMAIL — ${et} ET`,
  ``,
  `run #${run.id} · ${run.status}`,
  `sent today: ${initial} initial · ${follow} follow-up`,
  `last 30 min: ${last30}`,
  `replies: ${replies} · bounced: ${bounced} · send fails: ${fails}`,
  `ready leads: ${ready} · AMF credits: ${credits}`,
  byInbox ? `inboxes: ${byInbox}` : `inboxes: none yet`,
];

if (lastMail) {
  lines.push(
    ``,
    `━━━ LAST ${lastMail.kind.toUpperCase()} SENT ━━━`,
    `to: ${lastMail.business_name || "?"} <${lastMail.email || "?"}>`,
    `from: ${lastMail.inbox}`,
    ``,
    `Subject: ${lastMail.subject}`,
    ``,
    String(lastMail.body || "").slice(0, 1600)
  );
}

const ok = await sendTelegram(lines.join("\n"));
console.log(ok ? "sent to telegram" : "TELEGRAM SEND FAILED (check TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)");
