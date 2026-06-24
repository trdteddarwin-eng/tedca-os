// Push local inbox credentials to the cloud (Railway) over authed HTTPS.
//   - Gmail OAuth tokens  (server/data/gmail_tokens.json) → /api/gmail/import-tokens
//   - Zapmail SMTP logins (server/data/smtp_inboxes.json)  → /api/smtp/import-inboxes
//
// Creds go file → HTTPS → cloud volume. Nothing is hardcoded or printed.
// Run: node --env-file-if-exists=../../.env --env-file=../.env scripts/push-creds-to-cloud.mjs [cloudUrl]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const CLOUD = (process.argv[2] || "https://tedca-os-production.up.railway.app").replace(/\/$/, "");
const PW = process.env.OS_PASSWORD;

if (!PW) {
  console.error("OS_PASSWORD not in env — run with --env-file=../.env");
  process.exit(1);
}

const read = (f) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8"));
  } catch {
    return null;
  }
};

// 1. authenticate to the cloud
const loginRes = await fetch(`${CLOUD}/api/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password: PW }),
});
if (!loginRes.ok) {
  console.error(`cloud login failed (${loginRes.status}) — check OS_PASSWORD matches Railway`);
  process.exit(1);
}
const { token } = await loginRes.json();
const auth = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
console.log(`✓ authenticated to ${CLOUD}`);

// 2. Gmail tokens
const tokens = read("gmail_tokens.json");
if (tokens && Object.keys(tokens).length) {
  const r = await fetch(`${CLOUD}/api/gmail/import-tokens`, { method: "POST", headers: auth, body: JSON.stringify({ tokens }) });
  console.log(`Gmail tokens →   ${r.ok ? `imported ${Object.keys(tokens).length} inbox(es)` : `FAILED ${r.status}`}`);
} else {
  console.log("Gmail tokens →   (no local gmail_tokens.json, skipping)");
}

// 3. Zapmail SMTP inboxes
const inboxes = read("smtp_inboxes.json");
if (inboxes && Object.keys(inboxes).length) {
  const r = await fetch(`${CLOUD}/api/smtp/import-inboxes`, { method: "POST", headers: auth, body: JSON.stringify({ inboxes }) });
  console.log(`Zapmail inboxes → ${r.ok ? `imported ${Object.keys(inboxes).length} inbox(es)` : `FAILED ${r.status} ${await r.text()}`}`);
} else {
  console.log("Zapmail inboxes → (no local smtp_inboxes.json, skipping)");
}

console.log("\ndone — cloud now has the inbox credentials on its volume.");
