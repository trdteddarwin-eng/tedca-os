// M7: reply handling — Concierge. Polls every inbox for replies from leads,
// stops follow-ups instantly, classifies, and branches:
//   interested/neutral → short tailored reply + patient-engine link, Telegram ping
//   negative           → flag to the user on Telegram, NO link, no more emails
//   unsubscribe        → permanent do-not-contact, no reply ever
import { db } from "./db.js";
import { authorizedInboxes, listInboxMessages, getMessage, sendEmail } from "./gmail.js";
import { sendTelegram } from "./telegram.js";

const OPENROUTER = "https://openrouter.ai/api/v1/chat/completions";
const PATIENT_ENGINE_URL = process.env.PATIENT_ENGINE_URL || "https://tedca-patient-engine.vercel.app";

let logEvent = () => {};
export function bindReplyLogger(fn) {
  logEvent = fn;
}

db.exec(`CREATE TABLE IF NOT EXISTS seen_messages (id TEXT PRIMARY KEY, inbox TEXT, ts TEXT DEFAULT (datetime('now')))`);
try {
  db.exec("ALTER TABLE emails ADD COLUMN gmail_id TEXT");
} catch {
  /* exists */
}

function extractEmail(fromHeader) {
  const m = fromHeader.match(/<([^>]+)>/);
  return (m ? m[1] : fromHeader).trim().toLowerCase();
}

// test mode sends carry the real lead address in the subject: [TEST → lead@x]
function leadFromMessage(fromEmail, subject) {
  const direct = db.prepare("SELECT * FROM leads WHERE lower(email)=?").get(fromEmail);
  if (direct) return direct;
  const m = subject.match(/\[TEST → ([^\]]+)\]/);
  if (m) return db.prepare("SELECT * FROM leads WHERE lower(email)=?").get(m[1].trim().toLowerCase());
  return null;
}

