// Verify the CLOUD instance can send: one test email from each inbox via Railway.
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

const { token } = await (
  await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: env.OS_PASSWORD }),
  })
).json();

const res = await fetch(`${BASE}/api/gmail/test-send`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify({}),
});
const data = await res.json();
for (const r of data.results || []) {
  console.log(r.ok ? `✓ ${r.email} (message ${r.id})` : `✗ ${r.email} — ${r.error}`);
}
