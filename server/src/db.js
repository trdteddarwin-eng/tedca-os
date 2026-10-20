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

// ── Lead queue (2026-09-09): "feed it leads, it does the rest" ───────────────
// Leads no longer have to come from the scraper. Ted feeds a batch (CSV / paste /
// Google Sheet); each fed lead carries batch_id and lands as status='scraped',
// email_status=NULL — exactly the state the morning run's producer already pulls
// from — so the existing verify → dedupe → send chain handles it unchanged.
//   batch_id       which feed this lead came from (NULL = scraped by Apify)
//   supplied_email 1 = the address came from Ted's file → VERIFY it (AnyMailFinder
//                  verify-email, ~0.2 credits) instead of replacing it with a CEO lookup
//   raw_json       the original row, untouched, for audit / unmapped columns
for (const col of ["batch_id INTEGER", "supplied_email INTEGER NOT NULL DEFAULT 0", "raw_json TEXT", "linkedin_message TEXT"]) {
  try {
    db.exec(`ALTER TABLE leads ADD COLUMN ${col}`);
  } catch {
    /* column already exists */
  }
}
db.exec(`
CREATE TABLE IF NOT EXISTS lead_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  source TEXT,                       -- csv | paste | sheet | telegram | api
  niche TEXT,
  status TEXT NOT NULL DEFAULT 'active',   -- active | paused | archived
  priority INTEGER NOT NULL DEFAULT 10,    -- lower = sent first; scraped leads sort as 50
  template_subject TEXT,             -- optional per-batch copy override (NULL = settings)
  template_body TEXT,
  row_count INTEGER NOT NULL DEFAULT 0,    -- rows in the file, incl. dupes/rejects
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
try {
  db.exec("CREATE INDEX IF NOT EXISTS idx_leads_queue ON leads(status, email_status, batch_id)");
} catch {
  /* exists */
}
try {
  db.exec("ALTER TABLE lead_batches ADD COLUMN skipped_json TEXT"); // {rejected, email, domain, name_city, suppressed, contacted, in_file}
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

// Rotate by STATE, then by queue order — drain every city in a state before
// crossing the border. Rotation used to be "lowest fresh id", which is only the
// order cities happened to be typed in: on Sep 4 Bergen County dried up and the
// next pick was Miami FL (id 1), stranding four untouched NJ counties behind 40
// sunbelt metros. Ranking by state keeps the engine grinding through NJ, then
// moves to the next state as a deliberate step.
// `priority` = how much of this market we have ALREADY scraped (lower = fresher
// ground = goes first). Ordering inside a state by `id` was ordering by the day
// someone typed the city in: on Sep 4 that sent the run to Morris County, which
// already had ~130 leads banked, and it came back with 18 new businesses for
// $1.28. Sorting by measured coverage sends the money at untouched ground first.
for (const col of ["state TEXT", "state_rank INTEGER", "priority INTEGER NOT NULL DEFAULT 50"]) {
  try {
    db.exec(`ALTER TABLE markets ADD COLUMN ${col}`);
  } catch {
    /* column already exists */
  }
}

// The state running order. This list is the source of truth — to re-order states,
// edit it here (state_rank is recomputed from it on every rotation decision, so a
// state can be demoted or promoted without touching a single markets row).
//
// 2026-09-09 reorder: NJ went from first to LAST. NJ dentistry is worked out —
// 1,245 leads scraped, 543 valid emails already burned, and the Sep 9 Trenton run
// found 6 new businesses in 123 results and sent zero. Its 15 remaining "fresh"
// counties are only nominally fresh (Hoboken 50, Jersey City 47, Clifton 39 leads
// already banked via overlapping searches), so grinding them out first was costing
// a scrape a day for ~nothing. Untouched states lead now; the partially-worked
// sunbelt follows; NJ sits at the back, still queued if we ever want it back.
export const STATE_ROTATION = [
  // never scraped — 100% fresh ground
  "IL", "MA", "VA", "MD", "WA", "OH", "MI", "MN", "IN", "WI", "MO", "SC", "OR", "ID",
  // partially worked
  "NY", "PA", "CT", "GA", "NC", "TN", "CO", "UT", "FL", "TX", "AZ", "NV", "CA",
  // spent
  "NJ",
];
// Any market whose state is not in the rotation sorts last, never first.
export const RANK_UNLISTED = STATE_ROTATION.length;

const US_STATE_CODES = ("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO " +
  "MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY").split(" ");

// Markets are only ever created by hand-run SQL — there is no INSERT path in the
// app — so a new row arrives with NULL state/state_rank and, because SQLite sorts
// NULL FIRST on an ascending ORDER BY, would leap to the head of the queue ahead
// of every NJ county. Hence: this runs at boot AND before every rotation decision,
// so a row inserted while the server is up is ranked before it can be picked.
// Returns the names it could not place, for the caller to surface.
export function syncMarketStates() {
  // A state code is the trailing " XX" of the name ("Bergen County NJ"), but only
  // if XX is a real state — otherwise "Tampa" would read as PA and queue itself
  // inside the Pennsylvania run.
  const codes = US_STATE_CODES.map((c) => `'${c}'`).join(",");
  db.exec(`
    UPDATE markets
       SET state = upper(substr(name, -2))
     WHERE (state IS NULL OR state = '')
       AND name GLOB '* [A-Za-z][A-Za-z]'
       AND upper(substr(name, -2)) IN (${codes})
  `);
  // Reset first, then apply: a state DROPPED from STATE_ROTATION must fall to the
  // back, not keep the rank it held when it was still listed.
  db.prepare("UPDATE markets SET state_rank=?").run(RANK_UNLISTED);
  const setStateRank = db.prepare("UPDATE markets SET state_rank=? WHERE state=?");
  STATE_ROTATION.forEach((code, i) => setStateRank.run(i, code));
  return db
    .prepare("SELECT name FROM markets WHERE state IS NULL OR state=''")
    .all()
    .map((r) => r.name);
}
syncMarketStates();

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
  // Lead queue (2026-09-09). The morning run drains the fed queue; scraping is an
  // opt-in refill, OFF by default, so a run with an empty queue stands down and
  // asks for leads instead of burning Apify on a drained city.
  auto_refill: "0",                    // 1 = scrape Google Maps when the queue can't cover the day
  verify_ahead_enabled: "1",           // background AnyMailFinder loop keeps `valid` leads ready
  verify_ahead_days: "2",              // how many days of daily_target to keep verified ahead
  verify_daily_budget_credits: "200",  // AnyMailFinder credits the loop may spend per ET day
  runway_alert_days: "3",              // Telegram "feed me" when runway drops under this
  runway_alert_date: "",               // last ET date the runway alert fired (one per day)
};
const insertSetting = db.prepare(
  "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)"
);
for (const [k, v] of Object.entries(defaults)) insertSetting.run(k, v);
