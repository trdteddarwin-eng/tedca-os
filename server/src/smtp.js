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

// cloud bootstrap: write the inbox store from a local export (mirrors gmail importTokens).
// Lets us push the 12 Zapmail credentials to the cloud volume over an authed HTTPS call.
export function importSmtpInboxes(obj) {
  const data = obj && typeof obj === "object" ? obj : {};
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.chmodSync(STORE_PATH, 0o600);
  transporters.clear(); // drop cached transporters so new creds take effect immediately
  return Object.keys(data).length;
}

export function isSmtpInbox(email) {
  return Boolean(load()[String(email).toLowerCase()]);
}

// the persona first name for an inbox (used to sign emails as the actual sender)
export function smtpFirstName(email) {
  return load()[String(email).toLowerCase()]?.firstName || null;
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


// ── optional HTML body ────────────────────────────────────────────────────
// Off by default, and that default is deliberate. These are plain-text emails
// because plain text reads as a person typing; a multipart/HTML cold email from
// a young domain is filtered harder, and the copy's whole premise is that it
// looks like a 1:1 note. Turning this on buys a smaller-looking footer and pays
// for it in inbox placement, so it is a setting Ted flips knowingly, not a
// default. The plain-text part is ALWAYS sent too, so a client that prefers
// text (or strips HTML) still gets a correct, compliant email.
//
// The footer stays clear and conspicuous: 11px on a 13px body is the same ratio
// every legitimate sender uses. It is de-emphasised, not concealed.
export function htmlBody(text, footer) {
  const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // split the compliance footer off the end so it can be styled separately
  // Only split when the text actually ENDS with the footer (campaign sends run
  // through withCompliance). Hot Leads manual replies do not, and appending the
  // footer to just the HTML part would ship a footer the text part lacks.
  const hasFooter = Boolean(footer) && text.endsWith(footer);
  const body = hasFooter ? text.slice(0, -footer.length).trimEnd() : text;
  return (
    '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Arial,sans-serif;' +
    'font-size:13px;line-height:1.5;color:#222;white-space:pre-wrap">' +
    esc(body) +
    (hasFooter
      ? '</div><div style="margin-top:14px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Arial,sans-serif;' +
        'font-size:11px;line-height:1.4;color:#9a9a9a">' + esc(footer) + '</div>'
      : '</div>')
  );
}

// Same signature as gmail.js sendEmail({ from, to, subject, body, inReplyTo }).
export async function sendEmailSMTP({ from, to, subject, body, inReplyTo = null, attachments = [], html = null }) {
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
    text: body,          // always sent, even alongside html
    ...(html ? { html } : {}),
    headers,
    // Hot Leads manual replies can carry files: [{ filename, path }]
    ...(attachments.length ? { attachments: attachments.map((a) => ({ filename: a.filename, path: a.path })) } : {}),
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
  // Pre-warmed inboxes (e.g. warmed externally on Zapmail before import) have a
  // meaningless startedAt for ramp purposes — skip the age ramp so the flat cap
  // applies. Brand-new inboxes (no prewarmed flag) DO get the ramp below.
  if (rec.prewarmed) return 9999;
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
