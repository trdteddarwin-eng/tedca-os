// The morning cold-email run: bank → (one scrape) → verify → send → bank rest.
// Server-side steps run here; the scrape executes on the user's Mac via the jobs queue.
import { db } from "./db.js";
import { findCeo, amfConfigured } from "./anymailfinder.js";
import { sendTelegram } from "./telegram.js";
import { sendingInboxes, sendVia, isSmtp } from "./pool.js";
import { smtpInboxCap } from "./smtp.js";
import { isSuppressed } from "./replies.js";
import { scrapeGoogleMaps, apifyConfigured } from "./scrape.js";
import { sendDailyReport } from "./report.js";

let logEvent = () => {};
export function bindLogger(fn) {
  logEvent = fn;
}

export function getSetting(key) {
  return db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitterMs = () => 9000 + Math.floor(Math.random() * 5000); // 9–14s

let activeRun = null;
export function runningRunId() {
  return activeRun;
}

export async function startMorningRun({ target, query }) {
  if (activeRun) throw new Error(`run ${activeRun} already in progress`);
  const niche = getSetting("niche");
  const city = getSetting("city");
  const searchQuery = query || `${niche} in ${city}`;
  const info = db
    .prepare("INSERT INTO runs (agent, status, summary) VALUES ('cold-email', 'running', ?)")
    .run(`target ${target} · ${searchQuery}`);
  const runId = Number(info.lastInsertRowid);
  activeRun = runId;

  // fire and forget; all progress goes through the activity feed
  executeRun(runId, { target, searchQuery }).catch((e) => {
    logEvent({ run_id: runId, actor: "system", message: `Run failed: ${e.message}`, level: "error" });
    db.prepare("UPDATE runs SET status='failed', finished_at=datetime('now'), summary=? WHERE id=?").run(
      String(e.message).slice(0, 300),
      runId
    );
    activeRun = null;
  });
  return runId;
}

const MAX_SCRAPES_PER_RUN = 2; // cost guard: free Apify tier + $0.50 rule

async function executeRun(runId, { target, searchQuery }) {
  const log = (actor, message, level = "info") => logEvent({ run_id: runId, actor, message, level });

  // ── Step 1: Scout — the brief ──────────────────────────────────────────────
  log("research", `Good morning. Today's plan: find ${target} ${getSetting("niche")} leads ("${searchQuery}") and email each one's owner.`, "info");

  // Producer/consumer: Inspector keeps a queue of verified leads topped up
  // (scraping more when supply runs dry) WHILE Courier sends from the queue.
  const queue = [];
  const enqueued = new Set(); // never queue the same lead twice → no duplicate sends
  let producing = true;
  let scrapesUsed = 0;

  async function verifyOne(id) {
    const lead = db.prepare("SELECT * FROM leads WHERE id=?").get(id);
    if (!lead) return false;
    if (lead.email && lead.email_status === "valid") return true;
    if (!amfConfigured()) return Boolean(lead.email); // no key: use scraped email as-is
    if (!lead.domain && !lead.business_name) return false;
    try {
      const r = await findCeo({ domain: lead.domain, companyName: lead.business_name });
      if (r.status === "no_credits") {
        log("verify", "My email-finding credits ran out — I cannot confirm any more owner emails today.", "error");
        return "stop";
      }
      if (r.ok) {
        db.prepare("UPDATE leads SET email=?, email_status='valid', ceo_name=COALESCE(?, ceo_name) WHERE id=?").run(
          r.email,
          r.name,
          id
        );
        log("verify", `${lead.business_name}: found the owner — ${r.email} (confirmed real).`, "success");
        return true;
      }
      db.prepare("UPDATE leads SET email_status=? WHERE id=?").run(r.status || "unknown", id);
      log("verify", `${lead.business_name}: could not find a safe owner email — skipping so we never bounce.`, "info");
      return false;
    } catch (e) {
      log("verify", `Hit a snag looking up ${lead.business_name}: ${e.message}`, "warn");
      return false;
    }
  }

  async function producer() {
    let supplied = 0;
    try {
      while (supplied < target) {
        // take whatever unworked leads we have (bank + freshly scraped)
        // exclude leads already screened-and-failed (email_status set but no usable email)
        const pool = db
          .prepare(
            "SELECT id FROM leads WHERE status='scraped' AND (email IS NOT NULL OR email_status IS NULL) ORDER BY banked DESC, id LIMIT ?"
          )
          .all(target * 3)
          .map((r) => r.id);

        let pushedThisPass = 0;
        for (const id of pool) {
          if (supplied >= target) break;
          const v = await verifyOne(id);
          if (v === "stop") return;
          // mark as consumed from the pool either way so we don't re-verify endlessly
          db.prepare("UPDATE leads SET banked=0 WHERE id=?").run(id);
          if (v) {
            if (!enqueued.has(id)) {
              queue.push(id);
              enqueued.add(id);
              supplied++;
              pushedThisPass++;
            }
          } else {
            // dead lead: keep in CRM but out of future pools
            db.prepare("UPDATE leads SET status='scraped', banked=0, email_status=COALESCE(email_status,'unknown') WHERE id=? AND email IS NULL").run(id);
          }
        }

        if (supplied >= target) break;

        // Not enough sendable leads — scrape more WITHOUT stopping the sender.
        if (scrapesUsed >= MAX_SCRAPES_PER_RUN) {
          log("scrape", `Came up short today (${supplied} of ${target}) and I have used up my scraping allowance — sending the ones I have. Try other cities or keywords tomorrow.`, "warn");
          break;
        }
        // exclude leads we already screened from "available" by requiring fresh inserts
        scrapesUsed++;
        const deficit = target - supplied;
        const nSearches = searchQuery.split("|").filter((s) => s.trim()).length || 1;
        // over-fetch: verification attrition means we need ~3x the deficit
        const perSearch = Math.max(Math.ceil((deficit * 3) / nSearches), 10);
        log("scrape", `Not enough leads yet (${supplied} of ${target} ready). Going to Google Maps for more businesses — emails keep going out in the meantime. (scrape ${scrapesUsed} of ${MAX_SCRAPES_PER_RUN} allowed today)`, "warn");
        const scraped = await runScrapeJob(runId, { search: searchQuery, limit: perSearch });
        const inserted = ingestLeads(scraped, searchQuery);
        log("scrape", `Found ${scraped.length} businesses on the map — ${inserted.length} are new ones we have never contacted.`, inserted.length ? "success" : "warn");
        if (!inserted.length && pushedThisPass === 0) {
          log("scrape", "That search came back with nothing new — these areas may be tapped out. Different cities or keywords should fix it.", "warn");
          break;
        }
      }
    } finally {
      producing = false;
      log("verify", `Done checking emails: ${supplied} lead${supplied === 1 ? "" : "s"} with a confirmed owner email, ready to contact.`, supplied ? "success" : "warn");
    }
  }

  // start with the bank
  const bankCount = db.prepare("SELECT COUNT(*) c FROM leads WHERE banked=1 AND status='scraped'").get().c;
  log("scrape", `Checking the lead bank first: ${bankCount} saved lead${bankCount === 1 ? "" : "s"} from before${bankCount >= target ? " — that covers today, no new scraping needed (free)" : ""}.`, "info");

  // ── Steps 2–5 run CONCURRENTLY: producer fills, Courier drains ────────────
  // catch immediately so a scrape failure can never crash the process
  let producerError = null;
  const producerDone = producer().catch((e) => {
    producerError = e;
    producing = false;
    log("scrape", `Lead hunting hit a problem: ${e.message}`, "error");
  });
  const sent = await sendFromQueue(runId, queue, () => producing, target);
  await producerDone;

  // bank whatever wasn't emailed today
  const leftovers = db
    .prepare("SELECT COUNT(*) c FROM leads WHERE status='scraped'")
    .get().c;
  db.prepare("UPDATE leads SET banked=1 WHERE status='scraped'").run();
  log("scrape", `Saved ${leftovers} untouched lead${leftovers === 1 ? "" : "s"} in the bank for tomorrow (free head start).`, "info");

  db.prepare("UPDATE runs SET status='done', finished_at=datetime('now'), summary=? WHERE id=?").run(
    `${sent} emailed, ${leftovers} banked`,
    runId
  );
  log("system", `Morning run finished. ${sent} email${sent === 1 ? "" : "s"} sent, ${leftovers} lead${leftovers === 1 ? "" : "s"} saved for tomorrow.`, "success");
  await sendTelegram(
    `☀️ Morning run done\n· ${sent} emails sent\n· ${leftovers} leads banked for tomorrow\n· search: ${searchQuery}\nDashboard → ${process.env.PUBLIC_URL || "http://localhost:5173"}`
  );
  activeRun = null;
}

// ── scrape: cloud-native (Apify direct) with Mac-worker fallback ─────────────
async function runScrapeJob(runId, params) {
  // Cloud: call Apify directly so lead-gen runs with the laptop off.
  if (apifyConfigured()) {
    logEvent({ run_id: runId, actor: "scrape", message: `Scraping Google Maps in the cloud: "${params.search}" (limit ${params.limit})`, level: "info" });
    return await scrapeGoogleMaps(params.search, params.limit);
  }

  // Local fallback: dispatch to the Mac worker via the job queue.
  const info = db
    .prepare("INSERT INTO jobs (run_id, type, params) VALUES (?, 'scrape', ?)")
    .run(runId, JSON.stringify(params));
  const jobId = Number(info.lastInsertRowid);

  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 10 * 60 * 1000; // 10 min
    const tick = setInterval(() => {
      const job = db.prepare("SELECT status, result FROM jobs WHERE id=?").get(jobId);
      if (job.status === "done") {
        clearInterval(tick);
        try {
          resolve(JSON.parse(job.result || "[]"));
        } catch (e) {
          reject(new Error(`scrape result unparsable: ${e.message}`));
        }
      } else if (job.status === "failed") {
        clearInterval(tick);
        reject(new Error(job.result || "scrape job failed"));
      } else if (Date.now() > deadline) {
        clearInterval(tick);
        db.prepare("UPDATE jobs SET status='failed', result='timeout' WHERE id=?").run(jobId);
        reject(new Error("scrape job timed out after 10 min — is the Mac worker running?"));
      }
    }, 2000);
  });
}

