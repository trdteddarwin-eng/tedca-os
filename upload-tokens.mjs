// One-shot: copy the locally-authorized Gmail inbox tokens to the cloud instance.
// Logs in with OS_PASSWORD from .env, posts server/data/gmail_tokens.json. Nothing printed.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = "https://tedca-os-production.up.railway.app";

const env = Object.fromEntries(
  readFileSync(path.join(here, ".env"), "utf8")
    .split("\n")
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].trim()])
);

const tokens = JSON.parse(readFileSync(path.join(here, "server", "data", "gmail_tokens.json"), "utf8"));

const login = await fetch(`${BASE}/api/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password: env.OS_PASSWORD }),
});
if (!login.ok) throw new Error(`cloud login failed: ${login.status}`);
const { token } = await login.json();

const res = await fetch(`${BASE}/api/gmail/import-tokens`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify({ tokens }),
});
console.log("import:", res.status, await res.text());

const status = await fetch(`${BASE}/api/gmail/status`, {
  headers: { Authorization: `Bearer ${token}` },
});
const s = await status.json();
console.log("cloud inboxes:", s.inboxes.map((i) => `${i.authorized ? "✓" : "✗"} ${i.email}`).join("  "));
