// CRM auto-backup → Ted's Google Sheet (free off-site copy, browsable from his phone)
// + a daily dated snapshot of the SQLite file locally. The Sheet is a one-way EXPORT:
// SQLite on the Mac stays the source of truth; this mirror exists so a dead laptop can
// never take the business data with it.
//
// Sheet: https://docs.google.com/spreadsheets/d/1Dr2ec3Inz9Eo41eBFzzzvGLpZ3uh2b3Na6bzLElMQ8M
// Must be shared (Editor) with the service account: manychat@many-chat-498319.iam.gserviceaccount.com
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { db } from "./db.js";
import { sheetsApi, manychatConfigured } from "./igkeywords.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const BACKUP_SHEET_ID = process.env.CRM_BACKUP_SHEET_ID || "1Dr2ec3Inz9Eo41eBFzzzvGLpZ3uh2b3Na6bzLElMQ8M";
const SYNC_EVERY_MS = 4 * 60 * 60 * 1000; // every 4 hours
const SNAPSHOT_KEEP = 14; // days of local .db snapshots

let logEvent = () => {};
export function bindBackupLogger(fn) { logEvent = fn; }

const getSetting = (k) => db.prepare("SELECT value FROM settings WHERE key=?").get(k)?.value;
const setSetting = (k, v) =>
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, String(v));

// map of tab title -> {sheetId, rowCount} so we can grow a tab before writing
async function tabMeta() {
  const meta = await sheetsApi(BACKUP_SHEET_ID, "?fields=sheets.properties");
  const m = {};
  for (const s of meta.sheets || []) m[s.properties.title] = { id: s.properties.sheetId, rows: s.properties.gridProperties?.rowCount || 1000 };
  return m;
}

async function ensureTabs(titles) {
  let meta = await tabMeta();
  const missing = titles.filter((t) => !(t in meta));
  if (missing.length) {
    await sheetsApi(BACKUP_SHEET_ID, ":batchUpdate", {
      method: "POST",
      // create each missing tab with generous grid limits up front
      body: JSON.stringify({ requests: missing.map((title) => ({ addSheet: { properties: { title, gridProperties: { rowCount: 200000, columnCount: 26 } } } })) }),
    });
    meta = await tabMeta();
  }
  return meta;
}

// grow a tab's row count if it can't hold `needed` rows (fresh tabs cap at 1000)
async function ensureRows(meta, tab, needed) {
  const cur = meta[tab]?.rows || 1000;
  if (cur >= needed) return;
  await sheetsApi(BACKUP_SHEET_ID, ":batchUpdate", {
    method: "POST",
    body: JSON.stringify({
      requests: [{ updateSheetProperties: { properties: { sheetId: meta[tab].id, gridProperties: { rowCount: needed + 500 } }, fields: "gridProperties.rowCount" } }],
    }),
  });
  meta[tab].rows = needed + 500;
}

async function writeTab(tab, header, rows, meta) {
  if (meta) await ensureRows(meta, tab, rows.length + 5);
  await sheetsApi(BACKUP_SHEET_ID, `/values/${encodeURIComponent(`'${tab}'!A1:ZZ200000`)}:clear`, { method: "POST", body: "{}" });
  const values = [header, ...rows];
  // chunk the write so one request never exceeds the API payload limit
  const CHUNK = 500;
  for (let i = 0; i < values.length; i += CHUNK) {
    const slice = values.slice(i, i + CHUNK);
    await sheetsApi(
      BACKUP_SHEET_ID,
      `/values/${encodeURIComponent(`'${tab}'!A${i + 1}`)}?valueInputOption=RAW`,
      { method: "PUT", body: JSON.stringify({ values: slice }) }
    );
  }
}

const s = (v) => (v === null || v === undefined ? "" : String(v));

