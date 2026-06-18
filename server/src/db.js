import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// DATA_DIR points at the persistent volume in the cloud; defaults to local dev path
const dataDir = process.env.DATA_DIR || path.join(__dirname, "..", "data");
fs.mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(dataDir, "tedca-os.db"));
db.exec("PRAGMA journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_name TEXT NOT NULL,
  domain TEXT,
  category TEXT,
  rating REAL,
  review_count INTEGER,
  website TEXT,
  ceo_name TEXT,
  email TEXT,
  email_status TEXT,             -- valid | risky | unknown
  source TEXT,
  scraped_at TEXT,
  status TEXT NOT NULL DEFAULT 'scraped',  -- scraped|emailed|followup_sent|replied|do_not_contact
  inbox_used TEXT,
  last_touch_at TEXT,
  banked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running',  -- running|paused|done|failed
  cost_usd REAL NOT NULL DEFAULT 0,
  summary TEXT
);

CREATE TABLE IF NOT EXISTS activity_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  actor TEXT NOT NULL,            -- research|scrape|send|system|worker
  message TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',  -- info|warn|error|success
  raw TEXT
);

CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER,
  inbox TEXT,
  direction TEXT NOT NULL,        -- out|in
  subject TEXT,
  body TEXT,
  kind TEXT,                      -- initial|followup|reply
  sent_at TEXT
);

CREATE TABLE IF NOT EXISTS costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER,
  provider TEXT NOT NULL,
  amount_usd REAL NOT NULL,
  ts TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER,
  type TEXT NOT NULL,              -- scrape
  params TEXT NOT NULL,            -- JSON
  status TEXT NOT NULL DEFAULT 'queued',  -- queued|claimed|done|failed
  result TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  claimed_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  source TEXT,
  status TEXT NOT NULL DEFAULT 'lead',
  deal_value REAL,
  last_contact TEXT,
  notes TEXT
);
`);

// lightweight migrations for columns added after first ship
try {
  db.exec("ALTER TABLE leads ADD COLUMN followup_due_at TEXT");
} catch {
  /* column already exists */
}

// persist user sessions so a server restart doesn't log the browser out
try {
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
} catch {
  /* already exists */
}

const defaults = {
  niche: "med spa",
  city: "Bergen County NJ",
  daily_target: "100",
  per_inbox_cap: "20",
  inboxes: "[]",
  paused: "0",
  test_mode: "1", // 1 = all sends go to TEST_RECIPIENT
  followup_days: "3",
  email_subject: "quick question about {business_name}",
  email_body:
    "Hi {first_name},\n\nFound {business_name} on Google Maps ({rating} stars, {review_count} reviews) — clearly people like what you do.\n\nQuick question: when someone calls {business_name} and no one picks up, what happens to that lead? Most med spas lose 30-40% of new-patient calls that way.\n\nWe build a system that texts those missed callers back within 60 seconds and books them automatically. Want me to send a 2-min video of how it works?\n\n— Ted\ntedca.org",
  followup_body:
    "Hi {first_name},\n\nFollowing up on my note about missed calls at {business_name}. The text-back system usually pays for itself with one recovered booking.\n\nWorth a quick look? Happy to send the video.\n\n— Ted",
};
const insertSetting = db.prepare(
  "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)"
);
for (const [k, v] of Object.entries(defaults)) insertSetting.run(k, v);
