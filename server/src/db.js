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

// CRM enrichment fields — added per-lead, editable in the dashboard
for (const col of [
  "linkedin_url TEXT",
  "contact_title TEXT",
  "phone TEXT",
  "city TEXT",
  "state TEXT",
  "employee_size TEXT",
  "stage TEXT",        // lead | contacted | replied | booked | won | lost
  "deal_value REAL",
  "tags TEXT",         // comma-separated
  "notes TEXT",
  "sentiment TEXT",    // interested | neutral | negative
  "created_at TEXT",
  "updated_at TEXT",
]) {
  try {
    db.exec(`ALTER TABLE leads ADD COLUMN ${col}`);
  } catch {
    /* column already exists */
  }
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

// Clip Editor with history: every video-edit belongs to a project; each revision is a new
// version built FROM a previous version's composition state (branching via parent_version_id).
db.exec(`
CREATE TABLE IF NOT EXISTS edit_projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  source_path TEXT NOT NULL,
  style_id TEXT NOT NULL DEFAULT 'locked',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS edit_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  version_n INTEGER NOT NULL,
  parent_version_id INTEGER,           -- which version this was revised FROM (branching)
  job_id INTEGER,                      -- jobs table stays the execution source of truth
  status TEXT NOT NULL DEFAULT 'rendering',  -- rendering|done|failed|seeded
  notes TEXT,
  output_path TEXT,
  build_log_path TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_edit_versions_project ON edit_versions(project_id, version_n);
`);

// Market rotation: the engine scrapes ONE metro at a time and auto-advances to the
// next fresh one when a market stops yielding new businesses. Exhausted markets are
// never scraped again — that is the Apify cost guard (no paying to re-scrape a city
// we have already drained).
db.exec(`
CREATE TABLE IF NOT EXISTS markets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  query TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'fresh',   -- fresh | active | exhausted
  runs_used INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  last_new_count INTEGER
);
`);

// Content Posted: every IG reel / FB video we track + a metrics snapshot per
// refresh (content.js polls the Graph APIs — Meta has no push webhook for
// like/view counts). The snapshot HISTORY is the point: it lets the UI draw a
// per-post growth curve, so "real time" degrades gracefully into "here is how
// this post grew".
db.exec(`
CREATE TABLE IF NOT EXISTS content_posts (
  id TEXT PRIMARY KEY,                 -- "<network>:<external_id>"
  network TEXT NOT NULL,               -- instagram | facebook
  external_id TEXT NOT NULL,
  permalink TEXT,
  caption TEXT,
  media_type TEXT,                     -- REELS | FEED | IMAGE | CAROUSEL_ALBUM | VIDEO
  thumbnail_url TEXT,
  posted_at TEXT,
  first_seen TEXT,
  last_refreshed TEXT
);
CREATE TABLE IF NOT EXISTS content_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  views INTEGER,
  reach INTEGER,
  likes INTEGER,
  comments INTEGER,
  saves INTEGER,
  shares INTEGER
);
CREATE INDEX IF NOT EXISTS idx_content_metrics_post ON content_metrics(post_id, captured_at);
`);

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