export async function runCrmBackup() {
  if (!manychatConfigured()) throw new Error("Google service-account key not on this machine");
  const meta = await ensureTabs(["Leads", "Emails", "Suppressions", "Meta"]);

  const leads = db.prepare(
    `SELECT id, business_name, email, status, inbox_used, category, city, state, rating, review_count,
            website, source, scraped_at, last_touch_at, followup_due_at, email_status
     FROM leads ORDER BY id`
  ).all();
  await writeTab(
    "Leads",
    ["id", "business", "email", "status", "inbox_used", "category", "city", "state", "rating", "reviews", "website", "source", "scraped_at", "last_touch_at", "followup_due_at", "email_status"],
    leads.map((l) => [l.id, s(l.business_name), s(l.email), s(l.status), s(l.inbox_used), s(l.category), s(l.city), s(l.state), s(l.rating), s(l.review_count), s(l.website), s(l.source), s(l.scraped_at), s(l.last_touch_at), s(l.followup_due_at), s(l.email_status)]),
    meta
  );

  const emails = db.prepare(
    `SELECT e.id, e.lead_id, l.business_name, e.inbox, e.direction, e.kind, e.subject, e.body, e.sent_at
     FROM emails e LEFT JOIN leads l ON l.id = e.lead_id ORDER BY e.id`
  ).all();
  await writeTab(
    "Emails",
    ["id", "lead_id", "business", "inbox", "direction", "kind", "subject", "sent_at", "body"],
    emails.map((e) => [e.id, s(e.lead_id), s(e.business_name), s(e.inbox), s(e.direction), s(e.kind), s(e.subject), s(e.sent_at), s(e.body).slice(0, 8000)]),
    meta
  );

  const sup = db.prepare("SELECT email, ts FROM suppressions ORDER BY ts").all();
  await writeTab("Suppressions", ["email (never contact again)", "since"], sup.map((r) => [s(r.email), s(r.ts)]), meta);

  const when = new Date().toISOString().slice(0, 19).replace("T", " ") + " UTC";
  await writeTab("Meta", ["what", "value"], [
    ["last sync", when],
    ["leads", String(leads.length)],
    ["emails", String(emails.length)],
    ["suppressions", String(sup.length)],
    ["source of truth", "tedca-os/server/data/tedca-os.db on Ted's Mac — this Sheet is a one-way backup"],
  ]);

  setSetting("crm_backup_last", when);
  setSetting("crm_backup_counts", JSON.stringify({ leads: leads.length, emails: emails.length, suppressions: sup.length }));
  return { leads: leads.length, emails: emails.length, suppressions: sup.length, when };
}

// daily dated snapshot of the raw .db (safe under WAL via sqlite's own .backup)
function dailySnapshot() {
  const today = new Date().toISOString().slice(0, 10);
  if (getSetting("last_db_snapshot_date") === today) return;
  const dir = path.join(DATA_DIR, "backups");
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `tedca-os-${today}.db`);
  execFile("sqlite3", [path.join(DATA_DIR, "tedca-os.db"), `.backup '${dest}'`], (err) => {
    if (err) { logEvent({ actor: "system", message: `Local DB snapshot failed: ${err.message}`, level: "warn" }); return; }
    setSetting("last_db_snapshot_date", today);
    // rotate: keep the newest SNAPSHOT_KEEP snapshots
    const old = fs.readdirSync(dir).filter((f) => f.startsWith("tedca-os-")).sort().slice(0, -SNAPSHOT_KEEP);
    for (const f of old) { try { fs.unlinkSync(path.join(dir, f)); } catch {} }
    logEvent({ actor: "system", message: `Local DB snapshot saved (${today}) — keeping ${SNAPSHOT_KEEP} days.`, level: "info" });
  });
}

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    dailySnapshot();
    const r = await runCrmBackup();
    logEvent({ actor: "system", message: `CRM backed up to Google Sheets: ${r.leads} leads, ${r.emails} emails, ${r.suppressions} suppressed. Next sync in 4h.`, level: "info" });
  } catch (e) {
    // most common cause until Ted shares the Sheet: 403 PERMISSION_DENIED
    logEvent({ actor: "system", message: `CRM Sheet backup skipped: ${e.message.slice(0, 140)} (share the Sheet with manychat@many-chat-498319.iam.gserviceaccount.com as Editor)`, level: "warn" });
  } finally {
    running = false;
  }
}

export function startCrmBackupLoop() {
  setTimeout(tick, 2 * 60 * 1000); // first attempt ~2 min after boot
  setInterval(tick, SYNC_EVERY_MS);
}
