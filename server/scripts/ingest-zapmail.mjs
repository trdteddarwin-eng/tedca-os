// Ingest Zapmail "Export Mailboxes" CSV(s) into server/data/smtp_inboxes.json.
//
// Usage:
//   node server/scripts/ingest-zapmail.mjs ~/Downloads/mailboxes-*.csv
//
// Passwords flow CSV → JSON only; nothing is printed. The store is chmod 600
// and lives under server/data/ which is gitignored. Re-running is safe: it
// merges and PRESERVES each inbox's startedAt so the warmup ramp never resets.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE = path.join(__dirname, "..", "data", "smtp_inboxes.json");

const files = process.argv.slice(2);
if (!files.length) {
  console.error("usage: node server/scripts/ingest-zapmail.mjs <file1.csv> [file2.csv ...]");
  process.exit(1);
}

// ── tiny RFC4180-ish CSV parser (handles quotes, commas, newlines in fields) ──
function parseCsv(text) {
  text = text.replace(/^﻿/, ""); // strip BOM
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c === "\r") { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
function pick(obj, ...keys) {
  for (const k of keys) if (obj[k] != null && obj[k] !== "") return obj[k];
  return "";
}

const store = (() => {
  try { return JSON.parse(fs.readFileSync(STORE, "utf8")); }
  catch { return {}; }
})();

const now = new Date().toISOString();
let added = 0, updated = 0;
const domains = new Set();

for (const file of files) {
  const rows = parseCsv(fs.readFileSync(file, "utf8"));
  if (rows.length < 2) { console.error(`! ${file}: no data rows`); continue; }
  const headers = rows[0].map(norm);
  for (const r of rows.slice(1)) {
    const o = {};
    headers.forEach((h, idx) => { o[h] = (r[idx] || "").trim(); });

    const email = pick(o, "email", "emailaddress", "username").toLowerCase();
    if (!email || !email.includes("@")) continue;

    const imapPass = pick(o, "imappassword", "imappass", "password", "apppassword");
    const smtpPass = pick(o, "smtppassword", "smtppass") || imapPass;
    const rec = {
      firstName: pick(o, "firstname", "first") || null,
      smtpHost: pick(o, "smtphost") || "smtp.gmail.com",
      smtpPort: Number(pick(o, "smtpport") || 587),
      smtpUser: pick(o, "smtpusername", "smtpuser") || email,
      smtpPass,
      imapHost: pick(o, "imaphost") || "imap.gmail.com",
      imapPort: Number(pick(o, "imapport") || 993),
      imapUser: pick(o, "imapusername", "imapuser") || email,
      imapPass,
      // preserve the original activation date so the ramp keeps counting
      startedAt: store[email]?.startedAt || now,
    };
    if (!rec.smtpPass) { console.error(`! ${email}: no password column found — skipped`); continue; }

    if (store[email]) updated++; else added++;
    store[email] = rec;
    domains.add(email.split("@")[1]);
  }
}

fs.mkdirSync(path.dirname(STORE), { recursive: true });
fs.writeFileSync(STORE, JSON.stringify(store, null, 2), { mode: 0o600 });
fs.chmodSync(STORE, 0o600); // the mode option only applies on create — enforce on re-runs too

console.log(`✓ wrote ${Object.keys(store).length} inbox(es) to server/data/smtp_inboxes.json`);
console.log(`  ${added} new, ${updated} updated · ${domains.size} domain(s): ${[...domains].join(", ")}`);
console.log("  (no passwords printed — they're in the chmod-600 store)");