function ingestLeads(items, source) {
  const insert = db.prepare(`
    INSERT INTO leads (business_name, domain, category, rating, review_count, website, email, email_status, source, scraped_at, status, banked)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), 'scraped', 0)
  `);
  const exists = db.prepare("SELECT id FROM leads WHERE business_name=? AND (domain=? OR domain IS NULL)");
  const ids = [];
  for (const it of items) {
    const name = it.title || it.name || it.business_name;
    if (!name) continue;
    const website = it.website || it.url || null;
    let domain = null;
    if (website) {
      try {
        domain = new URL(website.startsWith("http") ? website : `https://${website}`).hostname.replace(/^www\./, "");
      } catch {
        /* unparsable site */
      }
    }
    if (exists.get(name, domain)) continue;
    const info = insert.run(
      name,
      domain,
      it.categoryName || it.category || null,
      it.totalScore ?? it.rating ?? null,
      it.reviewsCount ?? it.review_count ?? null,
      website,
      it.email || null,
      it.email ? "unknown" : null,
      source
    );
    ids.push(Number(info.lastInsertRowid));
  }
  return ids;
}

// ── sender: caps, rotation, jitter, test mode ────────────────────────────────
function fillTemplate(tpl, lead) {
  const first = (lead.ceo_name || "").split(" ")[0] || "there";
  // callback replacers avoid $-pattern expansion ($&, $$, …) from lead text;
  // clean() strips CR/LF so a scraped name can't inject email headers.
  const clean = (v) => String(v).replace(/[\r\n]+/g, " ");
  return tpl
    .replaceAll("{business_name}", () => clean(lead.business_name || "your business"))
    .replaceAll("{first_name}", () => clean(first))
    .replaceAll("{category}", () => clean(lead.category || "business"))
    .replaceAll("{rating}", () => (lead.rating != null ? String(lead.rating) : "great"))
    .replaceAll("{review_count}", () => (lead.review_count != null ? String(lead.review_count) : "many"));
}

