// Cloud mirror: push local leads + email history to the cloud instance.
// Runs every ~30s via launchd (com.tedca.os.cloudsync). SILENT-FAILURE TRIPWIRE:
// if the sync fails 10 times in a row (~5 min broken), ping Telegram — a frozen
// phone dashboard must announce itself (it silently froze for ~20h on 2026-07-08
// when the dataset outgrew the old 2mb JSON limit).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = "https://tedca-os-production.up.railway.app";
const STREAK_FILE = "/tmp/tedca-cloudsync.failstreak";
const ALERT_EVERY = 10; // alert on the 10th consecutive failure, then every 240th (~2h)
const env = Object.fromEntries(
  readFileSync(path.join(here, ".env"), "utf8")
    .split("\n")
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].trim()])
);

function readStreak() {
  try { return existsSync(STREAK_FILE) ? Number(readFileSync(STREAK_FILE, "utf8")) || 0 : 0; } catch { return 0; }
}
function writeStreak(n) {
  try { writeFileSync(STREAK_FILE, String(n)); } catch { /* tmp write best-effort */ }
}
async function alertTelegram(text) {
  const tg = env.TELEGRAM_BOT_TOKEN, chat = env.TELEGRAM_CHAT_ID;
  if (!tg || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${tg}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text }),
    });
  } catch { /* alerting must never crash the sync */ }
}

async function fail(reason) {
  const streak = readStreak() + 1;
  writeStreak(streak);
  console.error(`sync failed (streak ${streak}): ${reason}`);
  if (streak === ALERT_EVERY || (streak > ALERT_EVERY && streak % 240 === 0)) {
    await alertTelegram(
      `⚠️ Cloud dashboard sync has been FAILING for ${streak} straight runs (~${Math.round((streak * 30) / 60)} min). ` +
      `The phone dashboard is frozen at its last good state. Reason: ${String(reason).slice(0, 140)}`
    );
  }
  process.exit(1);
}

try {
  const db = new DatabaseSync(path.join(here, "server", "data", "tedca-os.db"));
  const leads = db.prepare("SELECT * FROM leads").all();
  const emails = db.prepare("SELECT * FROM emails").all();
  const runs = db.prepare("SELECT * FROM runs").all();
  console.log(`local: ${leads.length} leads, ${emails.length} emails, ${runs.length} runs`);

  const loginRes = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: env.OS_PASSWORD, machine: true }),
  });
  if (!loginRes.ok) await fail(`cloud login HTTP ${loginRes.status}`);
  const { token } = await loginRes.json();

  const res = await fetch(`${BASE}/api/admin/import-data`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ leads, emails, runs, replace: true }),
  });
  const bodyText = await res.text();
  if (!res.ok) await fail(`import HTTP ${res.status}: ${bodyText.slice(0, 120)}`);

  console.log("import:", res.status, bodyText.slice(0, 200));
  const prev = readStreak();
  writeStreak(0);
  if (prev >= ALERT_EVERY) {
    await alertTelegram(`✅ Cloud dashboard sync RECOVERED after ${prev} failed runs — the phone numbers are live again.`);
  }
} catch (e) {
  await fail(e?.message || String(e));
}
