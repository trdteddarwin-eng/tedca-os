import express from "express";
import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { db } from "./db.js";
import { gmailConfigured, authorizedInboxes, startAuth, sendEmail, importTokens } from "./gmail.js";
import { smtpInboxMeta, importSmtpInboxes } from "./smtp.js";
import { sendingInboxes, sendVia } from "./pool.js";
import { startMorningRun, runningRunId, bindLogger, startFollowupLoop, startScheduler, startDailyReportLoop, startOwnerHeartbeat, startBounceGuard, getSetting, fillTemplate, senderNameFor, startVerifyAheadLoop, verifyAheadTick, queueRunway, queueCounts, verifyCreditsToday } from "./engine.js";
import {
  bindIntakeLogger,
  parseUpload as intakeParseUpload,
  parseText as intakeParseText,
  readSheet as intakeReadSheet,
  preview as intakePreview,
  remap as intakeRemap,
  commit as intakeCommit,
  listBatches,
  getBatch,
  updateBatch,
} from "./intake.js";
import { startReplyLoop, bindReplyLogger } from "./replies.js";
import { startLinkedInLoop, bindLinkedInLogger, generateLinkedInMessage } from "./linkedin.js";
import { telegramConfigured, sendTelegramFile, sendTelegram } from "./telegram.js";
import { elevenConfigured, generateVoice } from "./elevenlabs.js";
import { manychatConfigured, listKeywords, upsertKeyword, deleteKeyword, recentActivity, findDuplicateWarnings, botHealth , markTokenRefreshed } from "./igkeywords.js";
import { runCrmBackup, startCrmBackupLoop, bindBackupLogger } from "./crmbackup.js";
import { refreshContent, contentStatus, startContentLoop, bindContentLogger } from "./content.js";
import { getUpcoming, resolveUpcomingFile, materializeBlob, sendDayRequest } from "./upcoming.js";
import { SERVICES, bindKeysLogger, setKeys, maskedInfo, fetchCredits } from "./keys.js";
import { siteStats, SITES } from "./sitestats.js";
import {
  listHotLeads,
  getThread as hotLeadThread,
  sendReply as hotLeadSendReply,
  draftReply as hotLeadDraftReply,
  bindHotLeadsLogger,
} from "./hotleads.js";
import {
  bindSkillLogger,
  avatarVideoScript,
  personalVideoScript,
  reviseTedVoice,
  pvLoad,
  pvSave,
  suggestLivephotoTopics,
  queueLivephoto,
  markTopicDone,
  queueCarousel,
  queueTts,
  queueMotionGraphic,
  queueHeygenVideo,
  queueVideoEdit,
  queueEditVersion,
  editStyles,
  eduPostCopy,
  queueEduPost,
  jobStatus,
  VOICE_AVATAR,
  VOICE_PERSONAL,
} from "./skills.js";

// Crash-resistance: a stray async error (an IMAP socket drop, an SMTP hiccup, a
// failed fetch) must NEVER take down the live sender mid-run. The watchdog can
// restart a dead process, but it can't resume a killed run — so the day's volume is
// lost. Log loudly and keep running instead. State-corrupting errors are rare here
// (these are isolated network/async failures, not DB corruption).
process.on("uncaughtException", (e) => {
  // EADDRINUSE = another server already owns the port. Keeping THIS process alive
  // creates a portless zombie that still runs engine loops and competes for the
  // send lock (double-send risk — bit us 2026-07-07 and again 2026-07-08). Die fast.
  if (e?.code === "EADDRINUSE") {
    console.error("[fatal] port already in use — another server is live; exiting instead of zombieing.");
    process.exit(0);
  }
  console.error("[uncaughtException — kept alive]", e?.stack || e?.message || e);
  try {
    db.prepare(
      "INSERT INTO activity_events (actor, message, level) VALUES ('system', ?, 'error')"
    ).run(`Recovered from a crash (${String(e?.message || e).slice(0, 160)}) — server stayed up.`);
  } catch { /* never let the handler itself throw */ }
});
process.on("unhandledRejection", (e) => {
  console.error("[unhandledRejection — kept alive]", e?.stack || e?.message || e);
});

const PORT = Number(process.env.PORT || 8787);
const OS_PASSWORD = process.env.OS_PASSWORD || "";
const WORKER_TOKEN = process.env.WORKER_TOKEN || "";

if (!OS_PASSWORD) {
  console.error("OS_PASSWORD is not set in tedca-os/.env — refusing to start.");
  process.exit(1);
}
if (!WORKER_TOKEN) {
  console.error("WORKER_TOKEN is not set in tedca-os/.env — refusing to start.");
  process.exit(1);
}

const app = express();
// 64mb: the cloudsync mirror POSTs the whole leads+emails+runs dataset in one
// import-data call — at ~1.3k leads / 1.2k full-body emails it blew past 2mb
// ("Payload Too Large", cloud dashboard froze at Jul 7). Room for years of growth.
app.use(express.json({ limit: "64mb" }));

// ---- CORS ----------------------------------------------------------------
// The dashboard front-end can be hosted off-origin (e.g. on Vercel) and still
// call this API. Auth is a Bearer token (not cookies), so reflecting the request
// origin is safe — every protected route still requires a valid login token.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type,Range");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range,Accept-Ranges,Content-Length");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// ---- auth ----------------------------------------------------------------
// Single-user password gate. Sessions are persisted in SQLite so a server
// restart doesn't silently log the browser out.
// In-memory Set acts as a fast cache; SQLite is the source of truth.
const sessionCache = new Set();

// Seed the cache from the DB on startup so existing sessions survive restarts.
try {
  const saved = db.prepare("SELECT token FROM sessions").all();
  for (const { token } of saved) sessionCache.add(token);
} catch {
  /* sessions table may not exist yet — db.js will create it on next exec */
}

function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function sessionExists(token) {
  if (sessionCache.has(token)) return true;
  // fallback: check DB directly (in case cache was not warmed)
  const row = db.prepare("SELECT 1 FROM sessions WHERE token=?").get(token);
  if (row) { sessionCache.add(token); return true; }
  return false;
}

app.post("/api/login", (req, res) => {
  const { password, machine } = req.body || {};
  if (!password || !timingSafeEqual(password, OS_PASSWORD)) {
    return res.status(401).json({ error: "wrong password" });
  }
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT OR IGNORE INTO sessions (token) VALUES (?)").run(token);
  sessionCache.add(token);
  // remember the PREVIOUS login time so the digest can show "since you were gone".
  // Machine logins (the 30s cloud-sync in migrate-data.mjs) MUST NOT touch these — else
  // prev_login_at is always ~30s ago and the live digest reports 0 sent / 0 replies.
  if (!machine) {
    const prev = db.prepare("SELECT value FROM settings WHERE key='last_login_at'").get()?.value || "";
    const up = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
    up.run("prev_login_at", prev);
    up.run("last_login_at", new Date().toISOString().slice(0, 19).replace("T", " "));
  }
  res.json({ token });
});

// login digest: what happened since the previous login (single-user app)
app.get("/api/digest", requireUser, (req, res) => {
  const prev = db.prepare("SELECT value FROM settings WHERE key='prev_login_at'").get()?.value;
  const since = prev && prev.length ? prev : db.prepare("SELECT datetime('now','-1 day') d").get().d;
  const since1 = (sql) => db.prepare(sql).get(since).c;
  res.json({
    since,
    sentSince: since1("SELECT COUNT(*) c FROM emails WHERE direction='out' AND kind IN ('initial','followup') AND subject NOT LIKE '%[TEST%' AND sent_at>=?"),
    sentToday: db.prepare("SELECT COUNT(*) c FROM emails WHERE direction='out' AND kind='initial' AND subject NOT LIKE '%[TEST%' AND sent_at>=date('now')").get().c,
    repliesSince: since1("SELECT COUNT(*) c FROM emails WHERE direction='in' AND sent_at>=?"),
    interested: db.prepare("SELECT COUNT(*) c FROM leads WHERE status='replied'").get().c,
    bouncesSince: since1("SELECT COUNT(*) c FROM leads WHERE status='bounced' AND last_touch_at>=?"),
    bankedReady: db.prepare("SELECT COUNT(*) c FROM leads WHERE status='scraped' AND email_status='valid' AND email IS NOT NULL").get().c,
    queue: queueRunway(),
    lastRun: db.prepare("SELECT summary, status, finished_at FROM runs ORDER BY id DESC LIMIT 1").get() || null,
  });
});