function sentTodayByInbox(inbox) {
  return db
    .prepare("SELECT COUNT(*) c FROM emails WHERE inbox=? AND direction='out' AND kind IN ('initial','followup') AND sent_at >= date('now')")
    .get(inbox).c;
}

// daily cap per inbox: mature Gmail inboxes use the flat setting; new Zapmail
// (SMTP) inboxes follow an age-based warmup ramp (12 → 50 over the first week).
function capFor(inbox) {
  return isSmtp(inbox) ? smtpInboxCap(inbox) : Number(getSetting("per_inbox_cap") || 20);
}

// CAN-SPAM: every cold send needs an opt-out and a physical mailing address.
// Stored as the `compliance_footer` setting; appended to the body before send.
function withCompliance(body) {
  const footer = getSetting("compliance_footer");
  return footer ? `${body}\n\n${footer}` : body;
}

// Consumer: drains the verified-lead queue while the producer is still filling it.
async function sendFromQueue(runId, queue, isProducing, target) {
  const log = (m, level = "info") => logEvent({ run_id: runId, actor: "send", message: m, level });
  const testMode = getSetting("test_mode") === "1";
  log(
    testMode
      ? `Practice mode is ON — every email comes to you (${process.env.TEST_RECIPIENT || "(unset!)"}), not the leads.`
      : "LIVE mode — these emails go to real business owners.",
    testMode ? "warn" : "info"
  );
  let sent = 0;
  while (sent < target) {
    // stop cleanly when business hours close — don't bleed sends into the evening
    if (!withinSendWindow()) {
      log("Business hours are over (Mon–Fri 9–17) — banking the rest for tomorrow.", "warn");
      break;
    }
    if (!queue.length) {
      if (!isProducing()) break; // producer finished and queue is empty
      await sleep(1500); // wait for verification/scrape to supply more
      continue;
    }
    // if every inbox is already at its daily cap, stop — don't spin discarding the queue
    const pool = sendingInboxes().map((i) => i.email);
    if (pool.length && pool.every((e) => sentTodayByInbox(e) >= capFor(e))) {
      log("Every inbox has hit today's safe cap — banking the rest for tomorrow.", "warn");
      break;
    }
    const id = queue.shift();
    const n = await sendBatch(runId, [id], { quiet: true });
    sent += n;
  }
  log(`Finished sending: ${sent} email${sent === 1 ? "" : "s"} out the door.`, sent ? "success" : "warn");
  return sent;
}

