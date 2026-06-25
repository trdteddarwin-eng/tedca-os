import express from "express";
import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { db } from "./db.js";
import { gmailConfigured, authorizedInboxes, startAuth, sendEmail, importTokens } from "./gmail.js";
import { smtpInboxMeta, importSmtpInboxes } from "./smtp.js";
import { sendingInboxes, sendVia } from "./pool.js";
import { startMorningRun, runningRunId, bindLogger, startFollowupLoop, startScheduler, startDailyReportLoop, getSetting } from "./engine.js";
import { startReplyLoop, bindReplyLogger } from "./replies.js";
import { telegramConfigured, sendTelegramFile } from "./telegram.js";
import { elevenConfigured, generateVoice } from "./elevenlabs.js";
import {
  bindSkillLogger,
  avatarVideoScript,
  suggestLivephotoTopics,
  queueLivephoto,
  markTopicDone,
  queueCarousel,
  queueTts,
  queueMotionGraphic,
  queueVideoEdit,
  editStyles,
  eduPostCopy,
  queueEduPost,
  jobStatus,
  VOICE_AVATAR,
} from "./skills.js";

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
app.use(express.json({ limit: "2mb" }));

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
  const { password } = req.body || {};
  if (!password || !timingSafeEqual(password, OS_PASSWORD)) {
    return res.status(401).json({ error: "wrong password" });
  }
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT OR IGNORE INTO sessions (token) VALUES (?)").run(token);
  sessionCache.add(token);
  res.json({ token });
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
  });
});

app.get("/api/leads", requireUser, (req, res) => {
  res.json(db.prepare("SELECT * FROM leads ORDER BY id DESC LIMIT 500").all());
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

// Every email ever sent or received, with the business it belongs to.
app.get("/api/emails", requireUser, (req, res) => {
  res.json(
    db
      .prepare(
        `SELECT e.id, e.lead_id, e.inbox, e.direction, e.subject, e.body, e.kind, e.sent_at,
                l.business_name, l.email AS lead_email
         FROM emails e LEFT JOIN leads l ON l.id = e.lead_id
         ORDER BY e.id DESC LIMIT 500`
      )
      .all()
  );
});

// One-time data migration: local instance pushes its leads + email history up.
app.post("/api/admin/import-data", requireUser, (req, res) => {
  const { leads = [], emails = [] } = req.body || {};
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
  const ready = sendingInboxes(); // gmail (authorized) + zapmail smtp
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
app.post("/api/run/morning", requireUser, (req, res) => {
  const target = Math.max(1, Math.min(Number((req.body || {}).target || 10), 500));
  const query = (req.body || {}).query || null;
  try {
    const runId = startMorningRun({ target, query });
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
startFollowupLoop();
startScheduler();
startReplyLoop();
startDailyReportLoop();
if (!telegramConfigured()) {
  console.warn("Telegram not configured — notifications will be skipped.");
}

server.listen(PORT, () => {
  console.log(`tedca-os server listening on http://localhost:${PORT}`);
  logEvent({ actor: "system", message: "Server started", level: "info" });
});
