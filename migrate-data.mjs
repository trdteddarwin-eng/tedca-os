// One-shot: push local leads + email history to the cloud instance.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = "https://tedca-os-production.up.railway.app";
const env = Object.fromEntries(
  readFileSync(path.join(here, ".env"), "utf8")
    .split("\n")
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].trim()])
);

const db = new DatabaseSync(path.join(here, "server", "data", "tedca-os.db"));
const leads = db.prepare("SELECT * FROM leads").all();
const emails = db.prepare("SELECT * FROM emails").all();
console.log(`local: ${leads.length} leads, ${emails.length} emails`);

const { token } = await (
  await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: env.OS_PASSWORD }),
  })
).json();

const res = await fetch(`${BASE}/api/admin/import-data`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify({ leads, emails }),
});
console.log("import:", res.status, await res.text());