async function sendBatch(runId, leadIds, { quiet = false } = {}) {
  const log = (m, level = "info") => {
    if (quiet && (m.startsWith("Batch done") || m.startsWith("TEST MODE") || m.startsWith("LIVE MODE"))) return;
    logEvent({ run_id: runId, actor: "send", message: m, level });
  };
  const testMode = getSetting("test_mode") === "1";
  const followupDays = Number(getSetting("followup_days") || 3);
  const subjectTpl = getSetting("email_subject");
  const bodyTpl = getSetting("email_body");
  const testRecipient = process.env.TEST_RECIPIENT || "";

  const ready = sendingInboxes().map((i) => i.email);
  if (!ready.length) {
    log("No connected inboxes — cannot send", "error");
    return 0;
  }
  if (testMode && !testRecipient) {
    log("TEST MODE but no TEST_RECIPIENT in .env — cannot send", "error");
    return 0;
  }
  // CAN-SPAM gate: never send to real leads without an opt-out + mailing address
  if (!testMode && !getSetting("compliance_footer")) {
    log("LIVE mode blocked: no compliance_footer set (CAN-SPAM needs an opt-out + physical address). Add it before going live.", "error");
    return 0;
  }
  log(testMode ? `TEST MODE: every email goes to ${testRecipient}` : "LIVE mode — these emails go to real business owners.", testMode ? "warn" : "info");

  let sent = 0;
  let inboxIdx = 0;
  for (const id of leadIds) {
    const lead = db.prepare("SELECT * FROM leads WHERE id=?").get(id);
    if (!lead?.email) continue;
    if (isSuppressed(lead.email)) {
      log(`Skipping ${lead.business_name} — that address opted out before.`, "info");
      continue;
    }

    // pick next inbox under its daily cap
    let inbox = null;
    for (let i = 0; i < ready.length; i++) {
      const candidate = ready[(inboxIdx + i) % ready.length];
      if (sentTodayByInbox(candidate) < capFor(candidate)) {
        inbox = candidate;
        inboxIdx = (inboxIdx + i + 1) % ready.length;
        break;
      }
    }
    if (!inbox) {
      log("Every inbox hit its safe daily limit for today — pausing sends until tomorrow to protect them.", "warn");
      break;
    }

    const subject = (testMode ? `[TEST → ${lead.email}] ` : "") + fillTemplate(subjectTpl, lead);
    const body = withCompliance(fillTemplate(bodyTpl, lead));
    const to = testMode ? testRecipient : lead.email;
    try {
      await sendVia({ from: inbox, to, subject, body });
      db.prepare(
        "INSERT INTO emails (lead_id, inbox, direction, subject, body, kind, sent_at) VALUES (?, ?, 'out', ?, ?, 'initial', datetime('now'))"
      ).run(id, inbox, subject, body);
      db.prepare(
        "UPDATE leads SET status='emailed', inbox_used=?, last_touch_at=datetime('now'), followup_due_at=datetime('now', ?) WHERE id=?"
      ).run(inbox, `+${followupDays} days`, id);
      sent++;
      log(`Email sent to ${lead.business_name} (${lead.email}) using the ${inbox} inbox${testMode ? " — test copy went to you" : ""}.`, "success");
    } catch (e) {
      log(`Could not send to ${lead.business_name}: ${e.message}`, "error");
    }
    await sleep(jitterMs());
  }
  log(`Finished sending: ${sent} email${sent === 1 ? "" : "s"} out the door.`, sent ? "success" : "warn");
  return sent;
}