function bearerToken(req) {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

function requireUser(req, res, next) {
  const token = bearerToken(req);
  if (!token || !sessionExists(token)) return res.status(401).json({ error: "unauthorized" });
  next();
}

function requireWorker(req, res, next) {
  const token = bearerToken(req);
  if (!token || !timingSafeEqual(token, WORKER_TOKEN)) {
    return res.status(401).json({ error: "unauthorized worker" });
  }
  next();
}

// ---- live feed -----------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== "/ws") return socket.destroy();
  const token = url.searchParams.get("token") || "";
  const ok = sessionExists(token) || (WORKER_TOKEN && timingSafeEqual(token, WORKER_TOKEN));
  if (!ok) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

// ---- activity ------------------------------------------------------------
const insertEvent = db.prepare(
  "INSERT INTO activity_events (run_id, actor, message, level, raw) VALUES (?, ?, ?, ?, ?)"
);
const getEvent = db.prepare("SELECT * FROM activity_events WHERE id = ?");

export function logEvent({ run_id = null, actor = "system", message, level = "info", raw = null }) {
  const info = insertEvent.run(run_id, actor, message, level, raw);
  const event = getEvent.get(info.lastInsertRowid);
  broadcast({ type: "activity", event });
  return event;
}

app.get("/api/activity", requireUser, (req, res) => {
  const limit = Math.min(Number(req.query.limit || 200), 1000);
  const rows = db
    .prepare("SELECT * FROM activity_events ORDER BY id DESC LIMIT ?")
    .all(limit);
  res.json(rows.reverse());
});

// Worker (and future agents) post events here.
app.post("/api/activity", requireWorker, (req, res) => {
  const { run_id, actor, message, level, raw } = req.body || {};
  if (!message) return res.status(400).json({ error: "message required" });
  const event = logEvent({ run_id, actor: actor || "worker", message, level: level || "info", raw });
  res.json(event);
});

// Dev helper: emit a test event from the UI to prove the live feed works.
app.post("/api/activity/test", requireUser, (req, res) => {
  const event = logEvent({
    actor: "system",
    message: `Test event from dashboard at ${new Date().toLocaleTimeString()}`,
    level: "info",
  });
  res.json(event);
});

// ---- api keys --------------------------------------------------------------
// Central keystore (server/src/keys.js): masked key info + LIVE remaining-credit
// lookups per service. Full keys never leave the server through these routes.
bindKeysLogger(logEvent); // so markFailed()'s "switched to fallback" hits the activity feed

app.get("/api/api-keys", requireUser, async (req, res) => {
  try {
    const info = maskedInfo();
    // All credit lookups in parallel; each has its own 5s timeout and returns
    // {kind:"unknown"} on failure — one dead provider can't stall or crash the page.
    const credits = await Promise.all(info.map((s) => fetchCredits(s.service)));
    res.json(info.map((s, i) => ({ ...s, credits: credits[i] })));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/api-keys", requireUser, (req, res) => {
  const { service, primary, fallback } = req.body || {};
  if (!service || !SERVICES[service]) return res.status(400).json({ error: "unknown service" });
  try {
    const masked = setKeys(service, { primary, fallback });
    // Log the action, NEVER the key.
    logEvent({
      actor: "system",
      message: primary
        ? `API key rotated for ${SERVICES[service].label} from the OS${fallback ? " (+ fallback set)" : ""}.`
        : `Fallback API key set for ${SERVICES[service].label} from the OS.`,
      level: "success",
    });
    res.json({ ok: true, ...masked });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

// ---- data reads ----------------------------------------------------------
app.get("/api/stats", requireUser, (req, res) => {
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const monthIso = monthStart.toISOString().slice(0, 19).replace("T", " ");
  res.json({
    leads: db.prepare("SELECT COUNT(*) c FROM leads").get().c,
    emails_sent: db.prepare("SELECT COUNT(*) c FROM emails WHERE direction='out'").get().c,
    replies: db.prepare("SELECT COUNT(*) c FROM emails WHERE direction='in'").get().c,
    cost_month: db.prepare("SELECT COALESCE(SUM(amount_usd),0) s FROM costs WHERE ts >= ?").get(monthIso).s,
    running: db.prepare("SELECT * FROM runs WHERE status IN ('running','paused') ORDER BY id DESC").all(),
    queue: queueRunway(),
    verify_credits_today: verifyCreditsToday(),
  });
});

// Rank-and-rent site numbers. Every upstream is wrapped inside siteStats and
// reports its own ok/error, so this route only 500s if the whole thing throws.
app.get("/api/site-stats", requireUser, async (req, res) => {
  try {
    res.json(await siteStats(String(req.query.site || "epoxy"), String(req.query.day || "")));
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/api/site-stats/sites", requireUser, (_req, res) => {
  res.json(Object.entries(SITES).map(([id, s]) => ({ id, label: s.label, domain: s.domain })));
});

app.get("/api/leads", requireUser, (req, res) => {
  // server-side status filter + search so the table shows the RIGHT leads regardless
  // of age (a 500-row cap on newest-id was hiding older emailed leads → wrong counts).
  const status = String(req.query.status || "").trim();
  const q = String(req.query.q || "").trim().toLowerCase();
  const where = [];
  const params = [];
  if (status && status !== "all") { where.push("status=?"); params.push(status); }
  if (q) {
    where.push("(lower(business_name) LIKE ? OR lower(ceo_name) LIKE ? OR lower(email) LIKE ? OR lower(city) LIKE ?)");
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  // most recent activity first (emailed leads sort by when they were emailed).
  // first_sent_at = the INITIAL cold email's timestamp — the CRM "Sent" column shows this,
  // NOT last_touch_at (which moves on every follow-up and made send dates look wrong).
  const sql = `SELECT leads.*,
      (SELECT MIN(sent_at) FROM emails WHERE emails.lead_id = leads.id AND emails.direction='out' AND emails.kind='initial') AS first_sent_at
    FROM leads ${clause} ORDER BY COALESCE(last_touch_at, scraped_at, '') DESC, id DESC LIMIT 1000`;
  res.json(db.prepare(sql).all(...params));
});

// Market rotation: which metro the engine hunts now, which are drained (read-only)
app.get("/api/markets", requireUser, (_req, res) => {
  // Same order the engine rotates in, so the dashboard list reads as the real queue.
  res.json(db.prepare("SELECT * FROM markets ORDER BY state_rank IS NULL, state_rank, priority, id").all());
});

// ── ManyChat (ig-comment-dm) keyword control panel ──────────────────────────
// Edits Ted's self-built comment→DM bot straight from the OS. Writes go to the
// bot's Google Sheet; the Modal bots pick changes up within ~30s (their cache).
app.get("/api/ig-keywords", requireUser, async (_req, res) => {
  if (!manychatConfigured()) return res.status(503).json({ error: "ManyChat service-account key not configured on this host — set MANYCHAT_SA_B64 (Railway Variables) or stage data/manychat_sa.json" });
  try {
    const [kw, activity, health] = await Promise.all([listKeywords(), recentActivity(15), botHealth()]);
    res.json({ ...kw, activity, health, warnings: findDuplicateWarnings(kw.rows) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// Ted refreshed the IG long-lived token → restart the ~60-day countdown from today.
// Without this the expiry date is frozen and the warning lies forever after a refresh.
app.post("/api/ig-token-refreshed", requireUser, (req, res) => {
  try {
    const next = markTokenRefreshed();
    logEvent({ actor: "system", message: `Instagram token marked refreshed — countdown reset, next expiry ~${next}.`, level: "success" });
    res.json({ ok: true, token_est_expiry: next });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.post("/api/ig-keywords", requireUser, async (req, res) => {
  if (!manychatConfigured()) return res.status(503).json({ error: "ManyChat service-account key not configured on this host — set MANYCHAT_SA_B64 (Railway Variables) or stage data/manychat_sa.json" });
  try {
    const r = await upsertKeyword(req.body || {});
    logEvent({ actor: "system", message: `ManyChat keyword "${String((req.body || {}).keyword || "").trim()}" ${r.updated ? "updated" : "added"} from the OS — live on IG/FB in ~30s.`, level: "success" });
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
// CRM → Google Sheet backup: manual trigger (the loop also runs every 4h)
app.post("/api/crm-backup/sync-now", requireUser, async (_req, res) => {
  try {
    const r = await runCrmBackup();
    logEvent({ actor: "system", message: `CRM backed up to Google Sheets on demand: ${r.leads} leads, ${r.emails} emails.`, level: "success" });
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/ig-keywords/:keyword", requireUser, async (req, res) => {
  if (!manychatConfigured()) return res.status(503).json({ error: "ManyChat service-account key not configured on this host — set MANYCHAT_SA_B64 (Railway Variables) or stage data/manychat_sa.json" });
  try {
    const r = await deleteKeyword(req.params.keyword);
    logEvent({ actor: "system", message: `ManyChat keyword "${req.params.keyword}" deleted from the OS.`, level: "warn" });
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Content Posted: IG/FB post performance (content.js) ─────────────────────
// Posts + their LATEST metrics snapshot, newest first, plus per-network health
// from the last refresh. Served straight from SQLite — the 90s background poll
// (or POST /refresh) is what talks to Meta, so this route is always fast.
app.get("/api/content", requireUser, (_req, res) => {
  try {
    const posts = db
      .prepare(
        `SELECT p.*, m.views, m.reach, m.likes, m.comments, m.saves, m.shares, m.captured_at AS metrics_at
         FROM content_posts p
         LEFT JOIN content_metrics m ON m.id = (
           SELECT id FROM content_metrics WHERE post_id = p.id ORDER BY captured_at DESC, id DESC LIMIT 1
         )
         ORDER BY p.posted_at DESC`
      )
      .all();
    res.json({ posts, ...contentStatus() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Full metrics time series for one post — the UI's per-card growth sparkline.
app.get("/api/content/:id/history", requireUser, (req, res) => {
  try {
    const post = db.prepare("SELECT id FROM content_posts WHERE id = ?").get(req.params.id);
    if (!post) return res.status(404).json({ error: "post not found" });
    const points = db
      .prepare(
        "SELECT captured_at, views, reach, likes, comments, saves, shares FROM content_metrics WHERE post_id = ? ORDER BY captured_at ASC, id ASC"
      )
      .all(req.params.id);
    res.json({ post_id: req.params.id, points });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Force a refresh now (shares the in-flight fetch with the 90s loop).
app.post("/api/content/refresh", requireUser, async (_req, res) => {
  try {
    res.json(await refreshContent(true));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Upcoming: every Curiosity Hook video that WILL post (upcoming.js) ───────
// Read-only. Upload-Post's schedule + wait-that-happened origin/main (never the
// working tree). ?force=1 re-checks both sources now (still throttled to 20s).
app.get("/api/upcoming", requireUser, async (req, res) => {
  try {
    res.json(await getUpcoming(req.query.force === "1"));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Approve / Skip / Request changes for a day waiting on Ted. Makes the exact
// requests/<ts>-<action>.json commit the Telegram bridge makes; respond.yml does
// the rest (and reports back on Telegram). Body: {action, feedback?}.
app.post("/api/upcoming/:day/request", requireUser, async (req, res) => {
  const { action, feedback } = req.body || {};
  try {
    const r = await sendDayRequest({ day: req.params.day, action, feedback });
    const what = action === "feedback" ? `requested changes: "${String(feedback).slice(0, 80)}"` : action === "approve" ? "approved it" : "skipped it";
    logEvent({ actor: "system", message: `Curiosity Hook ${req.params.day}: Ted ${what} from the Upcoming page (${r.file}).`, level: "info" });
    res.json(r);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Stream one upcoming video/cover to <video>/<img>. Auth via ?token= (media tags
// can't send headers), and only ids the last /api/upcoming listed are servable.
app.get("/api/upcoming/file", async (req, res) => {
  if (!sessionExists(String(req.query.token || ""))) return res.status(401).end();
  let file = resolveUpcomingFile(req.query.id);
  if (!file) return res.status(404).end();
  try {
    if (typeof file !== "string") file = await materializeBlob(file);
  } catch {
    return res.status(404).end();
  }
  const ext = path.extname(file).toLowerCase();
  const types = { ".mp4": "video/mp4", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };
  res.setHeader("Content-Type", types[ext] || "application/octet-stream");
  res.setHeader("Cache-Control", "private, max-age=600");
  const stat = fs.statSync(file);
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
  if (m) {
    const start = parseInt(m[1], 10);
    const end = m[2] ? Math.min(parseInt(m[2], 10), stat.size - 1) : stat.size - 1;
    if (start >= stat.size) return res.status(416).setHeader("Content-Range", `bytes */${stat.size}`).end();
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Length", end - start + 1);
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Length", stat.size);
    fs.createReadStream(file).pipe(res);
  }
});

// Accurate status counts over ALL leads (the CRM chips read these, not a truncated page)
app.get("/api/leads/counts", requireUser, (_req, res) => {
  const rows = db.prepare("SELECT status, COUNT(*) c FROM leads GROUP BY status").all();
  const counts = {};
  let all = 0;
  for (const r of rows) { counts[r.status] = r.c; all += r.c; }
  counts.all = all;
  res.json(counts);
});

// Lead-sourcing funnel for the Pipeline view: Apify scrape -> AnyMailFinder -> valid/dead
// -> emailed -> replied. Aggregate counts over ALL leads (not the 1000-row page cap) so
// the numbers are accurate. Shows Ted where every lead is in the pipeline + the
// AnyMailFinder attrition (why leads drop: no email found, generic/platform inbox, etc.).
app.get("/api/pipeline", requireUser, (_req, res) => {
  const es = {};
  for (const r of db.prepare("SELECT COALESCE(email_status,'unchecked') s, COUNT(*) c FROM leads GROUP BY s").all()) es[r.s] = r.c;
  const st = {};
  for (const r of db.prepare("SELECT status s, COUNT(*) c FROM leads GROUP BY s").all()) st[r.s] = r.c;
  const g = (o, k) => o[k] || 0;
  res.json({
    scraped: db.prepare("SELECT COUNT(*) c FROM leads").get().c,            // pulled from Apify
    unchecked: g(es, "unchecked"),                                          // waiting on AnyMailFinder
    checked: db.prepare("SELECT COUNT(*) c FROM leads WHERE email_status IS NOT NULL").get().c, // AnyMailFinder ran
    valid: g(es, "valid"),                                                  // real owner email found
    emailed: g(st, "emailed") + g(st, "followup_sent") + g(st, "replied"), // actually contacted
    followup_sent: g(st, "followup_sent"),
    replied: g(st, "replied"),
    // AnyMailFinder couldn't get a usable owner email
    deadBreakdown: { not_found: g(es, "not_found"), platform: g(es, "platform"), unknown: g(es, "unknown"), risky: g(es, "risky"), invalid: g(es, "invalid"), undeliverable: g(es, "undeliverable") },
    // filtered out before/around verification (dupes, geo, niche, opt-outs)
    filteredBreakdown: { dup_recipient: g(es, "dup_recipient"), off_geo: g(es, "off_geo"), duplicate: g(es, "duplicate"), off_niche: g(es, "off_niche"), suppressed: g(es, "suppressed") },
    byEmailStatus: es,
  });
});

// One lead + its full message timeline — the CRM detail view ("everything in one place")
app.get("/api/leads/:id", requireUser, (req, res) => {
  const lead = db.prepare("SELECT * FROM leads WHERE id=?").get(req.params.id);
  if (!lead) return res.status(404).json({ error: "lead not found" });
  const emails = db
    .prepare("SELECT id, inbox, direction, subject, body, kind, sent_at FROM emails WHERE lead_id=? ORDER BY id")
    .all(lead.id);
  res.json({ lead, emails });
});

// Edit the human-owned CRM fields (LinkedIn, notes, stage, …)
app.patch("/api/leads/:id", requireUser, (req, res) => {
  const editable = [
    "linkedin_url", "contact_title", "phone", "city", "state",
    "employee_size", "stage", "deal_value", "tags", "notes", "sentiment", "ceo_name",
  ];
  const body = req.body || {};
  const sets = [], vals = [];
  for (const k of editable) if (k in body) { sets.push(`${k}=?`); vals.push(body[k]); }
  if (!sets.length) return res.json({ ok: true });
  sets.push("updated_at=datetime('now')");
  vals.push(req.params.id);
  db.prepare(`UPDATE leads SET ${sets.join(", ")} WHERE id=?`).run(...vals);
  res.json({ ok: true, lead: db.prepare("SELECT * FROM leads WHERE id=?").get(req.params.id) });
});

// preview the follow-up email that's queued to go out for this lead
app.get("/api/leads/:id/followup-preview", requireUser, (req, res) => {
  const lead = db.prepare("SELECT * FROM leads WHERE id=?").get(req.params.id);
  if (!lead) return res.status(404).json({ error: "lead not found" });
  const tpl = getSetting("followup_body");
  if (!tpl) return res.json({ available: false });
  const sender = senderNameFor(lead.inbox_used || "");
  const footer = getSetting("compliance_footer");
  const subject = "Re: " + fillTemplate(getSetting("email_subject") || "", lead, sender);
  const body = fillTemplate(tpl, lead, sender) + (footer ? `\n\n${footer}` : "");
  // it only actually sends while status is 'emailed' with a due date in the future
  const scheduled = lead.status === "emailed" && !!lead.followup_due_at;
  res.json({ available: true, scheduled, subject, body, due_at: lead.followup_due_at, inbox: lead.inbox_used });
});

// (re)generate the personalized LinkedIn message for one lead, on demand
app.post("/api/leads/:id/linkedin-message", requireUser, async (req, res) => {
  const lead = db.prepare("SELECT * FROM leads WHERE id=?").get(req.params.id);
  if (!lead) return res.status(404).json({ error: "lead not found" });
  if (!lead.linkedin_url) return res.status(400).json({ error: "this lead has no LinkedIn profile" });
  try {
    const message = await generateLinkedInMessage(lead);
    db.prepare("UPDATE leads SET linkedin_message=? WHERE id=?").run(message, lead.id);
    res.json({ ok: true, message });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── HOT LEADS: leads that replied — thread view, manual reply, AI draft ───────
// All logic lives in hotleads.js (same feature-module pattern as igkeywords.js);
// these routes stay thin. Nothing here auto-sends: /reply fires only on an
// explicit POST after the UI confirm, /draft returns text and can never send.
app.get("/api/hot-leads", requireUser, (_req, res) => {
  try {
    res.json(listHotLeads());
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/hot-leads/:id/thread", requireUser, (req, res) => {
  try {
    const t = hotLeadThread(Number(req.params.id));
    if (!t) return res.status(404).json({ error: "lead not found" });
    res.json(t);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Reply uploads: files Ted attaches to a Hot Leads reply. multipart/form-data
// (multer/path/fs imports are hoisted, so they're usable here even though they
// appear further down the file). 25 MB/file, 5 files — email-sized.
// NOTE: the dir is resolved INSIDE destination() at request time — __dirname2 is
// a const defined later in this module (TDZ at load time up here).
const _replyUpload = multer({
  storage: multer.diskStorage({
    destination(_req, _file, cb) {
      const dir = path.join(process.env.DATA_DIR || path.join(__dirname2, "..", "data"), "uploads", "replies");
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename(_req, file, cb) {
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
      cb(null, `${Date.now()}_${safe}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024, files: 5 },
});

app.post("/api/hot-leads/:id/reply", requireUser, _replyUpload.array("files", 5), async (req, res) => {
  try {
    const attachments = (req.files || []).map((f) => ({
      path: f.path,
      filename: f.originalname.replace(/[^a-zA-Z0-9._ -]/g, "_"),
      contentType: f.mimetype || "application/octet-stream",
    }));
    const r = await hotLeadSendReply(Number(req.params.id), (req.body || {}).body, attachments);
    res.json(r);
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: String(e.message || e) });
  }
});

app.post("/api/hot-leads/:id/draft", requireUser, async (req, res) => {
  try {
    const { instructions, draft } = req.body || {};
    const r = await hotLeadDraftReply(Number(req.params.id), instructions, draft);
    res.json(r);
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: String(e.message || e) });
  }
});

// Every email ever sent or received, with the business it belongs to.
app.get("/api/emails", requireUser, (req, res) => {
  res.json(
    db
      .prepare(
        `SELECT e.id, e.lead_id, e.inbox, e.direction, e.subject, e.body, e.kind, e.sent_at,
                l.business_name, l.email AS lead_email
         FROM emails e LEFT JOIN leads l ON l.id = e.lead_id
         ORDER BY e.id DESC LIMIT 2000`
      )
      .all()
  );
});

// Send stats: new-leads-emailed and follow-ups, broken down by DAY and by INBOX, so the
// operator can see "how many leads are we sending" at a glance instead of decoding status
// chips. All in ET (dates are stored UTC; convert with the same TZ the rest of the UI uses).
app.get("/api/email-stats", requireUser, (_req, res) => {
  // per ET-day for the last 30 days
  const byDay = db
    .prepare(
      `SELECT date(sent_at, '-4 hours') AS day,
              SUM(CASE WHEN kind='initial'  THEN 1 ELSE 0 END) AS new_leads,
              SUM(CASE WHEN kind='followup' THEN 1 ELSE 0 END) AS followups,
              SUM(CASE WHEN direction='in'  THEN 1 ELSE 0 END) AS replies
       FROM emails
       WHERE direction IN ('out','in') AND (kind IN ('initial','followup') OR direction='in')
         AND subject NOT LIKE '%[TEST%'
         AND date(sent_at, '-4 hours') >= date('now','-30 days','-4 hours')
       GROUP BY day ORDER BY day DESC`
    )
    .all();
  // per inbox, today (ET) — new leads vs follow-ups from each of your sending accounts
  const byInboxToday = db
    .prepare(
      `SELECT inbox,
              SUM(CASE WHEN kind='initial'  THEN 1 ELSE 0 END) AS new_leads,
              SUM(CASE WHEN kind='followup' THEN 1 ELSE 0 END) AS followups,
              COUNT(*) AS total
       FROM emails
       WHERE direction='out' AND subject NOT LIKE '%[TEST%'
         AND date(sent_at, '-4 hours') = date('now','-4 hours')
       GROUP BY inbox ORDER BY total DESC`
    )
    .all();
  // all-time totals
  const totals = db
    .prepare(
      `SELECT SUM(CASE WHEN kind='initial'  THEN 1 ELSE 0 END) AS new_leads,
              SUM(CASE WHEN kind='followup' THEN 1 ELSE 0 END) AS followups
       FROM emails WHERE direction='out' AND subject NOT LIKE '%[TEST%'`
    )
    .get();
  res.json({ byDay, byInboxToday, totals });
});

// One-time data migration: local instance pushes its leads + email history up.
// ── ESCAPE HATCH ────────────────────────────────────────────────────────────
// Once the cloud is the source of truth there must be a way to get the data back.
// VACUUM INTO writes a consistent snapshot even under WAL and needs no sqlite3 CLI
// (the alpine image has none). Written inside DATA_DIR so it lands on the volume,
// not the container's ephemeral layer, and unlinked as soon as it is streamed.
app.get("/api/admin/export-db", requireUser, (req, res) => {
  const dir = process.env.DATA_DIR || path.join(__dirname2, "..", "data");
  const dest = path.join(dir, `export-${Date.now()}.db`);
  try {
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  } catch (e) {
    return res.status(500).json({ error: `snapshot failed: ${e.message}` });
  }
  res.download(dest, "tedca-os-export.db", () => {
    try { fs.unlinkSync(dest); } catch { /* best effort */ }
  });
});

// Tables the 30s leads/emails/runs mirror never carried. Suppressions are the one
// that matters most: they are the ONLY permanent opt-out record, and emailing a
// suppressed address is a compliance problem, not just a bug.
app.post("/api/admin/import-aux", requireUser, (req, res) => {
  const { suppressions = [], settings = [], seen_messages = [], replace_seen = false } = req.body || {};
  const out = {};
  try {
    db.exec("BEGIN IMMEDIATE");
    if (suppressions.length) {
      const st = db.prepare("INSERT OR IGNORE INTO suppressions (email, ts) VALUES (?, ?)");
      let n = 0;
      for (const r of suppressions) n += st.run(String(r.email).toLowerCase(), r.ts || null).changes;
      out.suppressions = n;
    }
    if (settings.length) {
      const st = db.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
      // never import another instance's send-lock or day-claim
      const SKIP = new Set(["send_owner", "last_auto_run_date", "last_login_at", "prev_login_at", "crm_backup_last", "crm_backup_counts"]);
      let n = 0;
      for (const r of settings) { if (SKIP.has(r.key)) continue; st.run(r.key, String(r.value)); n++; }
      out.settings = n;
    }
    if (seen_messages.length) {
      // replace_seen makes the cloud's reply-dedup state EXACTLY match the Mac's.
      // The cloud's own copy is poisoned: it recorded replies that the mirror then
      // erased, so those messages are marked seen but their rows are gone.
      if (replace_seen) db.exec("DELETE FROM seen_messages");
      const st = db.prepare("INSERT OR IGNORE INTO seen_messages (id, ts) VALUES (?, ?)");
      let n = 0;
      for (const r of seen_messages) n += st.run(r.id, r.ts || null).changes;
      out.seen_messages = n;
    }
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    return res.status(500).json({ error: e.message });
  }
  logEvent({ actor: "system", message: `Aux import: ${JSON.stringify(out)}`, level: "info" });
  res.json({ ok: true, ...out });
});

app.post("/api/admin/import-data", requireUser, (req, res) => {
  const { leads = [], emails = [], runs = [], replace = false } = req.body || {};

  // Clean-mirror mode: wipe the cloud's stale copy and import the Mac's real data
  // verbatim (original ids kept, all matching columns), so the cloud dashboard reflects
  // the live campaign exactly — including the runs table that drives the "last run" card.
  if (replace) {
    const colsOf = (t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
    const imp = (table, rows) => {
      const ok = colsOf(table);
      let n = 0;
      for (const row of rows) {
        const keys = Object.keys(row).filter((k) => ok.has(k));
        if (!keys.length) continue;
        db.prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map((k) => row[k]));
        n++;
      }
      return n;
    };
    // remember what we had so the 30s sync only logs when the mirror actually changed
    // (otherwise the activity feed drowns in identical "Clean mirror" lines all day)
    const before = {
      leads: db.prepare("SELECT COUNT(*) c FROM leads").get().c,
      emails: db.prepare("SELECT COUNT(*) c FROM emails").get().c,
      runs: db.prepare("SELECT COUNT(*) c FROM runs").get().c,
    };
    db.exec("DELETE FROM emails; DELETE FROM leads; DELETE FROM runs;");
    const lc = imp("leads", leads), ec = imp("emails", emails), rc = imp("runs", runs);
    if (lc !== before.leads || ec !== before.emails || rc !== before.runs) {
      logEvent({ actor: "system", message: `Clean mirror from the Mac: ${lc} leads, ${ec} emails, ${rc} runs.`, level: "success" });
    }
    return res.json({ ok: true, leads: lc, emails: ec, runs: rc, replace: true });
  }

  let li = 0;
  const insertLead = db.prepare(`
    INSERT INTO leads (business_name, domain, category, rating, review_count, website, email, email_status, source, scraped_at, status, inbox_used, last_touch_at, banked, followup_due_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const exists = db.prepare("SELECT id FROM leads WHERE business_name=? AND (domain=? OR (domain IS NULL AND ? IS NULL))");
  const idMap = {};
  for (const l of leads) {
    const found = exists.get(l.business_name, l.domain, l.domain);
    if (found) {
      idMap[l.id] = found.id;
      continue;
    }
    const info = insertLead.run(
      l.business_name, l.domain, l.category, l.rating, l.review_count, l.website, l.email,
      l.email_status, l.source, l.scraped_at, l.status, l.inbox_used, l.last_touch_at,
      l.banked ?? 0, l.followup_due_at
    );
    idMap[l.id] = Number(info.lastInsertRowid);
    li++;
  }
  let ei = 0;
  const insertEmail = db.prepare(
    "INSERT INTO emails (lead_id, inbox, direction, subject, body, kind, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  for (const e of emails) {
    insertEmail.run(e.lead_id != null ? idMap[e.lead_id] ?? null : null, e.inbox, e.direction, e.subject, e.body, e.kind, e.sent_at);
    ei++;
  }
  logEvent({ actor: "system", message: `History migrated from the Mac: ${li} leads, ${ei} emails imported.`, level: "success" });
  res.json({ ok: true, leads: li, emails: ei });
});

// One-time token import so the cloud instance inherits the locally-authorized inboxes.
app.post("/api/gmail/import-tokens", requireUser, (req, res) => {
  const { tokens } = req.body || {};
  if (!tokens || typeof tokens !== "object") return res.status(400).json({ error: "tokens object required" });
  const count = importTokens(tokens);
  logEvent({ actor: "send", message: `Inbox authorizations imported for ${count} inboxes.`, level: "success" });
  res.json({ ok: true, count });
});

// Cloud bootstrap: receive the Zapmail (SMTP) inbox credentials from the local instance
app.post("/api/smtp/import-inboxes", requireUser, (req, res) => {
  const { inboxes } = req.body || {};
  if (!inboxes || typeof inboxes !== "object") return res.status(400).json({ error: "inboxes object required" });
  const count = importSmtpInboxes(inboxes);
  logEvent({ actor: "send", message: `Zapmail inbox credentials imported for ${count} inboxes.`, level: "success" });
  res.json({ ok: true, count });
});

// Job history — every skill/scrape job with status + result (the "scoreboard")
app.get("/api/jobs", requireUser, (req, res) => {
  res.json(
    db
      .prepare(
        "SELECT id, run_id, type, params, status, result, created_at, claimed_at, finished_at FROM jobs ORDER BY id DESC LIMIT 200"
      )
      .all()
  );
});

app.get("/api/runs", requireUser, (req, res) => {
  res.json(db.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT 100").all());
});

app.get("/api/clients", requireUser, (req, res) => {
  res.json(db.prepare("SELECT * FROM clients ORDER BY id DESC LIMIT 500").all());
});

app.get("/api/settings", requireUser, (req, res) => {
  const rows = db.prepare("SELECT key, value FROM settings").all();
  res.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
});

app.put("/api/settings", requireUser, (req, res) => {
  const upsert = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  );
  for (const [k, v] of Object.entries(req.body || {})) upsert.run(k, String(v));
  res.json({ ok: true });
});

// ---- Gmail -----------------------------------------------------------------
app.get("/api/gmail/status", requireUser, (req, res) => {
  const gmail = authorizedInboxes().map((i) => ({ ...i, transport: "gmail" }));
  // Zapmail inboxes auth by app password — always "connected", with today's ramp cap
  const smtp = smtpInboxMeta().map((m) => ({
    email: m.email,
    authorized: true,
    transport: "smtp",
    cap: m.cap,
    firstName: m.firstName,
  }));
  res.json({
    configured: gmailConfigured() || smtp.length > 0,
    inboxes: [...gmail, ...smtp],
    test_recipient: process.env.TEST_RECIPIENT || null,
  });
});

app.post("/api/gmail/auth", requireUser, async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: "email required" });
  try {
    const { authUrl, result } = await startAuth(email);
    logEvent({ actor: "send", message: `Authorization started for ${email} — waiting for Google consent`, level: "info" });
    result.then((r) => {
      logEvent({
        actor: "send",
        message: r.ok ? `Inbox connected: ${r.email}` : `Authorization failed: ${r.error}`,
        level: r.ok ? "success" : "error",
      });
    });
    res.json({ authUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/gmail/test-send", requireUser, async (req, res) => {
  const to = (req.body || {}).to || process.env.TEST_RECIPIENT;
  if (!to) return res.status(400).json({ error: "no recipient — set TEST_RECIPIENT in .env or pass `to`" });
  // respect send_transport so a manual test never fires from a muted transport
  // (e.g. the 5 Gmail inboxes stay silent while send_transport=smtp)
  const transport = getSetting("send_transport");
  const ready = sendingInboxes().filter((i) => !transport || transport === i.transport);
  if (!ready.length) return res.status(400).json({ error: "no connected inboxes yet" });
  const results = [];
  for (const { email } of ready) {
    try {
      logEvent({ actor: "send", message: `Sending test email from ${email} → ${to}`, level: "info" });
      const r = await sendVia({
        from: email,
        to,
        subject: `Tedca OS test — ${email}`,
        body: `This is a test email from Tedca OS.\n\nInbox: ${email}\nTime: ${new Date().toISOString()}\n\nIf you're reading this, sending works.`,
      });
      db.prepare(
        "INSERT INTO emails (lead_id, inbox, direction, subject, body, kind, sent_at) VALUES (NULL, ?, 'out', ?, ?, 'test', datetime('now'))"
      ).run(email, `Tedca OS test — ${email}`, `test to ${to}`);
      logEvent({ actor: "send", message: `Test email sent from ${email} (id ${r.id})`, level: "success" });
      results.push({ email, ok: true, id: r.id });
    } catch (e) {
      logEvent({ actor: "send", message: `Test send FAILED from ${email}: ${e.message}`, level: "error" });
      results.push({ email, ok: false, error: e.message });
    }
  }
  res.json({ results });
});

// ---- morning run + job queue -------------------------------------------------
// ── LEAD INTAKE — "feed it leads, it does the rest" ─────────────────────────
// Ted feeds a file / paste / Sheet; preview shows the column mapping, the dupes,
// and what it will cost in AnyMailFinder credits BEFORE anything is inserted. The
// Import click is the spend approval (workspace rule: ask before spending).
// memoryStorage: a lead CSV is small and we never want it lingering on disk.
const _intakeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 }, // 10 MB is ~80k lead rows
});

app.post("/api/intake/preview", requireUser, (req, res) => {
  _intakeUpload.single("file")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    try {
      let parsed;
      if (req.file) parsed = intakeParseUpload(req.file.buffer, req.file.originalname);
      else if ((req.body || {}).sheet_url) parsed = await intakeReadSheet(req.body.sheet_url);
      else if ((req.body || {}).text) parsed = intakeParseText(req.body.text);
      else return res.status(400).json({ error: "Send a file, a sheet_url, or pasted text." });
      res.json(intakePreview(parsed));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
});

// Re-run the preview with Ted's corrected column mapping (no re-upload).
app.post("/api/intake/remap", requireUser, (req, res) => {
  const { token, mapping } = req.body || {};
  if (!token || !mapping) return res.status(400).json({ error: "token and mapping required" });
  try {
    res.json(intakeRemap(token, mapping));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/intake/commit", requireUser, async (req, res) => {
  const { token, ...opts } = req.body || {};
  if (!token) return res.status(400).json({ error: "token required (preview first)" });
  try {
    res.json(await intakeCommit(token, opts));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Run one verify-ahead pass right now (the Feed page's "verify now" button, and QA).
// Not `force`: verify_ahead_enabled stays a real kill switch. The tick is bounded by
// verify_max_per_tick, so this returns instead of hanging the browser on a big queue.
app.post("/api/intake/verify-now", requireUser, async (req, res) => {
  try {
    const out = await verifyAheadTick();
    res.json({ ...out, queue: queueRunway() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/batches", requireUser, (req, res) => {
  res.json({ batches: listBatches(), queue: queueRunway(), credits_today: verifyCreditsToday(), credits_budget: Number(getSetting("verify_daily_budget_credits") || 200) });
});

app.patch("/api/batches/:id", requireUser, (req, res) => {
  try {
    const b = updateBatch(Number(req.params.id), req.body || {});
    res.json({ batch: b, queue: queueRunway() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/batches/:id", requireUser, (req, res) => {
  const b = getBatch(Number(req.params.id));
  if (!b) return res.status(404).json({ error: "batch not found" });
  res.json({ batch: b });
});

app.post("/api/run/morning", requireUser, async (req, res) => {
  const target = Math.max(1, Math.min(Number((req.body || {}).target || 10), 500));
  const query = (req.body || {}).query || null;
  try {
    // MUST await: startMorningRun is async and throws when a run is already active.
    // Without await that throw becomes an unhandled rejection (Node exits by default)
    // and run_id serializes to {}. Awaiting catches it cleanly → proper 409.
    const runId = await startMorningRun({ target, query });
    if (!runId) {
      // stood down on purpose (empty queue / no fresh city) — say which, don't fake success
      const q = queueCounts();
      const reason = q.ready === 0 && q.pending === 0
        ? "The lead queue is empty. Feed a CSV, a paste, or a Google Sheet on the Feed Leads page and run again."
        : "Stood down for today — see the activity feed for the reason.";
      return res.status(409).json({ error: reason, queue: queueRunway() });
    }
    res.json({ run_id: runId });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

app.get("/api/run/status", requireUser, (req, res) => {
  res.json({
    running_run_id: runningRunId(),
    test_mode: getSetting("test_mode") === "1",
    niche: getSetting("niche"),
    city: getSetting("city"),
  });
});

// Worker claims the oldest queued job.
app.post("/api/worker/jobs/claim", requireWorker, (req, res) => {
  const job = db.prepare("SELECT * FROM jobs WHERE status='queued' ORDER BY id LIMIT 1").get();
  if (!job) return res.json({ job: null });
  db.prepare("UPDATE jobs SET status='claimed', claimed_at=datetime('now') WHERE id=?").run(job.id);
  res.json({ job: { ...job, params: JSON.parse(job.params) } });
});

app.post("/api/worker/jobs/:id/complete", requireWorker, (req, res) => {
  const { ok, result } = req.body || {};
  db.prepare("UPDATE jobs SET status=?, result=?, finished_at=datetime('now') WHERE id=?").run(
    ok ? "done" : "failed",
    typeof result === "string" ? result : JSON.stringify(result ?? null),
    req.params.id
  );
  // Reliable server-side notification — the Mac worker's own Telegram call can silently miss.
  try {
    const LABELS = {
      agentos_post_revise: "Post re-render", motion_graphic: "Motion graphic", video_edit: "Video edit",
      heygen_video: "Avatar video",
      agentos_post: "AgentOS post", edu_post: "Educational post", livephoto: "Live Photo", carousel: "Carousel",
    };
    const job = db.prepare("SELECT type FROM jobs WHERE id=?").get(req.params.id);
    const label = LABELS[job?.type];
    if (label) {
      const base = process.env.PUBLIC_URL || "https://tedca-os-production.up.railway.app";
      sendTelegram(ok ? `✅ ${label} is done — view & play it in Jobs:\n${base}/jobs` : `❌ ${label} failed. Check Jobs:\n${base}/jobs`).catch(() => {});
    }
  } catch { /* never block completion on a notify error */ }
  res.json({ ok: true });
});

// ---- one-click skills ---------------------------------------------------------
// Step 1: write (or revise) the script — NO audio is generated here.
app.post("/api/skills/avatar-video/script", requireUser, async (req, res) => {
  const { topic, previous, notes } = req.body || {};
  if (!topic && !previous) return res.status(400).json({ error: "topic required" });
  try {
    logEvent({
      actor: "research",
      message: previous ? "Avatar Video: revising the script with your notes…" : `Avatar Video: writing the script for "${topic}"…`,
      level: "info",
    });
    const script = await avatarVideoScript(topic, { previous, notes });
    logEvent({ actor: "research", message: "Avatar Video: script ready for your review — no audio made yet.", level: "success" });
    res.json({ script });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Step 2: user approved the script — make the voice (cloud if possible) and deliver.
app.post("/api/skills/avatar-video/voice", requireUser, async (req, res) => {
  const { script, topic = "" } = req.body || {};
  if (!script) return res.status(400).json({ error: "script required" });
  try {
    if (elevenConfigured()) {
      // fully cloud: generate here, deliver to the phone via Telegram
      logEvent({ actor: "research", message: "Avatar Video: script approved — generating the voice in the cloud…", level: "info" });
      const audio = await generateVoice({ text: script, voice: VOICE_AVATAR });
      const name = `avatar_vo_${Date.now()}.mp3`;
      const outDir = path.join(process.env.DATA_DIR || path.join(__dirname2, "..", "data"), "output");
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, name), audio);
      const delivered = await sendTelegramFile(audio, name, `🎙 Avatar VO — ${topic}\n\n${script.slice(0, 700)}`, "audio");
      logEvent({ actor: "research", message: `Avatar Video: voice ready${delivered ? " — sent to your Telegram" : ""} (${name}).`, level: "success" });
      return res.json({ delivered: delivered ? "telegram" : "saved", file: name });
    }
    // fallback: no ElevenLabs key in this environment — queue for the Mac worker
    const jobId = queueTts({ text: script, voice: VOICE_AVATAR, outName: `avatar_vo_${Date.now()}` });
    logEvent({ actor: "research", message: "Avatar Video: script approved — generating the voice on your Mac (queued).", level: "success" });
    res.json({ job_id: jobId });
  } catch (e) {
    logEvent({ actor: "research", message: `Avatar Video failed: ${e.message}`, level: "error" });
    res.status(500).json({ error: e.message });
  }
});

// ---- Personal Ted Video: his cloned voice + iterative voice-revision session --
// Every generated take (v1, v2, v3...) is auto-sent to Telegram (audio) and the
// version history is persisted so the UI can show v1/v2/v3 with their notes.

// Generate one take in Ted's cloned voice and deliver it. Cloud when ElevenLabs
// is configured (sends to Telegram here), else queue the Mac worker (it delivers
// to Telegram on completion). Returns the shape the session/version list needs.
async function makePersonalVoice({ script, speed, version, note, topic }) {
  const outDir = path.join(process.env.DATA_DIR || path.join(__dirname2, "..", "data"), "output");
  const capNote = note ? ` (your note: ${note})` : "";
  const caption = `🎙 Personal Ted Video · v${version}${capNote}\n\n${String(script).slice(0, 700)}`;
  if (elevenConfigured()) {
    const audio = await generateVoice({ text: script, voice: VOICE_PERSONAL, speed });
    const name = `personal_vo_v${version}_${Date.now()}.mp3`;
    fs.mkdirSync(outDir, { recursive: true });
    const abs = path.join(outDir, name);
    fs.writeFileSync(abs, audio);
    const delivered = await sendTelegramFile(audio, name, caption, "audio");
    return { mode: "cloud", version, speed, file: name, path: abs, delivered: delivered ? "telegram" : "saved" };
  }
  // fallback: no ElevenLabs key here — the Mac worker generates and Telegrams it
  const outName = `personal_vo_v${version}_${Date.now()}`;
  const jobId = queueTts({ text: script, voice: VOICE_PERSONAL, outName, speed });
  return { mode: "mac", version, speed, job_id: jobId, delivered: "mac" };
}

// Step 1: write the script from a topic, OR use pasted script text EXACTLY as-is.
app.post("/api/skills/personal-video/script", requireUser, async (req, res) => {
  const { topic, script, asIs, previous, notes } = req.body || {};
  try {
    if (previous && notes) {
      logEvent({ actor: "research", message: "Personal Ted Video: revising the script with your notes…", level: "info" });
      const out = await personalVideoScript(topic, { previous, notes });
      logEvent({ actor: "research", message: "Personal Ted Video: script revised, review it. No audio yet.", level: "success" });
      return res.json({ script: out });
    }
    if (script && (asIs || !topic)) {
      // Ted pasted his own words — honor them exactly, no LLM rewrite. A bare script
      // with no topic always means "use my words" even if the client forgot asIs.
      logEvent({ actor: "research", message: "Personal Ted Video: using your pasted script exactly as given.", level: "success" });
      return res.json({ script });
    }
    if (!topic) return res.status(400).json({ error: "topic or script required" });
    logEvent({ actor: "research", message: `Personal Ted Video: writing the script for "${topic}"…`, level: "info" });
    const out = await personalVideoScript(topic);
    logEvent({ actor: "research", message: "Personal Ted Video: script ready for your review. No audio yet.", level: "success" });
    res.json({ script: out });
  } catch (e) {
    logEvent({ actor: "research", message: `Personal Ted Video script failed: ${e.message}`, level: "error" });
    res.status(500).json({ error: e.message });
  }
});

// Step 2: approve the script -> generate v1 in his cloned voice at natural speed 1.0.
app.post("/api/skills/personal-video/voice", requireUser, async (req, res) => {
  const { script, topic = "" } = req.body || {};
  if (!script) return res.status(400).json({ error: "script required" });
  try {
    logEvent({ actor: "research", message: "Personal Ted Video: script approved, generating v1 in your cloned voice at natural pace…", level: "info" });
    const speed = 1.0; // his clone reads fast — natural, not the 1.20 avatar default
    const out = await makePersonalVoice({ script, speed, version: 1, note: "", topic });
    const state = {
      topic,
      script,
      speed,
      versions: [
        { version: 1, note: "", speed, file: out.file || null, path: out.path || null, job_id: out.job_id || null, mode: out.mode, delivered: out.delivered },
      ],
    };
    pvSave(state);
    logEvent({
      actor: "research",
      message: `Personal Ted Video: v1 ready${out.delivered === "telegram" ? ", sent to your Telegram" : out.mode === "mac" ? ", generating on your Mac (queued)" : ""}.`,
      level: "success",
    });
    res.json({ version: 1, ...out });
  } catch (e) {
    logEvent({ actor: "research", message: `Personal Ted Video failed: ${e.message}`, level: "error" });
    res.status(500).json({ error: e.message });
  }
});

// Step 3 (repeatable): a free-text note -> apply it (rewrite script and/or change
// speed) -> regenerate -> auto-send the new version to Telegram.
app.post("/api/skills/personal-video/revise", requireUser, async (req, res) => {
  const { note } = req.body || {};
  if (!note) return res.status(400).json({ error: "note required" });
  const state = pvLoad();
  if (!state || !Array.isArray(state.versions) || !state.versions.length) {
    return res.status(400).json({ error: "no active session — generate v1 first" });
  }
  try {
    logEvent({ actor: "research", message: `Personal Ted Video: applying your note "${note}"…`, level: "info" });
    const revised = await reviseTedVoice({ script: state.script, note, speed: state.speed ?? 1.0 });
    const version = state.versions.length + 1;
    const out = await makePersonalVoice({ script: revised.script, speed: revised.speed, version, note, topic: state.topic || "" });
    state.script = revised.script;
    state.speed = revised.speed;
    state.versions.push({ version, note, speed: revised.speed, file: out.file || null, path: out.path || null, job_id: out.job_id || null, mode: out.mode, delivered: out.delivered });
    pvSave(state);
    logEvent({
      actor: "research",
      message: `Personal Ted Video: v${version} ready${out.delivered === "telegram" ? ", sent to your Telegram" : out.mode === "mac" ? ", generating on your Mac (queued)" : ""}.`,
      level: "success",
    });
    res.json({ version, ...out });
  } catch (e) {
    logEvent({ actor: "research", message: `Personal Ted Video revision failed: ${e.message}`, level: "error" });
    res.status(500).json({ error: e.message });
  }
});

// Current session (version history) so the UI can render v1/v2/v3 with their notes.
app.get("/api/skills/personal-video/session", requireUser, (req, res) => {
  res.json(pvLoad() || { versions: [] });
});

app.post("/api/skills/livephoto/topics", requireUser, async (req, res) => {
  try {
    logEvent({ actor: "research", message: "Live Photo: hunting for topics you haven't covered yet…", level: "info" });
    const topics = await suggestLivephotoTopics();
    res.json({ topics });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/skills/livephoto/run", requireUser, async (req, res) => {
  const { topic } = req.body || {};
  if (!topic) return res.status(400).json({ error: "topic required" });
  try {
    const jobId = queueLivephoto(topic);
    markTopicDone(topic);
    logEvent({ actor: "research", message: `Live Photo: queued the full build for "${topic}" — your Mac is writing the slides, rendering the 3s loops at 2160x2700 and minting the Live Photos into Photos.app.`, level: "info" });
    res.json({ job_id: jobId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/skills/carousel", requireUser, async (req, res) => {
  const { topic } = req.body || {};
  if (!topic) return res.status(400).json({ error: "topic required" });
  try {
    const jobId = queueCarousel(topic);
    logEvent({ actor: "research", message: `Carousel: queued the full render for "${topic}" — your Mac is writing the copy, animating slide 1 and rendering slides 2-6.`, level: "info" });
    res.json({ job_id: jobId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/skills/job/:id", requireUser, (req, res) => {
  res.json(jobStatus(req.params.id) || { error: "not found" });
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

// ---- static frontend (cloud: one URL serves the app) -------------------------
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import multer from "multer";
import { execFile as _execFile } from "node:child_process";
const __dirname2 = path.dirname(fileURLToPath(import.meta.url));

// ── serve generated output (videos/images) so the dashboard can play them ────
const WORKSPACE = path.resolve(__dirname2, "..", "..", ".."); // Ted Workspace root
const MEDIA_ROOTS = [
  path.resolve(__dirname2, "..", "..", "output"), // tedca-os/output
  path.resolve(process.env.DATA_DIR || path.join(__dirname2, "..", "data"), "output"),
  path.resolve(__dirname2, "..", "..", ".tmp"),
  path.join(WORKSPACE, "agentos", "posts"), // AgentOS post slides (.mp4)
  path.join(WORKSPACE, "tiktok-livephoto", "runs"), // Live Photo .mov pairs
  path.join(WORKSPACE, ".tmp"),
];
const withinRoots = (abs) => MEDIA_ROOTS.some((r) => abs === r || abs.startsWith(r + path.sep));
const MEDIA_KIND = {
  ".mp4": "video", ".mov": "video", ".webm": "video", ".m4v": "video",
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image", ".gif": "image",
};

// stream a generated file (path-traversal guarded to the output roots only)
app.get("/api/file", requireUser, (req, res) => {
  const abs = path.resolve(String(req.query.p || ""));
  if (!withinRoots(abs)) return res.status(403).json({ error: "forbidden" });
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return res.status(404).json({ error: "not found" });
  res.sendFile(abs); // express handles Range requests → video seeking works
});

// the playable artifacts a job produced (parsed out of its result JSON)
app.get("/api/jobs/:id/media", requireUser, (req, res) => {
  const job = db.prepare("SELECT result FROM jobs WHERE id=?").get(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  let r = {};
  try { r = JSON.parse(job.result || "{}"); } catch { /* not json */ }
  const cands = [];
  for (const k of ["path", "post_html", "mp4", "video"]) if (typeof r[k] === "string") cands.push(r[k]);
  for (const k of ["live", "files", "slides", "outputs", "images"]) if (Array.isArray(r[k])) cands.push(...r[k].filter((x) => typeof x === "string"));
  for (const k of ["outDir", "outdir", "dir", "folder"]) {
    const d = r[k];
    if (typeof d === "string") {
      try { if (fs.statSync(d).isDirectory()) for (const f of fs.readdirSync(d)) cands.push(path.join(d, f)); } catch { /* gone */ }
    }
  }
  const seen = new Set(), files = [];
  for (const c of cands) {
    try {
      const abs = path.resolve(c);
      if (seen.has(abs) || !withinRoots(abs) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
      const kind = MEDIA_KIND[path.extname(abs).toLowerCase()];
      if (!kind) continue;
      seen.add(abs);
      files.push({ name: path.basename(abs), kind, path: abs, url: "/api/file?p=" + encodeURIComponent(abs) });
    } catch { /* skip */ }
  }
  res.json({ files, folder: r.folder || r.outDir || r.outdir || null });
});

// ── Post Editor: preview copy changes (cheap), then render the new slides ─────
async function llmPostPreview(creative, notes) {
  const key = process.env.OPENROUTER_API_KEY || "";
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "anthropic/claude-sonnet-4.5",
      max_tokens: 900,
      messages: [
        {
          role: "user",
          content: `Here is the copy JSON for a multi-slide Instagram carousel:\n"""${JSON.stringify(creative)}"""\n\nThe user wants these changes:\n${notes}\n\nApply ONLY the requested changes, keeping the same punchy style and staying truthful. Output ONLY JSON:\n{"slides":[{"n":1,"text":"the new visible text for slide 1, plain"}, ...]} — one entry per slide showing exactly the new wording.`,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`preview LLM failed: ${res.status}`);
  let txt = ((await res.json()).choices?.[0]?.message?.content || "{}").trim().replace(/^```json\s*|\s*```$/g, "");
  try { return JSON.parse(txt).slides || []; } catch { return []; }
}

// show what the copy will become — no render yet
app.post("/api/posts/preview", requireUser, async (req, res) => {
  const { folder, notes } = req.body || {};
  if (!folder) return res.status(400).json({ error: "folder required" });
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(path.resolve(folder), "meta.json"), "utf8"));
    const noteLines = [
      notes?.overall ? `Overall: ${notes.overall}` : "",
      ...Object.entries(notes?.slides || {}).filter(([, v]) => v && v.trim()).map(([k, v]) => `Slide ${k}: ${v}`),
    ].filter(Boolean).join("\n");
    if (!noteLines.trim()) return res.json({ slides: [], note: "no changes entered" });
    res.json({ slides: await llmPostPreview(meta.creative || meta, noteLines) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// send one generated file (e.g. a single slide) to Telegram on demand
app.post("/api/telegram/send-file", requireUser, async (req, res) => {
  const abs = path.resolve(String((req.body || {}).path || ""));
  if (!withinRoots(abs)) return res.status(403).json({ error: "forbidden" });
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return res.status(404).json({ error: "not found" });
  const ext = path.extname(abs).toLowerCase();
  const kind = [".mp4", ".mov", ".m4v", ".webm"].includes(ext) ? "video"
    : [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext) ? "photo" : "document";
  try {
    const { width, height } = req.body || {};
    const dims = Number(width) > 0 && Number(height) > 0 ? { width: Number(width), height: Number(height) } : null;
    const ok = await sendTelegramFile(fs.readFileSync(abs), path.basename(abs), (req.body || {}).caption || "", kind, dims);
    res.json({ ok });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// render the new version (Mac worker agent applies copy + re-renders the slides)
app.post("/api/posts/revise", requireUser, (req, res) => {
  const { folder, notes } = req.body || {};
  if (!folder) return res.status(400).json({ error: "folder required" });
  const info = db.prepare("INSERT INTO jobs (type, params, status) VALUES ('agentos_post_revise', ?, 'queued')").run(JSON.stringify({ folder, notes }));
  logEvent({ actor: "research", message: `Post Editor: queued a re-render of ${path.basename(folder)} with your changes.`, level: "info" });
  res.json({ job_id: Number(info.lastInsertRowid) });
});

const distDir = process.env.APP_DIST || path.join(__dirname2, "..", "..", "app", "dist");
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  // SPA fallback for client-side routes (anything not /api or /ws)
  app.get(/^\/(?!api\/|ws).*/, (req, res) => res.sendFile(path.join(distDir, "index.html")));
  console.log(`serving frontend from ${distDir}`);
}

// ---- agentos skill store ---------------------------------------------------
const AGENTOS_ROOT = path.resolve(__dirname2, "..", "..", "..");

function _agentosReadSkills() {
  try {
    return (
      JSON.parse(fs.readFileSync(path.join(AGENTOS_ROOT, "agentos", "skills.json"), "utf8"))
        .skills || []
    );
  } catch {
    return [];
  }
}

function _agentosInsertJob(type, params) {
  const info = db
    .prepare("INSERT INTO jobs (type, params, status) VALUES (?, ?, 'queued')")
    .run(type, JSON.stringify(params));
  return Number(info.lastInsertRowid);
}

const _KW_RE = /^[a-z0-9]+$/;
const _KW_RESERVED = new Set(["auto"]);

app.get("/api/agentos/skills", requireUser, (_req, res) => {
  res.json(_agentosReadSkills());
});

// Returns all agentos_post and agentos_new_skill jobs that are still in-flight
// (queued or claimed). The UI fetches this on mount to re-attach poll loops for
// any jobs that survived a page refresh or server restart.
app.get("/api/agentos/jobs/active", requireUser, (req, res) => {
  const rows = db
    .prepare(
      "SELECT id, type, status, params, created_at FROM jobs WHERE type IN ('agentos_post','agentos_new_skill') AND status IN ('queued','claimed') ORDER BY id"
    )
    .all();
  const jobs = rows.map((r) => {
    let payload = {};
    try { payload = JSON.parse(r.params); } catch {}
    return { id: r.id, type: r.type, status: r.status, keyword: payload.keyword || null, created_at: r.created_at };
  });
  res.json(jobs);
});

app.post("/api/agentos/post", requireUser, (req, res) => {
  const { keyword } = req.body || {};
  if (!keyword || !_KW_RE.test(keyword)) {
    return res.status(400).json({ error: "keyword must be lowercase letters/numbers only (a-z0-9)" });
  }
  if (_KW_RESERVED.has(keyword)) {
    return res.status(400).json({ error: `"${keyword}" is a reserved word` });
  }
  const skills = _agentosReadSkills();
  if (!skills.find((s) => s.keyword === keyword)) {
    return res.status(400).json({ error: `keyword "${keyword}" not found in skill registry` });
  }
  const dup = db
    .prepare(
      "SELECT id FROM jobs WHERE type='agentos_post' AND status IN ('queued','claimed') AND json_extract(params,'$.keyword')=?"
    )
    .get(keyword);
  if (dup) {
    return res.status(409).json({ error: `post job for "${keyword}" is already queued`, job_id: dup.id });
  }
  const jobId = _agentosInsertJob("agentos_post", { keyword });
  logEvent({ actor: "agentos", message: `AgentOS: post job queued for "${keyword}"`, level: "info" });
  res.json({ job_id: jobId });
});

app.post("/api/agentos/skill", requireUser, (req, res) => {
  const { name, keyword, price, desc, tags, stripe_link, inactive } = req.body || {};
  if (!name || !keyword || !price || !desc || !stripe_link) {
    return res.status(400).json({ error: "name, keyword, price, desc, stripe_link are all required" });
  }
  if (!_KW_RE.test(keyword)) {
    return res.status(400).json({ error: "keyword must be lowercase letters/numbers only (a-z0-9)" });
  }
  if (_KW_RESERVED.has(keyword)) {
    return res.status(400).json({ error: `"${keyword}" is a reserved word` });
  }
  const skills = _agentosReadSkills();
  if (skills.find((s) => s.keyword === keyword)) {
    return res.status(409).json({ error: `keyword "${keyword}" already exists in the registry` });
  }
  const jobId = _agentosInsertJob("agentos_new_skill", {
    name,
    keyword,
    price,
    desc,
    tags: tags || "",
    stripe_link,
    inactive: !!inactive,
  });
  logEvent({
    actor: "agentos",
    message: `AgentOS: new skill "${name}" (${keyword}) registration queued`,
    level: "info",
  });
  res.json({ job_id: jobId });
});

// ---- agentos wire-a-post (video upload + sheet row) -------------------------
const _CAMPAIGNS_DIR = path.join(AGENTOS_ROOT, "agentos", "campaigns");
const _videoStorage = multer.diskStorage({
  destination(req, _file, cb) {
    const kw = String(req.query.keyword || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!kw) return cb(new Error("keyword query param required"), "");
    const dir = path.join(_CAMPAIGNS_DIR, kw);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(_req, file, cb) {
    cb(null, file.originalname);
  },
});
const _videoUpload = multer({
  storage: _videoStorage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB
  fileFilter(_req, file, cb) {
    if (file.mimetype.startsWith("video/")) return cb(null, true);
    cb(new Error("Only video files (mp4/mov) are accepted"));
  },
});

// Upload a campaign video — saves to agentos/campaigns/<keyword>/<filename>.
// POST /api/agentos/upload-video?keyword=<kw>  multipart field: video
app.post("/api/agentos/upload-video", requireUser, (req, res) => {
  const kw = String(req.query.keyword || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!kw || !_KW_RE.test(kw)) {
    return res.status(400).json({ error: "keyword query param must be a-z0-9" });
  }
  _videoUpload.single("video")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "no video file received" });
    res.json({ path: req.file.path, filename: req.file.originalname });
  });
});

// Wire a keyword→link row in the Sheet and optionally send the video to Telegram.
// POST /api/agentos/wire { keyword, link, message?, video_path?, post_url? }
app.post("/api/agentos/wire", requireUser, (req, res) => {
  const { keyword, link, message, video_path, post_url } = req.body || {};
  if (!keyword || !_KW_RE.test(keyword)) {
    return res.status(400).json({ error: "keyword must be lowercase letters/numbers only (a-z0-9)" });
  }
  if (_KW_RESERVED.has(keyword)) {
    return res.status(400).json({ error: `"${keyword}" is a reserved word` });
  }
  if (!link || !String(link).startsWith("http")) {
    return res.status(400).json({ error: "link is required and must start with http" });
  }
  const jobId = _agentosInsertJob("agentos_wire", {
    keyword,
    link,
    message: message || "",
    video_path: video_path || "",
    post_url: post_url || "",
  });
  logEvent({ actor: "agentos", message: `AgentOS: wiring "${keyword}" → ${link}`, level: "info" });
  res.json({ job_id: jobId });
});

// Read current keyword rows from the live Google Sheet (read-only, via service account).
// GET /api/agentos/keywords
app.get("/api/agentos/keywords", requireUser, (_req, res) => {
  const pyPath = path.join(AGENTOS_ROOT, "ig-comment-dm", ".venv", "bin", "python");
  const scriptPath = path.join(AGENTOS_ROOT, "ig-comment-dm", "read_keywords.py");
  _execFile(pyPath, [scriptPath], { cwd: AGENTOS_ROOT, timeout: 15_000 }, (err, stdout) => {
    if (err) {
      return res.status(500).json({ error: `Could not read keywords sheet: ${err.message.slice(0, 200)}` });
    }
    try {
      res.json(JSON.parse(stdout));
    } catch {
      res.status(500).json({ error: "Could not parse keyword sheet response" });
    }
  });
});

// Step 3b: the voice is approved — build the actual avatar video in HeyGen.
// Queued for the Mac worker: this step needs a real browser holding the logged-in
// HeyGen session, so it cannot run in the cloud (see tedca-os/heygen/README.md).
app.post("/api/skills/avatar-video/heygen", requireUser, (req, res) => {
  const { topic, script, audio_file, aspect } = req.body || {};
  if (!script) return res.status(400).json({ error: "script required" });
  try {
    const jobId = queueHeygenVideo({ topic, script, audioFile: audio_file || null, aspect: aspect || "9:16" });
    logEvent({
      actor: "research",
      message: audio_file
        ? `Avatar Video: queued the HeyGen render for "${topic}" — your Mac will drive HeyGen with the voice you already approved.`
        : `Avatar Video: queued the HeyGen render for "${topic}" — your Mac will generate the voice and drive HeyGen.`,
      level: "info",
    });
    res.json({ job_id: jobId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Lets the Mac worker fetch a file the CLOUD produced (e.g. the approved VO mp3), so the
// HeyGen step reuses that exact take instead of re-billing ElevenLabs. Worker-token only,
// and basename-locked so a job param can never walk out of the output directory.
app.get("/api/worker/output/:name", requireWorker, (req, res) => {
  const safe = path.basename(String(req.params.name || ""));
  const file = path.join(process.env.DATA_DIR || path.join(__dirname2, "..", "data"), "output", safe);
  if (!fs.existsSync(file)) return res.status(404).json({ error: "not found" });
  res.sendFile(file);
});

// ---- Motion Graphic one-click (pure motion graphic, no avatar) --------------
app.post("/api/skills/motion-graphic", requireUser, (req, res) => {
  const { topic } = req.body || {};
  if (!topic) return res.status(400).json({ error: "topic required" });
  try {
    const jobId = queueMotionGraphic(topic);
    logEvent({
      actor: "research",
      message: `Motion Graphic: queued the full build for "${topic}" — your Mac is launching the editor agent (script → narration → SFX → rendered MP4).`,
      level: "info",
    });
    res.json({ job_id: jobId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Video Edit: list styles, upload a video, queue the edit ----------------
app.get("/api/skills/edit-styles", requireUser, (_req, res) => {
  res.json(editStyles());
});

// Upload the raw video to be edited → saves to tedca-os/uploads/edits/.
const _EDITS_DIR = path.join(__dirname2, "..", "data", "uploads", "edits");
const _editStorage = multer.diskStorage({
  destination(_req, _file, cb) {
    fs.mkdirSync(_EDITS_DIR, { recursive: true });
    cb(null, _EDITS_DIR);
  },
  filename(_req, file, cb) {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${Date.now()}_${safe}`);
  },
});
const _editUpload = multer({
  storage: _editStorage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
  fileFilter(_req, file, cb) {
    if (file.mimetype.startsWith("video/")) return cb(null, true);
    cb(new Error("Only video files (mp4/mov) are accepted"));
  },
});
app.post("/api/skills/video-edit/upload", requireUser, (req, res) => {
  _editUpload.single("video")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "no video file received" });
    res.json({ path: req.file.path, filename: req.file.originalname });
  });
});

// Queue the edit: an AI agent reads the chosen style's PLAYBOOK.md and edits the video.
app.post("/api/skills/video-edit", requireUser, (req, res) => {
  const { video_path, style } = req.body || {};
  if (!video_path) return res.status(400).json({ error: "video_path required (upload first)" });
  if (!fs.existsSync(video_path)) return res.status(400).json({ error: "uploaded video not found on disk" });
  try {
    const jobId = queueVideoEdit({ videoPath: video_path, styleId: style || "signature" });
    logEvent({
      actor: "research",
      message: `Video Edit: queued — the editor agent will read the "${style || "signature"}" playbook and cut your video. This is a real edit (several minutes).`,
      level: "info",
    });
    res.json({ job_id: jobId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Educational Post: phase 1 copy (find/write/revise), phase 2 generate ---
app.post("/api/skills/edu-post/copy", requireUser, async (req, res) => {
  const { topic, previous, notes } = req.body || {};
  try {
    logEvent({
      actor: "research",
      message: previous ? "Educational Post: revising the slide copy with your notes…" : topic ? `Educational Post: researching "${topic}" and writing 5 slides…` : "Educational Post: finding a fresh Claude Code topic and writing 5 slides…",
      level: "info",
    });
    const data = await eduPostCopy(topic, { previous, notes });
    logEvent({ actor: "research", message: `Educational Post: draft ready — "${data.topic}". Edit the copy, then Generate.`, level: "success" });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/skills/edu-post/generate", requireUser, (req, res) => {
  const { topic, slides } = req.body || {};
  if (!Array.isArray(slides) || slides.length < 3) {
    return res.status(400).json({ error: "need the slides copy (generate it first)" });
  }
  try {
    const jobId = queueEduPost({ topic, slides });
    logEvent({ actor: "research", message: `Educational Post: queued render of ${slides.length} animated slides → Live Photos.`, level: "success" });
    res.json({ job_id: jobId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Clip Editor: stream rendered files + re-edit (revise) ------------------
// Stream a rendered mp4/jpg from tedca-os/output to the browser <video>. Auth via
// ?token= (same as the WS), with range support so the player can scrub.
const _FILE_ROOT = path.join(AGENTOS_ROOT, "tedca-os", "output");
app.get("/api/skills/file", (req, res) => {
  if (!sessionExists(String(req.query.token || ""))) return res.status(401).end();
  const resolved = path.resolve(String(req.query.path || ""));
  if (!resolved.startsWith(_FILE_ROOT + path.sep) || !fs.existsSync(resolved)) return res.status(404).end();
  const ext = path.extname(resolved).toLowerCase();
  const types = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".html": "text/html" };
  res.setHeader("Content-Type", types[ext] || "application/octet-stream");
  const stat = fs.statSync(resolved);
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = m ? parseInt(m[1], 10) : 0;
    const end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Length", end - start + 1);
    fs.createReadStream(resolved, { start, end }).pipe(res);
  } else {
    res.setHeader("Content-Length", stat.size);
    fs.createReadStream(resolved).pipe(res);
  }
});

// ══════════════ Clip Editor projects: persistent version history ══════════════
// Every upload becomes a PROJECT; every edit/revision is a VERSION row. Version
// rows with status 'rendering' are lazily synced from their job on read; when a
// job completes, the output is chmod 444 (versions are IMMUTABLE once done —
// same discipline as shipped deliverables / Ted-watched references).

function syncEditVersion(v) {
  if (v.status !== "rendering" || !v.job_id) return v;
  const job = jobStatus(v.job_id);
  if (!job) return v;
  if (job.status === "done") {
    let out = "", log = "";
    try {
      const r = JSON.parse(job.result || "{}");
      out = r.path || "";
      log = r.build_log_path || "";
    } catch { /* keep empty */ }
    db.prepare(
      "UPDATE edit_versions SET status = 'done', output_path = ?, build_log_path = ? WHERE id = ?"
    ).run(out || null, log || null, v.id);
    if (out && fs.existsSync(out)) {
      try { fs.chmodSync(out, 0o444); } catch { /* best effort */ }
    }
    return { ...v, status: "done", output_path: out, build_log_path: log };
  }
  if (job.status === "failed") {
    db.prepare("UPDATE edit_versions SET status = 'failed' WHERE id = ?").run(v.id);
    return { ...v, status: "failed", fail_reason: String(job.result || "").slice(0, 400) };
  }
  return v;
}

// create a project + queue its v1 edit (skip_initial: create the project shell only —
// used when importing an existing finished video as the first version via /seed)
app.post("/api/edit-projects", requireUser, (req, res) => {
  const { name, source_path, style, skip_initial, model, effort } = req.body || {};
  if (!source_path) return res.status(400).json({ error: "source_path required (upload first)" });
  if (!fs.existsSync(source_path)) return res.status(400).json({ error: "source video not found on disk" });
  try {
    const projName = (name || "").trim() || path.basename(source_path).replace(/^\d+_/, "").replace(/\.[^.]+$/, "");
    const info = db
      .prepare("INSERT INTO edit_projects (name, source_path, style_id) VALUES (?, ?, ?)")
      .run(projName, source_path, style || "locked");
    const projectId = Number(info.lastInsertRowid);
    if (skip_initial) {
      logEvent({ actor: "research", message: `Clip Editor: project "${projName}" created (importing an existing video as v1).`, level: "info" });
      return res.json({ project_id: projectId });
    }
    const v = queueEditVersion({ projectId, model: model || "", effort: effort || "" });
    logEvent({ actor: "research", message: `Clip Editor: project "${projName}" created — v1 edit queued.`, level: "info" });
    res.json({ project_id: projectId, version_id: v.versionId, job_id: v.jobId, version_n: v.versionN });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// list projects with version counts + latest status
app.get("/api/edit-projects", requireUser, (_req, res) => {
  const rows = db
    .prepare(
      `SELECT p.*, COUNT(v.id) AS version_count,
              (SELECT status FROM edit_versions WHERE project_id = p.id ORDER BY version_n DESC LIMIT 1) AS latest_status
       FROM edit_projects p LEFT JOIN edit_versions v ON v.project_id = p.id
       GROUP BY p.id ORDER BY p.id DESC`
    )
    .all();
  res.json(rows);
});

// project + full version history (lazy-synced)
app.get("/api/edit-projects/:id", requireUser, (req, res) => {
  const proj = db.prepare("SELECT * FROM edit_projects WHERE id = ?").get(req.params.id);
  if (!proj) return res.status(404).json({ error: "project not found" });
  const versions = db
    .prepare("SELECT * FROM edit_versions WHERE project_id = ? ORDER BY version_n ASC")
    .all(proj.id)
    .map(syncEditVersion);
  res.json({ ...proj, versions });
});

// revise from ANY version -> v(n+1) branched from it
app.post("/api/edit-projects/:id/revise", requireUser, (req, res) => {
  const { from_version_id, notes, learn, model, effort } = req.body || {};
  const trimmed = String(notes || "").trim();
  if (!trimmed) return res.status(400).json({ error: "notes required" });
  const proj = db.prepare("SELECT * FROM edit_projects WHERE id = ?").get(req.params.id);
  if (!proj) return res.status(404).json({ error: "project not found" });
  let fromVersion = null;
  if (from_version_id) {
    fromVersion = db
      .prepare("SELECT * FROM edit_versions WHERE id = ? AND project_id = ?")
      .get(from_version_id, proj.id);
    if (!fromVersion) return res.status(400).json({ error: "from_version not found in this project" });
    if (!["done", "seeded"].includes(fromVersion.status)) {
      return res.status(400).json({ error: "can only revise a finished version" });
    }
  }
  try {
    const v = queueEditVersion({ projectId: proj.id, notes: trimmed, learn: learn !== false, fromVersion, model: model || "", effort: effort || "" });
    logEvent({ actor: "research", message: `Clip Editor: "${proj.name}" v${v.versionN} queued from v${fromVersion ? fromVersion.version_n : "latest"} — "${trimmed.slice(0, 70)}"`, level: "info" });
    res.json({ version_id: v.versionId, job_id: v.jobId, version_n: v.versionN });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// single version status/output (used by the UI poller)
app.get("/api/edit-versions/:id", requireUser, (req, res) => {
  const v = db.prepare("SELECT * FROM edit_versions WHERE id = ?").get(req.params.id);
  if (!v) return res.status(404).json({ error: "version not found" });
  res.json(syncEditVersion(v));
});

// import an existing finished mp4 as a version (honest label: status 'seeded' — no
// render is faked; used e.g. to bring tonight's hand-built edit in as a project's v1)
app.post("/api/edit-projects/:id/seed", requireUser, (req, res) => {
  const { output_path, notes, build_log_path } = req.body || {};
  if (!output_path || !fs.existsSync(output_path)) {
    return res.status(400).json({ error: "output_path must exist on disk" });
  }
  const proj = db.prepare("SELECT * FROM edit_projects WHERE id = ?").get(req.params.id);
  if (!proj) return res.status(404).json({ error: "project not found" });
  const maxN = db
    .prepare("SELECT COALESCE(MAX(version_n), 0) AS n FROM edit_versions WHERE project_id = ?")
    .get(proj.id).n;
  const info = db
    .prepare(
      `INSERT INTO edit_versions (project_id, version_n, status, notes, output_path, build_log_path)
       VALUES (?, ?, 'seeded', ?, ?, ?)`
    )
    .run(proj.id, Number(maxN) + 1, notes || "imported existing edit", output_path, build_log_path || null);
  res.json({ version_id: Number(info.lastInsertRowid), version_n: Number(maxN) + 1 });
});

// Re-edit with change notes (and the previous version) → a new version. The notes
// also persist to the style's LEARNINGS.md (the editor reads it every run).
app.post("/api/skills/video-edit/revise", requireUser, (req, res) => {
  const { source_path, style, notes, prev_path, learn } = req.body || {};
  if (!source_path) return res.status(400).json({ error: "source_path required" });
  if (!fs.existsSync(source_path)) return res.status(400).json({ error: "source video not found on disk" });
  try {
    const jobId = queueVideoEdit({ videoPath: source_path, styleId: style || "signature", notes: notes || "", prevPath: prev_path || "", learn: learn !== false });
    logEvent({ actor: "research", message: `Clip Editor: re-editing with your notes — "${String(notes || "").slice(0, 70)}"`, level: "info" });
    res.json({ job_id: jobId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

bindLogger(logEvent);
bindSkillLogger(logEvent);
bindReplyLogger(logEvent);
bindHotLeadsLogger(logEvent);
bindLinkedInLogger(logEvent);
bindIntakeLogger(logEvent);
startOwnerHeartbeat(); // claim the single-owner send lock before any send loop starts
startBounceGuard(); // auto-pause an inbox if its 7-day bounce rate crosses the danger line
bindBackupLogger(logEvent);
startCrmBackupLoop(); // CRM → Google Sheet backup every 4h + daily local .db snapshot
startFollowupLoop();
startScheduler();
startVerifyAheadLoop(); // keep the queue verified ahead so the 8am run never waits on AnyMailFinder
startReplyLoop();
startLinkedInLoop();
startDailyReportLoop();
bindContentLogger(logEvent);
startContentLoop(); // IG/FB post metrics: poll every ~90s (Meta has no push webhook)
if (!telegramConfigured()) {
  console.warn("Telegram not configured — notifications will be skipped.");
}

server.listen(PORT, () => {
  console.log(`tedca-os server listening on http://localhost:${PORT}`);
  logEvent({ actor: "system", message: "Server started", level: "info" });
});