async function classify(replyText, businessName) {
  const key = process.env.OPENROUTER_API_KEY || "";
  const res = await fetch(OPENROUTER, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "anthropic/claude-haiku-4-5",
      max_tokens: 10,
      messages: [
        {
          role: "user",
          content: `A cold email was sent to ${businessName} about a missed-call text-back service. They replied:\n"""${replyText.slice(0, 1500)}"""\nClassify the reply. Answer with EXACTLY one word:\ninterested (wants info/video/call, asks questions, positive)\nneutral (lukewarm, maybe later, short non-negative)\nnegative (annoyed, not interested, but not demanding removal)\nunsubscribe (asks to stop emailing, remove from list, "stop", legal threats)`,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`classify failed: ${res.status}`);
  const data = await res.json();
  const word = (data.choices?.[0]?.message?.content || "").trim().toLowerCase();
  return ["interested", "neutral", "negative", "unsubscribe"].includes(word) ? word : "neutral";
}

async function tailoredReply(replyText, lead) {
  const key = process.env.OPENROUTER_API_KEY || "";
  const res = await fetch(OPENROUTER, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "anthropic/claude-sonnet-4.5",
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: `You are Ted from tedca.org replying to a business owner's reply to your cold email about a missed-call text-back system. Their business: ${lead.business_name}. Their reply:\n"""${replyText.slice(0, 1200)}"""\nWrite a SHORT reply (under 60 words, all lowercase, casual, human, no em dashes). Answer their question if any, then point them to the system already built for them: ${PATIENT_ENGINE_URL} . Sign "ted". Output only the email body.`,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`reply draft failed: ${res.status}`);
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || "").trim();
}

async function handleReply(inbox, msg) {
  const fromEmail = extractEmail(msg.from);
  // ignore our own inboxes talking to each other
  const ours = authorizedInboxes().map((i) => i.email.toLowerCase());
  if (ours.includes(fromEmail)) return;

  const lead = leadFromMessage(fromEmail, msg.subject);
  if (!lead) return; // unrelated mail — leave it alone

  const testMode = db.prepare("SELECT value FROM settings WHERE key='test_mode'").get()?.value === "1";

  // 1. record it + kill all future follow-ups for this lead
  db.prepare(
    "INSERT INTO emails (lead_id, inbox, direction, subject, body, kind, sent_at, gmail_id) VALUES (?, ?, 'in', ?, ?, 'reply', datetime('now'), ?)"
  ).run(lead.id, inbox, msg.subject, msg.body, msg.id);
  db.prepare("UPDATE leads SET status='replied', followup_due_at=NULL, last_touch_at=datetime('now') WHERE id=?").run(lead.id);
  logEvent({ actor: "reply", message: `${lead.business_name} replied! Follow-ups stopped. Reading what they said…`, level: "success" });

  // 2. classify and branch
  let verdict = "neutral";
  try {
    verdict = await classify(msg.body, lead.business_name);
  } catch (e) {
    logEvent({ actor: "reply", message: `Could not auto-read the reply (${e.message}) — flagging it to you instead.`, level: "warn" });
    await sendTelegram(`📨 ${lead.business_name} replied but I couldn't classify it. Check the CRM.\n\n"${msg.body.slice(0, 300)}"`);
    return;
  }

  if (verdict === "unsubscribe") {
    db.prepare("UPDATE leads SET status='do_not_contact' WHERE id=?").run(lead.id);
    logEvent({ actor: "reply", message: `${lead.business_name} asked to stop. Marked do-not-contact forever. No reply sent.`, level: "warn" });
    await sendTelegram(`🛑 ${lead.business_name} asked to stop emailing. Suppressed permanently.`);
    return;
  }

  if (verdict === "negative") {
    logEvent({ actor: "reply", message: `${lead.business_name} replied negative. Flagged to you on Telegram — your call, no auto-reply sent.`, level: "warn" });
    await sendTelegram(`⚠️ Negative reply from ${lead.business_name} (${lead.email}):\n\n"${msg.body.slice(0, 400)}"\n\nNo link sent, follow-ups stopped. You decide.`);
    return;
  }

  // interested / neutral → tailored answer + the link
  try {
    const replyBody = await tailoredReply(msg.body, lead);
    const to = testMode ? process.env.TEST_RECIPIENT : lead.email;
    await sendEmail({
      from: inbox,
      to,
      subject: msg.subject.startsWith("Re:") ? msg.subject : `Re: ${msg.subject}`,
      body: replyBody,
      inReplyTo: msg.messageIdHeader,
    });
    db.prepare(
      "INSERT INTO emails (lead_id, inbox, direction, subject, body, kind, sent_at) VALUES (?, ?, 'out', ?, ?, 'reply', datetime('now'))"
    ).run(lead.id, inbox, `Re: ${msg.subject}`, replyBody);
    logEvent({ actor: "reply", message: `Replied to ${lead.business_name} with the patient-engine link${testMode ? " (test copy to you)" : ""}.`, level: "success" });
    await sendTelegram(`🎉 ${verdict === "interested" ? "INTERESTED" : "Reply"} — ${lead.business_name} (${lead.email}):\n\n"${msg.body.slice(0, 300)}"\n\nI answered and sent the link.`);
  } catch (e) {
    logEvent({ actor: "reply", message: `Drafted a reply for ${lead.business_name} but sending failed: ${e.message}`, level: "error" });
    await sendTelegram(`📨 ${lead.business_name} replied (${verdict}) but my auto-reply failed: ${e.message}. Check the CRM.`);
  }
}

async function pollOnce() {
  const inboxes = authorizedInboxes().filter((i) => i.authorized);
  for (const { email } of inboxes) {
    try {
      const msgs = await listInboxMessages(email, "in:inbox newer_than:3d");
      for (const { id } of msgs) {
        if (db.prepare("SELECT 1 FROM seen_messages WHERE id=?").get(id)) continue;
        db.prepare("INSERT OR IGNORE INTO seen_messages (id, inbox) VALUES (?, ?)").run(id, email);
        const msg = await getMessage(email, id);
        await handleReply(email, msg);
      }
    } catch (e) {
      logEvent({ actor: "reply", message: `Checking ${email} for replies failed: ${e.message}`, level: "warn" });
    }
  }
}

export function startReplyLoop() {
  // first pass shortly after boot, then every 2 minutes
  setTimeout(() => pollOnce().catch(() => {}), 10_000);
  setInterval(() => pollOnce().catch(() => {}), 120_000);
}