// ── scheduling anchored to Eastern time (NJ), regardless of server clock ─────
const TZ = "America/New_York";
function etNow(d = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour12: false, weekday: "short", hour: "2-digit" })
      .formatToParts(d)
      .map((x) => [x.type, x.value])
  );
  const days = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { day: days[p.weekday], hour: Number(p.hour) };
}
const etDate = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d); // YYYY-MM-DD

// business hours: Mon–Fri 8:00–17:00 Eastern
export function withinSendWindow(d = new Date()) {
  const { day, hour } = etNow(d);
  return day >= 1 && day <= 5 && hour >= 8 && hour < 17;
}

// ── daily auto-run: weekday mornings, once per day ──────────────────────────
export function startScheduler() {
  setInterval(() => {
    try {
      if (getSetting("schedule_enabled") !== "1") return;
      if (getSetting("paused") === "1") return;
      const now = new Date();
      const { hour } = etNow(now);
      if (!withinSendWindow(now)) return;
      if (hour !== Number(getSetting("schedule_hour") || 8)) return;
      const today = etDate(now);
      if (getSetting("last_auto_run_date") === today) return;
      if (runningRunId()) return;
      db.prepare(
        "INSERT INTO settings (key, value) VALUES ('last_auto_run_date', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
      ).run(today);
      const target = Number(getSetting("daily_target") || 100);
      logEvent({ actor: "system", message: `It's ${hour}:00 ET on a weekday — starting today's automatic run (target ${target}).`, level: "info" });
      startMorningRun({ target, query: null });
    } catch (e) {
      logEvent({ actor: "system", message: `Auto-run scheduler error: ${e.message}`, level: "error" });
    }
  }, 60_000);
}

