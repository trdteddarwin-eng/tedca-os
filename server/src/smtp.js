// SMTP sender + inbox registry for Zapmail (app-password) inboxes.
// Mirrors the gmail.js sendEmail() interface so the engine can dispatch to
// either transport without caring which one an inbox uses.
//
// Credentials live in server/data/smtp_inboxes.json (chmod 600, gitignored) —
// provisioned from the Zapmail CSV export by scripts/ingest-zapmail.mjs.
// Passwords never touch source or env; they go CSV → JSON → here.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_PATH = path.join(
  process.env.DATA_DIR || path.join(__dirname, "..", "data"),
  "smtp_inboxes.json"
);

function load() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
  } catch {
    return {};
  }
}

// all Zapmail inbox addresses, lowercased
export function smtpInboxes() {
  return Object.keys(load());
}

export function isSmtpInbox(email) {
  return Boolean(load()[String(email).toLowerCase()]);
}

// IMAP connection config for an inbox (used by the reply reader). null if unknown.
export function imapConfig(email) {
  const rec = load()[String(email).toLowerCase()];
  if (!rec) return null;
  return {
    host: rec.imapHost || "imap.gmail.com",
    port: Number(rec.imapPort || 993),
    user: rec.imapUser || email,
    pass: String(rec.imapPass || "").replace(/\s+/g, ""),
  };
}

// one reusable transporter per inbox
const transporters = new Map();
function transporterFor(email, rec) {
  if (transporters.has(email)) return transporters.get(email);
  const port = Number(rec.smtpPort || 587);
  const t = nodemailer.createTransport({
    host: rec.smtpHost || "smtp.gmail.com",
    port,
    secure: port === 465, // 465 = implicit TLS, 587 = STARTTLS
    auth: { user: rec.smtpUser || email, pass: String(rec.smtpPass || "").replace(/\s+/g, "") },
  });
  transporters.set(email, t);
  return t;
}

// Same signature as gmail.js sendEmail({ from, to, subject, body, inReplyTo }).
export async function sendEmailSMTP({ from, to, subject, body, inReplyTo = null }) {
  const rec = load()[String(from).toLowerCase()];
  if (!rec) throw new Error(`${from} is not a registered SMTP inbox`);
  const headers = {};
  if (inReplyTo) {
    headers["In-Reply-To"] = inReplyTo;
    headers["References"] = inReplyTo;
  }
  // List-Unsubscribe: expected by Gmail/Yahoo bulk-sender rules — improves
  // inbox placement. Points at the sending inbox; the reply classifier already
  // honors an "unsubscribe" message and marks the lead do-not-contact.
  headers["List-Unsubscribe"] = `<mailto:${from}?subject=unsubscribe>`;
  const info = await transporterFor(from, rec).sendMail({
    from: rec.firstName ? `"${rec.firstName}" <${from}>` : from,
    to,
    subject,
    text: body,
    headers,
  });
  return { id: info.messageId };
}

// ── ramp: a fresh inbox climbs to full volume over its first week ───────────
// index = whole days since the inbox was activated (startedAt).
//   day 1–2 → 12   day 3–4 → 22   day 5–7 → 35   day 8+ → 50
const RAMP = [12, 12, 22, 22, 35, 35, 35, 50];
export function smtpInboxCap(email) {
  const rec = load()[String(email).toLowerCase()];
  if (!rec) return 0;
  const started = Date.parse(rec.startedAt || "") || Date.now();
  const days = Math.max(0, Math.floor((Date.now() - started) / 86400000));
  return RAMP[Math.min(days, RAMP.length - 1)];
}

// for the dashboard / status — never includes passwords
export function smtpInboxMeta() {
  return Object.entries(load()).map(([email, r]) => ({
    email,
    firstName: r.firstName || null,
    startedAt: r.startedAt || null,
    cap: smtpInboxCap(email),
  }));
}