// ── follow-up scheduler: runs every minute ───────────────────────────────────
export function startFollowupLoop() {
  setInterval(async () => {
    if (getSetting("paused") === "1") return;
    if (!withinSendWindow()) return; // only send during business hours, Mon–Fri
    const due = db
      .prepare("SELECT * FROM leads WHERE status='emailed' AND followup_due_at IS NOT NULL AND followup_due_at <= datetime('now') LIMIT 10")
      .all();
    if (!due.length) return;
    const testMode = getSetting("test_mode") === "1";
    const testRecipient = process.env.TEST_RECIPIENT || "";
    // same CAN-SPAM + test guards the initial-send path enforces
    if (!testMode && !getSetting("compliance_footer")) return;
    if (testMode && !testRecipient) return;
    const tpl = getSetting("followup_body");
    for (const lead of due) {
      const inbox = lead.inbox_used;
      if (!inbox || sentTodayByInbox(inbox) >= capFor(inbox)) continue;
      if (isSuppressed(lead.email)) continue;
      const subject = (testMode ? `[TEST → ${lead.email}] ` : "") + `Re: ` + fillTemplate(getSetting("email_subject"), lead);
      const body = withCompliance(fillTemplate(tpl, lead));
      try {
        await sendVia({ from: inbox, to: testMode ? testRecipient : lead.email, subject, body });
        db.prepare(
          "INSERT INTO emails (lead_id, inbox, direction, subject, body, kind, sent_at) VALUES (?, ?, 'out', ?, ?, 'followup', datetime('now'))"
        ).run(lead.id, inbox, subject, body);
        db.prepare("UPDATE leads SET status='followup_sent', followup_due_at=NULL, last_touch_at=datetime('now') WHERE id=?").run(lead.id);
        logEvent({ actor: "send", message: `Gentle follow-up sent to ${lead.business_name}${testMode ? " (test copy to you)" : ""}.`, level: "success" });
        await sleep(jitterMs());
      } catch (e) {
        logEvent({ actor: "send", message: `Follow-up to ${lead.business_name} did not go through: ${e.message}`, level: "error" });
      }
    }
  }, 60_000);
}

// ── end-of-day report: 17:00 ET on weekdays, once/day → PDF to Telegram ───────
export function startDailyReportLoop() {
  setInterval(async () => {
    try {
      const { day, hour } = etNow();
      if (day < 1 || day > 5) return; // weekdays only
      if (hour !== 17) return; // 5:00 PM ET
      const today = etDate();
      if (getSetting("last_report_date") === today) return;
      db.prepare(
        "INSERT INTO settings (key, value) VALUES ('last_report_date', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
      ).run(today);
      logEvent({ actor: "system", message: "End of day — building today's email report and sending it to Telegram.", level: "info" });
      const ok = await sendDailyReport();
      logEvent({ actor: "system", message: ok ? "📊 Daily report sent to Telegram." : "Couldn't send the daily report (check Telegram config).", level: ok ? "success" : "warn" });
    } catch (e) {
      logEvent({ actor: "system", message: `Daily report error: ${e.message}`, level: "error" });
    }
  }, 60_000);
}
