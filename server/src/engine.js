// The morning cold-email run: bank → (one scrape) → verify → send → bank rest.
// Server-side steps run here; the scrape executes on the user's Mac via the jobs queue.
import { db, syncMarketStates } from "./db.js";
import { findCeo, verifyEmail, amfConfigured } from "./anymailfinder.js";
import { sendTelegram } from "./telegram.js";
import { sendingInboxes, sendVia, isSmtp } from "./pool.js";
import { smtpInboxCap, smtpFirstName } from "./smtp.js";
import dns from "node:dns/promises";
import { isSuppressed, suppress } from "./replies.js";
import { scrapeGoogleMaps, apifyConfigured } from "./scrape.js";
import { sendDailyReport } from "./report.js";
import { randomUUID } from "node:crypto";

let logEvent = () => {};
export function bindLogger(fn) {
  logEvent = fn;
}

export function getSetting(key) {
  return db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Gap between sends. Tunable via settings so we can spread a day's volume across
// business hours instead of firing everything in one ~45-min block (which reads
// like a burst to Gmail). Defaults to 9–14s; set send_gap_min_s/spread_s higher
// to drip across the afternoon. Random so no two gaps are identical.
const jitterMs = () => {
  // Code floor of 8s so a fat-fingered 0 setting can never turn into a burst.
  const baseS = Math.max(8, Number(getSetting("send_gap_min_s") || 9));
  const spreadS = Number(getSetting("send_gap_spread_s") || 5);
  return baseS * 1000 + Math.floor(Math.random() * Math.max(1, spreadS) * 1000);
};

// ── Single-owner send lock ───────────────────────────────────────────────────
// Root-cause guard against duplicate sends. If two server processes ever run
// against this DB (a stale orphan + a fresh one), only the one holding a fresh
// heartbeat may send; every other process's send loops become no-ops. The atomic
// per-lead claim below is the belt to this suspenders.
const INSTANCE_ID = randomUUID();
const OWNER_TTL_MS = 90_000;
function setOwner(owner, ts) {
  db.prepare(
    "INSERT INTO settings (key,value) VALUES ('send_owner',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).run(JSON.stringify({ owner, ts }));
}
function iOwnSendLock() {
  let r = null;
  try { r = JSON.parse(getSetting("send_owner") || "null"); } catch { r = null; }
  const now = Date.now();
  if (!r || now - Number(r.ts || 0) > OWNER_TTL_MS) { setOwner(INSTANCE_ID, now); return true; } // stale/empty → take it
  if (r.owner === INSTANCE_ID) { setOwner(INSTANCE_ID, now); return true; } // refresh my own claim
  return false; // another live process owns the send lock
}
export function startOwnerHeartbeat() {
  try { iOwnSendLock(); } catch {}
  // Crash recovery: a lead stuck in 'sending' means we died between the pre-send claim
  // and the post-send record — the email MAY have left the building. Never auto-resend;
  // hold it out of the pool and surface it for a human call.
  try {
    const stuck = db.prepare("SELECT id, business_name FROM leads WHERE status='sending'").all();
    for (const l of stuck) {
      logEvent({ actor: "system", message: `Lead "${l.business_name}" (#${l.id}) was mid-send during a crash/restart — its email may or may not have gone out. Holding it OUT of the send pool; review it in the CRM and set it back to scraped (safe to email) or emailed (it went out).`, level: "warn" });
    }
  } catch {}
  setInterval(() => { try { iOwnSendLock(); } catch {} }, 30_000);
}

// ── Global send mutex + gap ──────────────────────────────────────────────────
// Only ONE email leaves this process at a time and the pacing gap is held INSIDE
// the lock, so the morning-run loop and the follow-up loop can no longer interleave
// into a 0–2s burst — every send, from either loop, is spaced by jitterMs().
let _sendChain = Promise.resolve();
let _lastSentDomain = "";
const domainOf = (inbox) => String(inbox || "").split("@")[1]?.toLowerCase() || "";
function pacedSendVia(args) {
  const task = _sendChain.then(async () => {
    const r = await sendVia(args);
    _lastSentDomain = domainOf(args.from);
    return r;
  });
  // Hold the pacing gap for the NEXT send (on success AND failure — failures used to
  // rapid-fire with no gap), while the CALLER resolves the moment the message is
  // accepted. The caller's emails-table INSERT now lands milliseconds after the send,
  // closing the crash window where an accepted email had no DB record and the lead
  // could be cold-emailed again on the next run.
  _sendChain = task.then(() => sleep(jitterMs()), () => sleep(jitterMs()));
  return task;
}

// ── Per-domain + global volume caps ──────────────────────────────────────────
// Per-mailbox caps alone let 3 inboxes pour ~60/day into one 6-day-old domain that
// already lands in spam. Cap the DOMAIN too (reputation is tracked per-domain), and
// keep one true daily ceiling that counts initials AND follow-ups together.
function sentTodayByDomain(domain) {
  return db
    .prepare(
      "SELECT COUNT(*) c FROM emails WHERE direction='out' AND kind IN ('initial','followup') AND sent_at >= date('now') AND lower(inbox) LIKE ?"
    )
    .get("%@" + domain).c;
}
function sentTodayTotal() {
  return db
    .prepare("SELECT COUNT(*) c FROM emails WHERE direction='out' AND kind IN ('initial','followup') AND sent_at >= date('now')")
    .get().c;
}
const domainCap = () => Number(getSetting("per_domain_cap") || 24);
const dailyCeiling = () => Number(getSetting("daily_send_ceiling") || 220);
// eligible = under its own daily cap AND its domain is under the domain cap
function inboxEligible(inbox) {
  return sentTodayByInbox(inbox) < capFor(inbox) && sentTodayByDomain(domainOf(inbox)) < domainCap();
}

// Backstop dedup: has this exact recipient address EVER received an initial, even if
// its lead row was later reset? Reads the emails table directly (join to the lead the
// email went to), so a status glitch can't resurface a burned address.
export function alreadyEmailedAddress(email) {
  if (!email) return false;
  return Boolean(
    db
      .prepare(
        "SELECT 1 FROM emails e JOIN leads l ON l.id=e.lead_id WHERE e.direction='out' AND e.kind='initial' AND lower(l.email)=lower(?) LIMIT 1"
      )
      .get(email)
  );
}

// ── Bounce circuit-breaker ───────────────────────────────────────────────────
// Google flags on sustained bounce RATE, not on one dead address. Every 30 min,
// check each active inbox's 7-day bounce rate; warn at 3%, auto-pause + Telegram at 5%.
export function startBounceGuard() {
  const check = () => {
    try {
      if (!iOwnSendLock()) return; // only the send owner manages pausing
      for (const inbox of activeInboxes().map((i) => i.email)) {
        const sent = db
          .prepare(
            "SELECT COUNT(*) c FROM emails WHERE inbox=? AND direction='out' AND kind IN ('initial','followup') AND sent_at >= datetime('now','-7 days')"
          )
          .get(inbox).c;
        if (sent < 40) continue; // need a real sample before acting
        const bounced = db
          .prepare("SELECT COUNT(*) c FROM leads WHERE lower(inbox_used)=lower(?) AND status='bounced' AND last_touch_at >= datetime('now','-7 days')")
          .get(inbox).c;
        const rate = bounced / sent;
        if (rate >= 0.05) {
          const rested = new Set(String(getSetting("paused_inboxes") || "").split(",").map((s) => s.trim()).filter(Boolean));
          if (!rested.has(inbox)) {
            rested.add(inbox);
            db.prepare("INSERT INTO settings (key,value) VALUES ('paused_inboxes',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run([...rested].join(","));
            logEvent({ actor: "system", message: `⚠️ Auto-paused ${inbox} — 7-day bounce rate ${(rate * 100).toFixed(1)}% (>5%). Resting it to protect the domain.`, level: "error" });
            sendTelegram(`🚨 Tedca OS auto-paused ${inbox} — bounce rate ${(rate * 100).toFixed(1)}% over 7 days. Investigate before resuming.`).catch(() => {});
          }
        } else if (rate >= 0.03) {
          logEvent({ actor: "system", message: `Heads up: ${inbox} 7-day bounce rate ${(rate * 100).toFixed(1)}% (watching; auto-pauses at 5%).`, level: "warn" });
        }
      }
    } catch (e) {
      logEvent({ actor: "system", message: `Bounce guard error: ${e.message}`, level: "warn" });
    }
  };
  setInterval(check, 30 * 60 * 1000);
}

let activeRun = null;
export function runningRunId() {
  return activeRun;
}

// ── Market rotation ──────────────────────────────────────────────────────────
// One metro at a time. Auto-runs (query=null) hunt the ACTIVE market; when a full
// run with scraping discovers fewer than EXHAUST_NEW_MIN never-contacted businesses,
// the market retires and the next fresh one is promoted. Exhausted markets are never
// scraped again — no Apify credits spent re-scraping a drained city.
//
// "Next" means ORDER BY state_rank, id: every city in the current state gets worked
// before we cross a border (state_rank is set in db.js from STATE_ROTATION). Ordering
// by raw id instead meant the successor was whatever city was typed in first, which
// on Sep 4 sent a drained Bergen County straight to Miami FL while four fresh NJ
// counties sat unused.
const EXHAUST_NEW_MIN = 10;
// Markets are added by hand-run SQL, so a row can appear between boots with no
// state_rank. Rank it before we sort, or SQLite's NULLS FIRST hands it the queue.
const ORDER = "ORDER BY state_rank IS NULL, state_rank, priority, id";
export function marketForToday() {
  const unplaced = syncMarketStates();
  if (unplaced.length) {
    logEvent({
      actor: "research",
      message: `Market${unplaced.length === 1 ? "" : "s"} with no readable state code, queued last: ${unplaced.join(", ")}. Rename to end in a 2-letter state ("Boise ID") to slot into the rotation.`,
      level: "warn",
    });
  }
  let m = db.prepare(`SELECT * FROM markets WHERE status='active' ${ORDER} LIMIT 1`).get();
  if (!m) {
    m = db.prepare(`SELECT * FROM markets WHERE status='fresh' ${ORDER} LIMIT 1`).get();
    if (m) {
      db.prepare("UPDATE markets SET status='active' WHERE id=?").run(m.id);
      const left = db
        .prepare("SELECT COUNT(*) n FROM markets WHERE status='fresh' AND state IS ?")
        .get(m.state ?? null)?.n ?? 0;
      const where = m.state ? `${m.state} ${left === 1 ? "city" : "cities"}` : "unplaced markets";
      logEvent({
        actor: "research",
        message: `New market opened: ${m.name}. All scraping hunts there until it dries up. ${left} more ${where} queued behind it.`,
        level: "success",
      });
    }
  }
  return m || null;
}
// Every source of leads should be visible in one place. A scrape gets a batch row
// exactly like an uploaded CSV does, so /feed shows "Chicago North Shore IL — 140
// leads, 53 ready" beside anything Ted feeds by hand. Priority 50 keeps the queue
// order identical to before (fed batches default to 10 and still go first).
export function batchForScrape(name, niche) {
  if (!name) return null;
  const existing = db.prepare("SELECT id FROM lead_batches WHERE name=? AND source='scrape'").get(name);
  if (existing) return Number(existing.id);
  const info = db
    .prepare("INSERT INTO lead_batches (name, source, niche, status, priority, row_count) VALUES (?, 'scrape', ?, 'active', 50, 0)")
    .run(name, niche || getSetting("niche") || null);
  return Number(info.lastInsertRowid);
}
// Attach freshly-ingested leads to a batch and keep its row_count honest.
export function tagLeadsWithBatch(ids, batchId) {
  if (!batchId || !ids?.length) return 0;
  const upd = db.prepare("UPDATE leads SET batch_id=? WHERE id=? AND batch_id IS NULL");
  let n = 0;
  for (const id of ids) n += upd.run(batchId, id).changes;
  db.prepare("UPDATE lead_batches SET row_count=(SELECT COUNT(*) FROM leads WHERE batch_id=?) WHERE id=?").run(batchId, batchId);
  return n;
}

function recordMarketRun(market, newCount, scraped) {
  if (!market || !scraped) return; // bank-only runs say nothing about the market
  db.prepare("UPDATE markets SET runs_used=runs_used+1, last_run_at=datetime('now'), last_new_count=? WHERE id=?").run(newCount, market.id);
  if (newCount < EXHAUST_NEW_MIN) {
    db.prepare("UPDATE markets SET status='exhausted' WHERE id=?").run(market.id);
    const next = db.prepare(`SELECT name, state FROM markets WHERE status='fresh' ${ORDER} LIMIT 1`).get();
    // Crossing a state line is worth saying out loud — it means a whole state is
    // spent, and it changes who we're writing to.
    const crossing = next && market.state && next.state && next.state !== market.state;
    const plan = next
      ? `Tomorrow hunts: ${next.name}.${crossing ? ` ${market.state} is fully drained — moving into ${next.state}.` : ""}`
      : "NO FRESH MARKETS LEFT — add more.";
    logEvent({ actor: "research", message: `${market.name} is tapped out (only ${newCount} new businesses this run) — retired, never re-scraped. ${plan}`, level: "warn" });
    if (crossing) sendTelegram(`Tedca OS: ${market.state} is fully worked. Next state up: ${next.state} (${next.name}).`).catch(() => {});
  }
}

export async function startMorningRun({ target, query }) {
  if (activeRun) throw new Error(`run ${activeRun} already in progress`);
  const niche = getSetting("niche");
  const city = getSetting("city");
  // Queue mode (auto_refill=0): the fed queue is the only supply. marketForToday()
  // has side effects (promotes the next fresh city), so it must not even be CALLED
  // unless we intend to scrape.
  const refill = Boolean(query) || autoRefill();
  const market = query || !refill ? null : marketForToday();
  // Guard: an auto-run with no city left must NOT silently re-scrape the drained
  // default city. The old `getSetting("search_query")` / `niche in city` fallback
  // re-hunted tapped-out Miami → ~0 new leads → a mystery-weak day (this starved
  // Jul 15). Stand down and ping so a human queues fresh cities. Manual runs
  // (explicit query) are unaffected.
  if (refill && !query && !market) {
    const msg = "Out of fresh cities — the market queue is empty. Skipping today's auto-run instead of re-scraping a drained city. Add cities to resume lead flow.";
    logEvent({ actor: "research", message: msg, level: "error" });
    sendTelegram(`🚨 Tedca OS: ${msg}`).catch(() => {});
    return null;
  }
  // Queue mode with nothing to send: stand down for the day (the day claim is kept,
  // so this fires once) and ask for leads. Not a failure — don't take the failure
  // path, which releases the day claim and would re-fire every scheduler tick.
  if (!refill) {
    const q = queueCounts();
    if (q.ready === 0 && q.pending === 0) {
      const msg = "Nothing to send today — the lead queue is empty. Feed leads on /feed and the next run picks them up.";
      logEvent({ actor: "research", message: msg, level: "error" });
      await maybeRunwayAlert("queue empty at run time").catch(() => {});
      return null;
    }
  }
  const searchQuery = refill ? query || market?.query || `${niche} in ${city}` : null;
  const info = db
    .prepare("INSERT INTO runs (agent, status, summary) VALUES ('cold-email', 'running', ?)")
    .run(`target ${target} · ${market ? `${market.name} · ` : ""}${searchQuery || "lead queue"}`);
  const runId = Number(info.lastInsertRowid);
  activeRun = runId;

  // fire and forget; all progress goes through the activity feed
  executeRun(runId, { target, searchQuery, market }).catch((e) => {
    logEvent({ run_id: runId, actor: "system", message: `Run failed: ${e.message}`, level: "error" });
    db.prepare("UPDATE runs SET status='failed', finished_at=datetime('now'), summary=? WHERE id=?").run(
      String(e.message).slice(0, 300),
      runId
    );
    activeRun = null;
    // give the day back: a run that FAILED shouldn't consume today's auto-run slot —
    // the scheduler's catch-up can retry later in the send window.
    db.prepare("UPDATE settings SET value='' WHERE key='last_auto_run_date' AND value=?").run(etDate());
  });
  return runId;
}

const MAX_SCRAPES_PER_RUN = 2; // cost guard: free Apify tier + $0.50 rule

// ── Verification (shared by the morning run and the verify-ahead loop) ───────
// Returns true (sendable), false (dead, stamped), "stop" (provider out of credits),
// or "error" (transient — caller must leave the row untouched so a later pass
// retries it; stamping on a failure WE caused killed 232 leads on 2026-08-26).
const defaultVerifyLog = (actor, message, level = "info") => logEvent({ actor, message, level });

// AnyMailFinder credits spent today (ET) — the verify-ahead loop's budget gate.
// Kept in settings so a restart mid-day can't reset the meter.
export function verifyCreditsToday() {
  return Number(getSetting(`verify_credits_${etDate()}`) || 0);
}
export function recordVerifyCost(credits, runId = null) {
  const n = Number(credits) || 0;
  if (n <= 0) return;
  const key = `verify_credits_${etDate()}`;
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(settings.value AS REAL) + CAST(excluded.value AS REAL) AS TEXT)"
  ).run(key, String(n));
  // keep ~30 days of meters, not one row per day forever
  db.prepare("DELETE FROM settings WHERE key LIKE 'verify_credits_%' AND key < ?").run(`verify_credits_${etDate(new Date(Date.now() - 30 * 86400000))}`);
  // dollars are plan-dependent; amf_credit_usd (settings) converts when Ted sets it
  const usd = n * Number(getSetting("amf_credit_usd") || 0);
  if (usd > 0) db.prepare("INSERT INTO costs (run_id, provider, amount_usd) VALUES (?, 'anymailfinder', ?)").run(runId, usd);
}

export async function verifyLead(id, log = defaultVerifyLog, { runId = null } = {}) {
  const lead = db.prepare("SELECT * FROM leads WHERE id=?").get(id);
  if (!lead) return false;
  if (lead.email && lead.email_status === "valid") return true;
  const fed = lead.batch_id != null; // Ted's list IS the targeting — no niche/geo screen for fed leads
  // off-niche → skip BEFORE AnyMailFinder so we never spend a credit on a non-med-spa
  if (!fed && isOffNiche(lead.category)) {
    db.prepare("UPDATE leads SET status='skipped', email_status='off_niche' WHERE id=?").run(id);
    log("verify", `${lead.business_name}: ${lead.category || "off-niche"} — not a ${getSetting("niche") || "target"} business, skipped before AnyMailFinder (no credit spent).`, "info");
    return false;
  }
  // outside the target states → skip BEFORE AnyMailFinder so we never spend a credit out-of-area
  if (!fed && isOffGeo(lead.state)) {
    db.prepare("UPDATE leads SET status='skipped', email_status='off_geo' WHERE id=?").run(id);
    log("verify", `${lead.business_name}: ${lead.state} — outside the target states, skipped before AnyMailFinder (no credit spent).`, "info");
    return false;
  }

  // ── supplied address: VERIFY it, never replace it with a CEO lookup ────────
  if (lead.supplied_email && lead.email) {
    const email = String(lead.email).trim().toLowerCase();
    if (blockedEmailDomain(email, { allowFreeMail: true })) {
      db.prepare("UPDATE leads SET status='skipped', email_status='platform', followup_due_at=NULL WHERE id=?").run(id);
      log("verify", `${lead.business_name}: ${email} is a platform address, not the owner — skipping.`, "info");
      return false;
    }
    if (emailContactedElsewhere(email, id) || alreadyEmailedAddress(email)) {
      db.prepare("UPDATE leads SET status='skipped', email_status='duplicate', followup_due_at=NULL WHERE id=?").run(id);
      log("verify", `${lead.business_name}: ${email} was already contacted — skipping so we never email the same owner twice.`, "info");
      return false;
    }
    if (isSuppressed(email)) {
      db.prepare("UPDATE leads SET status='skipped', email_status='suppressed', followup_due_at=NULL WHERE id=?").run(id);
      log("verify", `${lead.business_name}: ${email} previously bounced or opted out — skipping.`, "info");
      return false;
    }
    if (!amfConfigured()) {
      // no verifier: the MX gate is the only safety net, so be explicit about it
      const mx = await domainAcceptsMail(email);
      if (!mx.ok) {
        db.prepare("UPDATE leads SET status='skipped', email_status='undeliverable', followup_due_at=NULL WHERE id=?").run(id);
        suppress(email);
        log("verify", `${lead.business_name}: ${email} cannot receive mail (${mx.reason}) — skipping.`, "warn");
        return false;
      }
      // NOT 'valid' — nothing verified this address. A distinct status keeps the CRM
      // honest and keeps queueCounts() from reporting it as ready-to-send.
      db.prepare("UPDATE leads SET email=?, email_status='mx_only' WHERE id=?").run(email, id);
      log("verify", `${lead.business_name}: no verifier configured — ${email} passed the MX check only, not verified.`, "warn");
      return true;
    }
    try {
      const r = await verifyEmail(email);
      if (r.status === "no_credits") {
        log("verify", "My email-verification credits ran out — I cannot confirm any more addresses today.", "error");
        return "stop";
      }
      recordVerifyCost(r.credits, runId);
      if (r.ok) {
        db.prepare("UPDATE leads SET email=?, email_status='valid' WHERE id=?").run(email, id);
        log("verify", `${lead.business_name}: ${email} confirmed real — ready to contact.`, "success");
        return true;
      }
      // invalid / risky / unknown → dead for sending; keep the row for the CRM
      const st = r.status === "invalid" ? "invalid" : r.status === "risky" ? "risky" : "unknown";
      db.prepare("UPDATE leads SET status='skipped', email_status=?, followup_due_at=NULL WHERE id=?").run(st, id);
      log("verify", `${lead.business_name}: ${email} did not verify (${st}) — skipping so we never bounce.`, "info");
      return false;
    } catch (e) {
      log("verify", `Hit a snag verifying ${lead.business_name}: ${e.message}`, "warn");
      return "error";
    }
  }

  if (!amfConfigured()) return Boolean(lead.email); // no key: use scraped email as-is
  if (!lead.domain && !lead.business_name) {
    db.prepare("UPDATE leads SET email_status='unknown' WHERE id=?").run(id);
    return false;
  }
  try {
    const r = await findCeo({ domain: lead.domain, companyName: lead.business_name });
    if (r.status === "no_credits") {
      log("verify", "My email-finding credits ran out — I cannot confirm any more owner emails today.", "error");
      return "stop";
    }
    recordVerifyCost(r.credits, runId);
    if (r.ok && blockedEmailDomain(r.email)) {
      // AMF matched a platform/aggregator (e.g. a Google Maps URL → google.com).
      // Not the owner — record it but never send.
      db.prepare("UPDATE leads SET email_status='platform' WHERE id=?").run(id);
      log("verify", `${lead.business_name}: the only email found was a platform address (${r.email}) — skipping, that is not the owner.`, "info");
      return false;
    }
    if (r.ok && emailContactedElsewhere(r.email, id)) {
      // same owner email as a lead we've already emailed (e.g. another branch of a
      // chain) → record it but never queue, so we never email the same person twice.
      db.prepare("UPDATE leads SET email=?, email_status='duplicate', status='skipped', followup_due_at=NULL WHERE id=?").run(r.email, id);
      log("verify", `${lead.business_name}: ${r.email} is already a contacted lead — skipping so we never email the same owner twice.`, "info");
      return false;
    }
    if (r.ok && isSuppressed(r.email)) {
      db.prepare("UPDATE leads SET email=?, email_status='suppressed', status='skipped', followup_due_at=NULL WHERE id=?").run(r.email, id);
      log("verify", `${lead.business_name}: ${r.email} previously bounced or opted out — skipping.`, "info");
      return false;
    }
    if (r.ok) {
      db.prepare(
        "UPDATE leads SET email=?, email_status='valid', ceo_name=COALESCE(?, ceo_name), contact_title=COALESCE(?, contact_title), linkedin_url=COALESCE(?, linkedin_url) WHERE id=?"
      ).run(r.email, r.name ?? null, r.title ?? null, r.linkedin ?? null, id);
      log("verify", `${lead.business_name}: found the owner — ${r.email}${r.name ? ` (${r.name})` : ""}${r.linkedin ? " + LinkedIn" : ""}.`, "success");
      return true;
    }
    // not valid — still keep any name/title/LinkedIn AMF returned, for the CRM
    db.prepare(
      "UPDATE leads SET email_status=?, ceo_name=COALESCE(?, ceo_name), contact_title=COALESCE(?, contact_title), linkedin_url=COALESCE(?, linkedin_url) WHERE id=?"
    ).run(r.status || "unknown", r.name ?? null, r.title ?? null, r.linkedin ?? null, id);
    log("verify", `${lead.business_name}: could not find a safe owner email — skipping so we never bounce.`, "info");
    return false;
  } catch (e) {
    // Transient failure (no network, DNS, timeout, provider 5xx) is NOT a real
    // "no owner email found". Return "error" so the caller leaves the lead
    // UNLATCHED and a later run retries it. Returning false here stamped
    // email_status='unknown', which permanently removed the lead from every
    // future pool: on 2026-08-26 an 8am run with no network killed 232 leads
    // this way while spending zero provider credits.
    log("verify", `Hit a snag looking up ${lead.business_name}: ${e.message}`, "warn");
    return "error";
  }
}

// Post-verify bookkeeping shared by the run's producer and the verify-ahead loop.
// "error" is deliberately NOT handled here: the row must stay untouched.
export function settleVerify(id, verdict) {
  if (verdict === "error" || verdict === "stop") return;
  // consumed from the pool either way so we don't re-verify endlessly
  db.prepare("UPDATE leads SET banked=0 WHERE id=?").run(id);
  if (!verdict) {
    // dead lead: keep in CRM but out of future pools
    db.prepare("UPDATE leads SET status='scraped', banked=0, email_status=COALESCE(email_status,'unknown') WHERE id=? AND email IS NULL AND status='scraped'").run(id);
  }
}

// ── Lead queue ───────────────────────────────────────────────────────────────
// The queue is every lead that is still sendable-or-pending. Fed batches sort
// first (priority 10 by default); scraped leftovers sort as 50. Paused/archived
// batches are held out entirely.
// b.id IS NULL covers a lead whose batch row was deleted: without it the LEFT JOIN
// yields b.status=NULL and every lead in that batch is stranded forever.
const QUEUE_FROM =
  "FROM leads l LEFT JOIN lead_batches b ON b.id = l.batch_id " +
  "WHERE l.status='scraped' AND (l.batch_id IS NULL OR b.id IS NULL OR b.status='active')";
const QUEUE_ORDER = "ORDER BY COALESCE(b.priority, 50), CASE WHEN l.email_status='valid' THEN 0 ELSE 1 END, l.banked DESC, l.id";
export const autoRefill = () => getSetting("auto_refill") === "1";
export function queueCounts() {
  const ready = db.prepare(`SELECT COUNT(*) c ${QUEUE_FROM} AND l.email_status='valid' AND l.email IS NOT NULL`).get().c;
  const pending = db.prepare(`SELECT COUNT(*) c ${QUEUE_FROM} AND l.email_status IS NULL`).get().c;
  return { ready, pending };
}
export function queuePick(limit, { pendingOnly = false } = {}) {
  const pred = pendingOnly ? "AND l.email_status IS NULL" : "AND (l.email_status IS NULL OR l.email_status='valid')";
  return db.prepare(`SELECT l.id ${QUEUE_FROM} ${pred} ${QUEUE_ORDER} LIMIT ?`).all(limit).map((r) => r.id);
}

// Observed AnyMailFinder valid share over the last 30 days (floor 0.35 while the
// sample is thin) — used to price a batch and to estimate runway from pending rows.
export function observedValidRate() {
  const r = db
    .prepare(
      "SELECT SUM(email_status='valid') v, COUNT(*) n FROM leads WHERE email_status IS NOT NULL AND email_status NOT IN ('off_niche','off_geo','duplicate','dup_recipient','suppressed') AND scraped_at >= datetime('now','-30 day')"
    )
    .get();
  if (!r || !r.n || r.n < 50) return 0.35;
  return Math.max(0.1, Math.min(0.95, r.v / r.n));
}
// How many days the queue covers. perDay is the SMALLER of daily_target and what
// the eligible inboxes can actually push, so the estimate never flatters.
export function queueRunway() {
  const { ready, pending } = queueCounts();
  const validRate = observedValidRate();
  const target = Number(getSetting("daily_target") || 100);
  let capacity = 0;
  try { for (const i of activeInboxes()) capacity += capFor(i.email); } catch { capacity = target; }
  const perDay = Math.max(1, Math.min(target, capacity || target));
  const expected = ready + pending * validRate;
  return { ready, pending, validRate: Number(validRate.toFixed(2)), perDay, expected: Math.round(expected), days: Number((expected / perDay).toFixed(1)) };
}
export function runwayLine(r = queueRunway()) {
  return `Queue: ${r.ready} ready, ${r.pending} waiting on verification (~${r.days} day${r.days === 1 ? "" : "s"} at ${r.perDay}/day)`;
}
// One "feed me" Telegram per ET day when runway drops under runway_alert_days.
export async function maybeRunwayAlert(reason = "") {
  const r = queueRunway();
  const threshold = Number(getSetting("runway_alert_days") || 3);
  if (r.days >= threshold) return false;
  const today = etDate();
  if (getSetting("runway_alert_date") === today) return false;
  db.prepare("INSERT INTO settings (key, value) VALUES ('runway_alert_date', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(today);
  const url = `${process.env.PUBLIC_URL || "http://localhost:5173"}/feed`;
  const msg = `🥣 Tedca OS needs leads${reason ? ` (${reason})` : ""}.\n${runwayLine(r)}.\nFeed a CSV / paste / Sheet → ${url}`;
  logEvent({ actor: "intake", message: `${runwayLine(r)} — under the ${threshold}-day line, asked Ted for more leads.`, level: "warn" });
  await sendTelegram(msg).catch(() => {});
  return true;
}

async function executeRun(runId, { target, searchQuery, market = null }) {
  const log = (actor, message, level = "info") => logEvent({ run_id: runId, actor, message, level });
  let newDiscovered = 0; // never-contacted businesses found by this run's scrapes (market exhaustion signal)
  let scrapeCompleted = false; // ONLY a scrape that actually returned results is exhaustion evidence — a fetch that died (Jul 7 DNS blip) says nothing about the market

  // ── Step 1: Scout — the brief ──────────────────────────────────────────────
  log("research", searchQuery
    ? `Good morning. Today's plan: find ${target} ${getSetting("niche")} leads ("${searchQuery}") and email each one's owner.`
    : `Good morning. Today's plan: email ${target} owners from the lead queue (no scraping — auto-refill is off).`, "info");

  // Producer/consumer: Inspector keeps a queue of verified leads topped up
  // (scraping more when supply runs dry) WHILE Courier sends from the queue.
  const queue = [];
  const enqueued = new Set(); // never queue the same lead twice → no duplicate sends
  let producing = true;
  let scrapesUsed = 0;

  const verifyOne = (id) => verifyLead(id, log, { runId });

  async function producer() {
    let supplied = 0;
    // If the provider is unreachable, every lookup fails instantly. Abort the run
    // rather than churn the whole bank through a dead network.
    const VERIFY_ERROR_ABORT = 5;
    let consecutiveErrors = 0;
    try {
      while (supplied < target) {
        // take whatever unworked leads we have (bank + freshly scraped)
        // exclude leads already screened-and-failed (email_status set but no usable email)
        const pool = queuePick(target * 3);

        let pushedThisPass = 0;
        for (const id of pool) {
          if (supplied >= target) break;
          const v = await verifyOne(id);
          if (v === "stop") return;
          if (v === "error") {
            // Transient: leave the lead untouched (still banked, still eligible) so
            // it is retried later. Never mark it dead on a failure we caused.
            if (++consecutiveErrors >= VERIFY_ERROR_ABORT) {
              log(
                "verify",
                `${consecutiveErrors} lookups in a row could not reach the email provider — stopping this run so the rest of the bank stays usable. No leads were marked dead.`,
                "error"
              );
              return;
            }
            continue;
          }
          consecutiveErrors = 0;
          settleVerify(id, v);
          if (v && !enqueued.has(id)) {
            queue.push(id);
            enqueued.add(id);
            supplied++;
            pushedThisPass++;
          }
        }

        if (supplied >= target) break;

        // Queue mode (default): the fed queue is the supply. When it can't cover the
        // day we send what we have and ask for more — we do NOT go dig up a city.
        if (!autoRefill() || !searchQuery) {
          const q = queueCounts();
          log("scrape", `Queue is empty for today: ${supplied} of ${target} ready, ${q.pending} still waiting on verification. Feed more leads on /feed (auto-refill is off, so no scraping).`, supplied ? "warn" : "error");
          break;
        }

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
        // cap per-search so the synchronous Apify scrape always finishes inside its
        // 5-minute limit (720-in-one-shot was timing out → 0 leads → 0 sends).
        const perSearch = Math.min(Math.max(Math.ceil((deficit * 3) / nSearches), 10), 20);
        log("scrape", `Not enough leads yet (${supplied} of ${target} ready). Going to Google Maps for more businesses — emails keep going out in the meantime. (scrape ${scrapesUsed} of ${MAX_SCRAPES_PER_RUN} allowed today)`, "warn");
        const scraped = await runScrapeJob(runId, { search: searchQuery, limit: perSearch });
        const inserted = ingestLeads(scraped, searchQuery);
        // show this scrape on the Feed page alongside uploaded batches
        if (market?.name) tagLeadsWithBatch(inserted, batchForScrape(market.name, getSetting("niche")));
        newDiscovered += inserted.length;
        scrapeCompleted = true;
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

  // start with the queue — count only what can actually be sent (valid) or is still
  // pending. The old "N saved leads" line counted rows that had ALREADY failed
  // verification, which is how a 1,439-lead "bank" produced a zero-send day.
  {
    const q = queueCounts();
    log("scrape", `Checking the lead queue first: ${q.ready} ready to send, ${q.pending} waiting on verification${q.ready >= target ? " — that covers today" : ""}.`, "info");
  }

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

  // bank whatever wasn't emailed today — ALIVE rows only (valid or still pending).
  // Re-banking dead rows is what made the bank count lie.
  const leftovers = db
    .prepare("SELECT COUNT(*) c FROM leads WHERE status='scraped' AND (email_status='valid' OR email_status IS NULL)")
    .get().c;
  db.prepare("UPDATE leads SET banked=1 WHERE status='scraped' AND (email_status='valid' OR email_status IS NULL)").run();
  db.prepare("UPDATE leads SET banked=0 WHERE status='scraped' AND banked=1 AND email_status IS NOT NULL AND email_status<>'valid'").run();
  log("scrape", `Saved ${leftovers} untouched lead${leftovers === 1 ? "" : "s"} in the queue for tomorrow (free head start).`, "info");

  db.prepare("UPDATE runs SET status='done', finished_at=datetime('now'), summary=? WHERE id=?").run(
    `${sent} emailed, ${leftovers} banked`,
    runId
  );
  // market bookkeeping: retire the metro only when a COMPLETED scrape stops yielding
  // new businesses (a failed fetch is not evidence — it wrongly retired Scottsdale once)
  recordMarketRun(market, newDiscovered, scrapeCompleted);
  const runway = queueRunway();
  log("system", `Morning run finished. ${sent} email${sent === 1 ? "" : "s"} sent. ${runwayLine(runway)}.`, "success");
  await sendTelegram(
    `☀️ Morning run done\n· ${sent} emails sent\n· ${runwayLine(runway)}\n· source: ${searchQuery || "lead queue"}\nDashboard → ${process.env.PUBLIC_URL || "https://tedca-os-production.up.railway.app"}`
  );
  activeRun = null;
  await maybeRunwayAlert("after today's run").catch(() => {});
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

// Google Maps loosely matches "dentist in <city>" and returns nearby businesses
// that aren't dental practices (we've seen pharmacies, urgent care, medical labs,
// insurance offices). We drop those at scrape time so we never spend an
// AnyMailFinder credit or a send on them.
//
// HYBRID rule: block a category only if it matches OFF_NICHE_CATEGORY AND does NOT
// match ON_NICHE_CATEGORY. ON always wins, so dental-adjacent specialties (oral
// surgery, endo/perio/prostho, pediatric dentistry, a practice mis-tagged "Medical
// clinic", "cosmetic dentist", etc.) are never lost.
//
// HARD_OFF_CATEGORY bypasses the hybrid rule. These all contain the word "dental",
// so ON_NICHE would otherwise rescue them, but a lab / supplier / school is not a
// practice and can never become a customer.
const ON_NICHE_CATEGORY = /dentist|dental|orthodont|endodont|periodont|prosthodont|oral surg|maxillofacial|oral (?:health|care|medicine)|denture|implantolog|invisalign|\bbraces\b|teeth whiten|smile (?:design|makeover|studio|center|centre)|pedodont|sedation dent|cosmetic dent|family dent|general dent|emergency dent|\btmj\b/i;
const HARD_OFF_CATEGORY = /dental laborator|dental lab\b|dental suppl|dental equipment|dental school|dental insurance|dental museum/i;
const OFF_NICHE_CATEGORY = /cannabis|dispensary|smoke shop|vape|\brestaurant\b|\bcafe\b|coffee shop|bakery|brewery|grocery|\bdeli\b|barber|nail (?:salon|bar|spa)|hair salon|tattoo (?:parlor|shop|studio|artist)|tanning|\bgym\b|fitness|crossfit|yoga studio|pharmacy|drugstore|med(?:i|ical)?[ -]?spa|day spa|massage|botox|laser hair|dermatolog|plastic sur|chiropract|veterinar|\bauto\b|car wash|car dealer|automotive|gas station|attorney|law firm|lawyer|accountant|real estate|insurance|\bbank\b|church|temple|mosque|\bschool\b|university|college|daycare|hospital|urgent care|family (?:practice|medicine)|primary care|walk-in|pediatric|gynecolog|obstetric|ob-?gyn|optometr|ophthalmolog|podiatr|orthopedic|cardiolog|psychiatr|psycholog|physical therapy|acupuncture|urolog|gastroenterolog|oncolog|radiolog|neurolog|internal medicine|otolaryngolog|ear,? nose|cosmetics? store|beauty supply|perfume|jewelry|florist|clothing|furniture|hardware|funeral|laundromat|hotel|motel|pet (?:store|groom)|\bassociation\b|organization|government/i;
// True when a category is clearly NOT a dental practice (and not dental-adjacent).
// Used to drop leads at scrape time AND again right before AnyMailFinder, so we never
// spend a verification credit on a pharmacy, a hospital, a dental lab, an insurer.
export function isOffNiche(category) {
  const c = String(category || "");
  if (!c) return false;
  if (HARD_OFF_CATEGORY.test(c)) return true;
  return OFF_NICHE_CATEGORY.test(c) && !ON_NICHE_CATEGORY.test(c);
}

// Geo guard: we only target the states we actively queue markets in. This whitelist
// MUST stay in sync with the states in the `markets` table — otherwise a queued city
// leaks (leads that come back with an explicit out-of-whitelist state get dropped,
// which quietly halves that city's yield). Google/Apify sometimes broaden a keyword
// search once an area is tapped out and return truly off-target places; we drop a lead
// only when its state is KNOWN and not whitelisted — most genuine leads come back with
// a NULL state, and a country-only "US"/"USA" is still unknown, so BOTH are kept
// (never block on a guess).
const TARGET_STATE = /new jersey|new york|pennsylvania|connecticut|florida|texas|california|arizona|georgia|north carolina|tennessee|colorado|nevada|utah|illinois|massachusetts|(?<!west )virginia|maryland|washington|ohio|michigan|minnesota|indiana|wisconsin|missouri|south carolina|oregon|idaho|^\s*(nj|ny|pa|ct|fl|tx|ca|az|ga|nc|tn|co|nv|ut|il|ma|va|md|wa|oh|mi|mn|in|wi|mo|sc|or|id)\.?\s*$/i;
const COUNTRY_ONLY = /^(us|u\.?\s?s\.?\s?a?\.?|united states)$/i;
export function isOffGeo(state) {
  const s = String(state || "").trim();
  if (!s || COUNTRY_ONLY.test(s) || TARGET_STATE.test(s)) return false;
  return true; // any other named state/country → outside New Jersey
}

export function ingestLeads(items, source) {
  const insert = db.prepare(`
    INSERT INTO leads (business_name, domain, category, rating, review_count, website, email, email_status, source, city, state, scraped_at, status, banked)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), 'scraped', 0)
  `);
  // Dedup keys from everything already in the DB (and grown within this batch).
  // Real domain = same business. For leads with no real domain (no website, or a
  // shared platform "website"), fall back to the normalized name. We never dedup on
  // a shared domain (google.com / sites.google.com), which dozens of leads share.
  const seenDomains = new Set();      // real business domains
  const seenNamelessKeys = new Set(); // normalized names of leads WITHOUT a real domain
  for (const r of db.prepare("SELECT business_name, domain FROM leads").all()) {
    const rd = realDomain(r.domain);
    if (rd) seenDomains.add(rd);
    else seenNamelessKeys.add(normName(r.business_name));
  }
  const ids = [];
  for (const it of items) {
    const name = it.title || it.name || it.business_name;
    if (!name) continue;
    const category = it.categoryName || it.category || "";
    if (isOffNiche(category)) continue; // off-niche → never enters the pipeline
    if (isOffGeo(it.state || it.countryCode)) continue; // outside NJ → never enters the pipeline
    const website = it.website || it.url || null;
    const domain = domainFromWebsite(website);
    // DEDUP: same real domain = same business; otherwise fall back to the name.
    const rd = realDomain(domain);
    const nameKey = normName(name);
    if (rd) {
      if (seenDomains.has(rd)) continue; // already have this business
    } else if (seenNamelessKeys.has(nameKey)) {
      continue; // no-website business we already have by name
    }
    const info = insert.run(
      name,
      domain,
      it.categoryName || it.category || null,
      it.totalScore ?? it.rating ?? null,
      it.reviewsCount ?? it.review_count ?? null,
      website,
      it.email || null,
      null, // pending verification either way ('unknown' is a DEAD marker — it would hide a scraped email from the pool)
      source,
      it.city || null,
      it.state || it.countryCode || null
    );
    ids.push(Number(info.lastInsertRowid));
    if (rd) seenDomains.add(rd);
    else seenNamelessKeys.add(nameKey); // catch duplicates within the same batch too
  }
  return ids;
}

// ── sender: caps, rotation, jitter, test mode ────────────────────────────────
const NAME_TITLES = /^(dr|mr|mrs|ms|miss|mx|prof|professor|sir|madam|md|dds|do)\.?$/i;
export function fillTemplate(tpl, lead, senderName = "Ted") {
  // callback replacers avoid $-pattern expansion ($&, $$, …) from lead text;
  // clean() strips CR/LF so a scraped name can't inject email headers.
  const clean = (v) => String(v).replace(/[\r\n]+/g, " ");
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  // first name: skip titles ("Dr." → use the actual name, else "there"), strip
  // trailing punctuation, so we never send "hey Dr.," or "hey ,".
  const parts = String(lead.ceo_name || "").trim().split(/\s+/).filter(Boolean);
  let first = parts[0] || "there";
  if (NAME_TITLES.test(first)) first = parts[1] && !NAME_TITLES.test(parts[1]) ? parts[1] : "there";
  first = first.replace(/[.,;:]+$/, "") || "there";

  // tidyName: scraped Maps names look like mass-blast data. Strip taglines,
  // colon subtitles, " at <City>" location tags, legal suffixes (LLC/Inc/…),
  // fix "Dr.Faina"→"Dr. Faina", and cap length so the name reads conversational.
  const tidyName = (raw) => {
    let n = String(raw || "");
    n = n.split(/\s+[-–—|/]\s+/)[0]; // dash/pipe/slash tagline
    n = n.split(/:\s+/)[0]; // "House of Ness: Ness Medical" → "House of Ness"
    // \s+ not \s*: a colon with NO space is part of the name ("Re:nu 180 Medspa"
    // was being cut to "Re"), while a subtitle colon always has a space after it.
    n = n.split(/,\s*/)[0]; // comma location list
    n = n.split(/\s+at\s+[A-Z]/)[0]; // " at Clifton" location tag
    n = n.split(/\s*\(/)[0]; // "(Formerly Banasiak & Nettune…)" parenthetical
    n = n.replace(/[\s,]+(LLC|L\.L\.C\.|Inc\.?|Incorporated|Co\.?|Corp\.?|Ltd\.?|PLLC|P\.?C\.?|LLP|MD)\b\.?$/i, "");
    n = n.replace(/[\s,]+(NJ|NY|PA|CT|New Jersey|New York)\b\.?$/i, ""); // trailing state tag
    n = n.replace(/[\s,]+(LLC|Inc\.?|Co\.?|Corp\.?|Ltd\.?|PLLC|P\.?C\.?|LLP|MD)\b\.?$/i, ""); // suffix before state
    n = n.replace(/\b(Dr|Mr|Mrs|Ms|St)\.([A-Za-z])/g, "$1. $2"); // missing space after title
    n = n.trim();
    if (n.length > 40) {
      let acc = "";
      for (const w of n.split(/\s+/)) { if ((acc + " " + w).trim().length > 40) break; acc = (acc + " " + w).trim(); }
      n = acc || n.slice(0, 40).trim();
    }
    // Both the state-strip above and the 40-char cap can leave a trailing
    // connector: "Aesthetic Center of New Jersey" → "Aesthetic Center of", and
    // "True Bliss Medical Aesthetics and Wellness" → "…Aesthetics and". Sent as-is
    // that reads "how the math works for Aesthetic Center of?" — 25 live leads hit
    // this. Peel connectors until the name ends on a real word.
    let prev;
    do {
      prev = n;
      n = n.replace(/[\s,]+(of|and|the|at|for|in|with|to|by|&)\.?$/i, "").trim();
    } while (n !== prev);
    return n.trim();
  };

  // social proof: only cite numbers when we actually have them, otherwise use a
  // clean non-numeric line — never "great stars across many reviews".
  // Only cite numbers when they actually flatter. "5 stars across 4 reviews" reads
  // worse than saying nothing, so a thin review count falls back to the
  // non-numeric line. 19 dental leads currently sit under this bar.
  const hasStats = lead.rating != null && lead.review_count != null && Number(lead.review_count) >= 10;
  // Reads as a clause after the business name: "saw {business_name} {social_proof}."
  // The city is appended only when we actually have one, and the whole thing falls
  // back to a stats-free line for the ~1.4% of leads with no rating/review data —
  // otherwise those sends read "has  stars across  reviews", which is worse than
  // no personalisation at all. No em dashes: they read as an AI tell.
  const inCity = lead.city && String(lead.city).trim() ? ` in ${String(lead.city).trim()}` : "";
  const socialProof = hasStats
    ? pick([
        `has ${lead.rating} stars across ${lead.review_count} reviews${inCity}, clearly the team is busy`,
        `is sitting on ${lead.rating} stars across ${lead.review_count} reviews${inCity}, the team is clearly busy`,
        `has ${lead.rating} stars from ${lead.review_count} reviews${inCity}, clearly keeping people happy`,
      ])
    : pick([
        `is clearly keeping the team busy${inCity}`,
        `has a reputation${inCity} that speaks for itself`,
        `is clearly doing something right${inCity}`,
      ]);

  let out = String(tpl)
    .replaceAll("{business_name}", () => clean(tidyName(lead.business_name) || "your business"))
    .replaceAll("{first_name}", () => clean(first))
    .replaceAll("{social_proof}", () => socialProof)
    .replaceAll("{category}", () => clean(lead.category || "business"))
    .replaceAll("{city}", () => clean(lead.city || "your area"))
    .replaceAll("{rating}", () => (lead.rating != null ? String(lead.rating) : "great"))
    .replaceAll("{review_count}", () => (lead.review_count != null ? String(lead.review_count) : "many"))
    .replaceAll("{sender_name}", () => clean(senderName));
  // spintax: {a|b|c} → a random pick PER SEND, so no two emails are byte-identical
  // (defeats the bulk-content fingerprinting that lands repeated copy in spam).
  out = out.replace(/\{([^{}]*\|[^{}]*)\}/g, (_, opts) => {
    const choices = opts.split("|");
    return choices[Math.floor(Math.random() * choices.length)];
  });
  return out;
}

// who the email is signed as — the sending inbox's persona (April, Brandon, …),
// falling back to a capitalized local-part so it always matches the From name.
// Optional per-batch subject/body (NULL = use the global settings templates).
// One indexed primary-key read per lead — no cache, so a template edited mid-run
// takes effect on the very next send instead of being served stale.
export function batchTemplates(batchId) {
  if (!batchId) return { subject: null, body: null };
  const b = db.prepare("SELECT template_subject subject, template_body body FROM lead_batches WHERE id=?").get(batchId) || {};
  return { subject: b.subject || null, body: b.body || null };
}
export function senderNameFor(inbox) {
  const n = smtpFirstName(inbox);
  if (n) return n;
  const local = String(inbox || "").split("@")[0].replace(/[._-]+/g, " ").split(" ")[0];
  return local ? local.charAt(0).toUpperCase() + local.slice(1) : "Ted";
}

function sentTodayByInbox(inbox) {
  return db
    .prepare("SELECT COUNT(*) c FROM emails WHERE inbox=? AND direction='out' AND kind IN ('initial','followup') AND sent_at >= date('now')")
    .get(inbox).c;
}

// daily cap per inbox. The Zapmail inboxes are pre-warmed, so they honor the
// explicit per_inbox_cap setting (Ted's call: 20/inbox) rather than the fresh-
// inbox age ramp. The ramp (smtpInboxCap) is kept only as a safety ceiling so a
// fat-fingered setting can't push a young inbox past its safe daily number.
function capFor(inbox) {
  const flat = Number(getSetting("per_inbox_cap") || 20);
  if (!isSmtp(inbox)) return flat;
  // The age ramp is a real ceiling now: a young inbox is capped at its ramp value
  // (12 → 50 over its first week), the flat setting otherwise. Pre-warmed inboxes
  // return a high ramp (9999) so they get the flat cap. min() = the lower of the two.
  const ramp = smtpInboxCap(inbox);
  return ramp > 0 ? Math.min(flat, ramp) : flat;
}

// When to schedule a follow-up: N (sometimes N+1) days out, at a RANDOM business-hour
// time — NOT the initial's exact clock time. Mirroring the send minute every time is a
// robotic tell and can land a follow-up right at the 5pm window edge. Stored UTC; the
// 13:00–18:59 UTC band ≈ 9am–2pm ET in both EDT/EST, always inside the 8–17 ET send
// window. The random hour+minute also spreads follow-ups across the day instead of
// firing them in a burst. (Ted, 2026-06-30.)
function followupDueAt(days) {
  const d = new Date();
  const dayJitter = Math.random() < 0.35 ? 1 : 0; // ~1/3 land a day later for natural spread
  d.setUTCDate(d.getUTCDate() + Number(days || 3) + dayJitter);
  d.setUTCHours(13 + Math.floor(Math.random() * 6), Math.floor(Math.random() * 60), 0, 0);
  return d.toISOString().slice(0, 19).replace("T", " "); // 'YYYY-MM-DD HH:MM:SS' UTC
}

// CAN-SPAM: every cold send needs an opt-out and a physical mailing address.
// Stored as the `compliance_footer` setting; appended to the body before send.
function withCompliance(body) {
  const footer = getSetting("compliance_footer");
  return footer ? `${body}\n\n${footer}` : body;
}

// Platforms / aggregators. When a scraped "website" is really a Google Maps link,
// a Linktree, or a booking tool, AnyMailFinder resolves it to that PLATFORM's owner
// (e.g. sundar@google.com) and marks it "valid". Those are never the business
// owner — block them so we never email Sundar Pichai.
const PLATFORM_EMAIL_DOMAINS = new Set([
  "google.com", "googlemail.com", "linktr.ee", "glossgenius.com", "booksy.com",
  "vagaro.com", "fresha.com", "squareup.com", "square.site", "zoca.com",
  "instagram.com", "facebook.com", "fb.com", "yelp.com", "wixsite.com",
  "wix.com", "godaddy.com", "weebly.com", "wordpress.com", "blogspot.com",
  "union.edu",
]);
// Consumer free-mail. An AnyMailFinder *find* that lands on gmail.com is a guess at
// some random mailbox, not the owner → blocked. But an address Ted SUPPLIED in a
// lead file (supplied_email=1) is a real contact who happens to use Gmail → allowed,
// still verified before sending. blockedEmailDomain(email, {allowFreeMail}) picks.
const FREE_MAIL_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com",
  "me.com", "live.com", "msn.com", "ymail.com", "protonmail.com", "proton.me",
]);
// union — used for dedupe keys (isSharedDomain), where both sets are "not a business domain"
const BLOCKED_EMAIL_DOMAINS = new Set([...PLATFORM_EMAIL_DOMAINS, ...FREE_MAIL_DOMAINS]);
// ── final pre-send deliverability gate ──────────────────────────────────────
// AnyMailFinder validated the address when it was found, but that can be days or
// weeks stale: domains lapse, get parked, or drop their mail service. A domain with
// NO MX records cannot accept mail from anyone, so sending is a guaranteed bounce.
// One DNS lookup, cached per run, catches that.
//
// Fails OPEN on purpose. A DNS timeout is not evidence the domain is dead, and
// treating a transient failure as a verdict is exactly the bug that killed 232 leads
// on 2026-08-26. We only skip on a definitive "this domain has no mail exchanger".
const mxCache = new Map();
export async function domainAcceptsMail(email) {
  const domain = String(email || "").split("@")[1]?.toLowerCase();
  if (!domain) return { ok: false, reason: "no domain" };
  if (mxCache.has(domain)) return mxCache.get(domain);
  let verdict = { ok: true, reason: "" };
  try {
    const records = await dns.resolveMx(domain);
    if (!records || records.length === 0) verdict = { ok: false, reason: "no MX records" };
  } catch (e) {
    // NXDOMAIN / NODATA are definitive: nothing can receive mail there.
    if (e.code === "ENOTFOUND" || e.code === "ENODATA") verdict = { ok: false, reason: e.code === "ENOTFOUND" ? "domain does not resolve" : "no MX records" };
    // anything else (timeout, SERVFAIL, no network) → fail open, send anyway
  }
  mxCache.set(domain, verdict);
  return verdict;
}

export function blockedEmailDomain(email, { allowFreeMail = false } = {}) {
  const dom = String(email || "").split("@")[1]?.toLowerCase().trim();
  if (!dom) return false;
  if (PLATFORM_EMAIL_DOMAINS.has(dom)) return true;
  return !allowFreeMail && FREE_MAIL_DOMAINS.has(dom);
}

// ── Deduplication ────────────────────────────────────────────────────────────
// Goal: never email the same person twice, and never keep duplicate business rows.
// A *real* business domain is the dedup key. Site-builders / social / booking tools
// are NOT — dozens of unrelated med spas can share "sites.google.com" or have a
// Google Maps URL (→ google.com) as their only "website", so those must be excluded
// or we'd wrongly merge hundreds of distinct businesses into one.
const SHARED_SITE_DOMAINS = new Set([
  "sites.google.com", "business.site", "wixsite.com", "squarespace.com",
  "godaddysites.com", "weebly.com", "wordpress.com", "blogspot.com",
  "beacons.ai", "mystrikingly.com", "g.page", "page.link",
]);
export function isSharedDomain(domain) {
  const d = String(domain || "").toLowerCase().trim();
  if (!d) return false;
  if (BLOCKED_EMAIL_DOMAINS.has(d) || SHARED_SITE_DOMAINS.has(d)) return true;
  for (const s of BLOCKED_EMAIL_DOMAINS) if (d.endsWith("." + s)) return true; // maps.google.com
  for (const s of SHARED_SITE_DOMAINS) if (d.endsWith("." + s)) return true;   // myspa.wixsite.com
  return false;
}
export const normName = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
export const realDomain = (domain) => (domain && !isSharedDomain(domain) ? String(domain).toLowerCase() : null);
// "https://www.Smile-Dental.com/about" → "smile-dental.com"; bare "smile-dental.com" works too
export function domainFromWebsite(website) {
  if (!website) return null;
  try {
    const w = String(website).trim();
    return new URL(w.startsWith("http") ? w : `https://${w}`).hostname.replace(/^www\./, "").toLowerCase() || null;
  } catch {
    return null;
  }
}

// Has this email already been engaged through a DIFFERENT lead row? Covers
// multi-location chains (one owner email, many branches), re-scrapes, alias rows,
// and manual imports — anything we've emailed, that replied, bounced, or opted out.
// This is the bulletproof guarantee: even a duplicate that slips past ingest dedup
// can never be emailed a second time.
export function emailContactedElsewhere(email, exceptId) {
  if (!email) return false;
  return Boolean(
    db
      .prepare(
        "SELECT 1 FROM leads WHERE lower(email)=lower(?) AND id<>? AND status IN ('emailed','followup_sent','replied','bounced','do_not_contact') LIMIT 1"
      )
      .get(email, exceptId)
  );
}

// Which inboxes the live campaign may send from. Ted's call: send ONLY through
// the 12 pre-warmed Zapmail (SMTP) inboxes. The send_transport setting gates it:
//   "smtp"  → Zapmail only (default for this campaign)
//   "gmail" → tedcas.org Gmail-API only
//   (unset) → every connected inbox
function activeInboxes() {
  const all = sendingInboxes();
  const t = getSetting("send_transport");
  // "rested" inboxes — paused to warm up / recover deliverability (comma-separated emails)
  const rested = new Set(
    String(getSetting("paused_inboxes") || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
  const byTransport = t === "smtp" || t === "gmail" ? all.filter((i) => i.transport === t) : all;
  return byTransport.filter((i) => !rested.has(i.email.toLowerCase()));
}

// Consumer: drains the verified-lead queue while the producer is still filling it.
async function sendFromQueue(runId, queue, isProducing, target) {
  const log = (m, level = "info") => logEvent({ run_id: runId, actor: "send", message: m, level });
  if (!iOwnSendLock()) {
    log("Another Tedca OS instance holds the send lock — standing down so we never double-send.", "warn");
    return 0;
  }
  const testMode = getSetting("test_mode") === "1";
  log(
    testMode
      ? `Practice mode is ON — every email comes to you (${process.env.TEST_RECIPIENT || "(unset!)"}), not the leads.`
      : "LIVE mode — these emails go to real business owners.",
    testMode ? "warn" : "info"
  );
  let sent = 0;
  while (sent < target) {
    // re-verify the send lock EVERY iteration (a run spans hours; checking once at
    // start let a process that lost ownership keep sending alongside the new owner)
    if (!iOwnSendLock()) {
      log("Lost the send lock mid-run (another instance took over) — standing down so we never double-send.", "warn");
      break;
    }
    // operator hit pause mid-run — stop sending immediately, don't drain the queue
    if (getSetting("paused") === "1") {
      log("Paused mid-run — stopping sends.", "warn");
      break;
    }
    // stop cleanly when business hours close — don't bleed sends into the evening
    if (!withinSendWindow()) {
      log("Business hours are over (Mon–Fri 8–17 ET) — banking the rest for tomorrow.", "warn");
      break;
    }
    if (!queue.length) {
      if (!isProducing()) break; // producer finished and queue is empty
      await sleep(1500); // wait for verification/scrape to supply more
      continue;
    }
    // hit the overall daily ceiling (initials + follow-ups together) — bank the rest
    if (sentTodayTotal() >= dailyCeiling()) {
      log("Hit today's overall send ceiling — banking the rest for tomorrow.", "warn");
      break;
    }
    // if every inbox is already at its inbox OR domain cap, stop — don't spin discarding the queue
    const pool = activeInboxes().map((i) => i.email);
    if (pool.length && pool.every((e) => !inboxEligible(e))) {
      log("Every inbox has hit today's safe cap (inbox or domain) — banking the rest for tomorrow.", "warn");
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

  const ready = activeInboxes().map((i) => i.email);
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
  for (const id of leadIds) {
    const lead = db.prepare("SELECT * FROM leads WHERE id=?").get(id);
    if (!lead?.email) continue;
    if (isSuppressed(lead.email)) {
      log(`Skipping ${lead.business_name} — that address opted out before.`, "info");
      continue;
    }
    // A SUPPLIED address may be free-mail (a real owner on Gmail); a FOUND one may not.
    if (blockedEmailDomain(lead.email, { allowFreeMail: Boolean(lead.supplied_email) })) {
      // platform/aggregator address slipped through — never email it; drop from pool
      db.prepare("UPDATE leads SET status='skipped', email_status='platform', followup_due_at=NULL WHERE id=?").run(id);
      log(`Skipping ${lead.business_name} — ${lead.email} is a platform address, not the owner.`, "warn");
      continue;
    }
    // never email the same PERSON twice — EVER (not just today). Multi-location
    // chains share one owner email, and re-scrapes/imports can create a second row
    // with the same address; this final guard catches anything earlier layers missed.
    if (emailContactedElsewhere(lead.email, id) || alreadyEmailedAddress(lead.email)) {
      db.prepare("UPDATE leads SET status='skipped', email_status='dup_recipient', followup_due_at=NULL WHERE id=?").run(id);
      log(`Skipping ${lead.business_name} — ${lead.email} was already contacted (same owner / another location). Never emailing the same person twice.`, "info");
      continue;
    }
    // last gate before the send: can this domain receive mail AT ALL, right now?
    const mx = await domainAcceptsMail(lead.email);
    if (!mx.ok) {
      db.prepare("UPDATE leads SET status='skipped', email_status='undeliverable', followup_due_at=NULL WHERE id=?").run(id);
      suppress(lead.email);
      log(`Skipping ${lead.business_name} — ${lead.email} cannot receive mail (${mx.reason}). Suppressed before sending, so it never becomes a bounce.`, "warn");
      continue;
    }
    // overall daily ceiling reached (initials + follow-ups) — stop the batch
    if (sentTodayTotal() >= dailyCeiling()) {
      log("Hit today's overall send ceiling — banking the rest for tomorrow.", "warn");
      break;
    }

    // Pick the eligible inbox with the FEWEST sends today, so volume spreads
    // evenly across all 12 instead of maxing one inbox before touching the next.
    // (Round-robin state can't persist here — sendBatch is called once per lead —
    // so we balance by live per-inbox counts; random tie-break avoids always
    // favoring the first inbox when several are equally loaded.)
    let inbox = null;
    let fewest = Infinity;
    for (const candidate of [...ready].sort(() => Math.random() - 0.5)) {
      if (!inboxEligible(candidate)) continue; // over its inbox cap OR its domain's daily cap
      // gently prefer a different domain than the last send so one domain isn't hit back-to-back
      const used = sentTodayByInbox(candidate) + (domainOf(candidate) === _lastSentDomain ? 0.5 : 0);
      if (used < fewest) {
        fewest = used;
        inbox = candidate;
      }
    }
    if (!inbox) {
      log("Every inbox hit its safe daily limit (inbox or domain) — pausing sends until tomorrow to protect them.", "warn");
      break;
    }

    const sender = senderNameFor(inbox);
    // per-batch copy override (a fed batch may be a different niche than settings.niche);
    // the compliance footer and the CAN-SPAM gate above wrap it exactly the same way
    const tpl = batchTemplates(lead.batch_id);
    const subject = (testMode ? `[TEST → ${lead.email}] ` : "") + fillTemplate(tpl.subject || subjectTpl, lead, sender);
    const body = withCompliance(fillTemplate(tpl.body || bodyTpl, lead, sender));
    const to = testMode ? testRecipient : lead.email;
    // ATOMIC CLAIM before the send (same belt the follow-up loop wears): only one
    // process can flip scraped→sending, and a crash after SMTP-accept defaults to
    // NOT re-sending (the claim is already burned; boot recovery surfaces it for a
    // human call instead of silently re-emailing the owner).
    if (!testMode) {
      const claimed = db.prepare("UPDATE leads SET status='sending' WHERE id=? AND status='scraped'").run(id).changes === 1;
      if (!claimed) {
        log(`Skipping ${lead.business_name} — another process already claimed it.`, "warn");
        continue;
      }
    }
    try {
      // NOT `sent` — that shadows the outer batch counter and makes `sent++` below
      // throw "Assignment to constant variable" on every send.
      const res = await pacedSendVia({ from: inbox, to, subject, body });
      // Keep the Message-ID: the follow-up threads onto it via In-Reply-To. Without
      // it the follow-up arrives as a brand-new email wearing a "Re:", which is a
      // loud automation tell. Column is gmail_id for historical reasons; it holds
      // the SMTP Message-ID for Zapmail inboxes.
      db.prepare(
        "INSERT INTO emails (lead_id, inbox, direction, subject, body, kind, sent_at, gmail_id) VALUES (?, ?, 'out', ?, ?, 'initial', datetime('now'), ?)"
      ).run(id, inbox, subject, body, res?.id || null);
      // TEST MODE never mutates real lead state: no status flip, no follow-up schedule.
      // (Before this, test sends permanently burned leads and later fired LIVE follow-ups.)
      if (!testMode) {
        db.prepare(
          "UPDATE leads SET status='emailed', inbox_used=?, last_touch_at=datetime('now'), followup_due_at=? WHERE id=?"
        ).run(inbox, followupDueAt(followupDays), id);
      }
      sent++;
      log(`Email sent to ${lead.business_name} (${lead.email}) using the ${inbox} inbox${testMode ? " — test copy went to you" : ""}.`, "success");
    } catch (e) {
      // release the claim — the send did not happen, so the lead goes back in the pool
      if (!testMode) db.prepare("UPDATE leads SET status='scraped' WHERE id=? AND status='sending'").run(id);
      log(`Could not send to ${lead.business_name}: ${e.message}`, "error");
    }
  }
  log(`Finished sending: ${sent} email${sent === 1 ? "" : "s"} out the door.`, sent ? "success" : "warn");
  return sent;
}

// ── scheduling anchored to Eastern time (NJ), regardless of server clock ─────
const TZ = "America/New_York";
function etNow(d = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour12: false, weekday: "short", hour: "2-digit", minute: "2-digit" })
      .formatToParts(d)
      .map((x) => [x.type, x.value])
  );
  const days = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { day: days[p.weekday], hour: Number(p.hour), minute: Number(p.minute) };
}
export const etDate = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d); // YYYY-MM-DD

// business hours: Mon–Fri 8:00–17:00 Eastern
export function withinSendWindow(d = new Date()) {
  const { day, hour } = etNow(d);
  return day >= 1 && day <= 5 && hour >= 8 && hour < 17;
}

// ── daily auto-run: weekday mornings, once per day ──────────────────────────
// ── Verify-ahead loop ────────────────────────────────────────────────────────
// Keeps `verify_ahead_days × daily_target` leads verified and ready so the 8 AM run
// never waits on AnyMailFinder, and so the runway number means something the day
// BEFORE it matters. Same gates as the scheduler (dormant cloud never spends, only
// the send owner verifies), plus: not while a run's producer is working the same
// rows, and never past today's credit budget.
let _verifyAheadBusy = false;
let _verifyPausedUntil = 0; // after a 402 (out of credits) sleep until the next ET day
export async function verifyAheadTick({ force = false, log = defaultVerifyLog } = {}) {
  if (process.env.SEND_DISABLED === "1") return { skipped: "send_disabled" };
  if (!iOwnSendLock()) return { skipped: "not_owner" };
  if (!force && getSetting("verify_ahead_enabled") !== "1") return { skipped: "disabled" };
  if (getSetting("paused") === "1") return { skipped: "paused" };
  if (runningRunId()) return { skipped: "run_in_progress" };
  if (_verifyAheadBusy) return { skipped: "busy" };
  if (Date.now() < _verifyPausedUntil) return { skipped: "no_credits_today" };
  if (!amfConfigured()) return { skipped: "no_key" };

  const budget = Number(getSetting("verify_daily_budget_credits") || 200);
  const want = Math.max(1, Number(getSetting("verify_ahead_days") || 2)) * Number(getSetting("daily_target") || 100);
  // Hard ceiling on calls per tick, independent of the credit budget. A repeat verify
  // and a not-found find are both billed ZERO, so the budget alone cannot bound a tick
  // — without this, one pass could churn a 5,000-row batch in a single unattended go.
  const maxCalls = Math.max(1, Number(getSetting("verify_max_per_tick") || 60));
  const GAP_MS = 400; // pace the provider; being rate-limited is what kills leads
  _verifyAheadBusy = true;
  const out = { verified: 0, ready: 0, dead: 0, errors: 0, credits0: verifyCreditsToday(), stopped: "" };
  try {
    let consecutiveErrors = 0;
    let calls = 0;
    while (true) {
      const { ready, pending } = queueCounts();
      if (ready >= want) { out.stopped = "enough_ready"; break; }
      if (!pending) { out.stopped = "nothing_pending"; break; }
      if (verifyCreditsToday() >= budget) { out.stopped = "budget"; break; }
      if (calls >= maxCalls) { out.stopped = "tick_cap"; break; }
      const ids = queuePick(20, { pendingOnly: true });
      if (!ids.length) { out.stopped = "nothing_pending"; break; }
      for (const id of ids) {
        if (verifyCreditsToday() >= budget) { out.stopped = "budget"; break; }
        if (calls >= maxCalls) { out.stopped = "tick_cap"; break; }
        // The morning run may have started since this tick began. Yield to it rather
        // than verifying the same rows twice and paying twice.
        if (runningRunId()) { out.stopped = "run_started"; break; }
        if (calls) await sleep(GAP_MS);
        calls++;
        const v = await verifyLead(id, log);
        if (v === "stop") {
          // provider says no credits: back off 6h (matches the credit-alert debounce)
          // so a top-up mid-day resumes without waiting for tomorrow. alertCreditOut already pinged.
          _verifyPausedUntil = Date.now() + 6 * 60 * 60 * 1000;
          out.stopped = "no_credits";
          break;
        }
        if (v === "error") {
          out.errors++;
          if (++consecutiveErrors >= 5) { out.stopped = "provider_unreachable"; break; }
          continue;
        }
        consecutiveErrors = 0;
        settleVerify(id, v);
        out.verified++;
        if (v) out.ready++; else out.dead++;
      }
      if (out.stopped) break;
    }
  } finally {
    _verifyAheadBusy = false;
  }
  const spent = Number((verifyCreditsToday() - out.credits0).toFixed(2));
  if (out.verified || out.errors) {
    const q = queueCounts();
    const why = { budget: `hit today's ${budget}-credit budget`, tick_cap: `hit the ${maxCalls}-lookup cap for one pass, continuing next tick`, run_started: "the morning run took over", no_credits: "provider is out of credits", provider_unreachable: "provider unreachable, will retry", enough_ready: "enough ready for now", nothing_pending: "queue fully verified" }[out.stopped] || "";
    log("verify", `Verified ahead: ${out.ready} ready, ${out.dead} dead, ${out.errors} retry later (${spent} credits). Queue now ${q.ready} ready / ${q.pending} pending${why ? ` — ${why}` : ""}.`, out.ready ? "success" : "info");
  }
  return { ...out, spent };
}
export function startVerifyAheadLoop() {
  const tick = () => verifyAheadTick().catch((e) => logEvent({ actor: "verify", message: `Verify-ahead loop hit a problem: ${e.message}`, level: "error" }));
  setTimeout(tick, 90 * 1000); // let the server settle first
  setInterval(tick, 5 * 60 * 1000);
}

export function startScheduler() {
  setInterval(() => {
    try {
      if (process.env.SEND_DISABLED === "1") return; // dormant cloud: never auto-run/scrape/send
      if (!iOwnSendLock()) return; // only the send owner runs the morning batch
      if (getSetting("schedule_enabled") !== "1") return;
      if (getSetting("paused") === "1") return;
      const now = new Date();
      const { hour, minute } = etNow(now);
      if (!withinSendWindow(now)) return;
      if (hour < Number(getSetting("schedule_hour") || 8)) return; // before the scheduled hour: wait
      // Randomized start MINUTE (stable per day), so the run never fires at exactly HH:00
      // sharp every morning — a robotic fingerprint. Derives an offset 0–44 from the date.
      const today = etDate(now);
      const startMin = [...today].reduce((a, c) => a + c.charCodeAt(0), 0) % 45;
      const schedHour = Number(getSetting("schedule_hour") || 8);
      // CATCH-UP: fire in the scheduled hour at the jittered minute as before, but if
      // that window was missed (stack down, DNS out — the Jul 2 and Jul 6 incidents),
      // fire at the first healthy tick later in the send window instead of losing the day.
      if (hour === schedHour && minute < startMin) return;
      if (getSetting("last_auto_run_date") === today) return;
      if (runningRunId()) return;
      // atomic day-claim: only one process/tick can flip the date to today; losers see
      // changes===0 and stand down (the old check-then-set raced across processes).
      const claimedDay =
        db.prepare(
          "INSERT INTO settings (key, value) VALUES ('last_auto_run_date', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE settings.value <> excluded.value"
        ).run(today).changes === 1;
      if (!claimedDay) return;
      // Day-to-day volume variance (±15%) so the daily total isn't an identical flat number.
      const base = Number(getSetting("daily_target") || 100);
      const target = Math.max(1, Math.round(base * (0.85 + Math.random() * 0.3)));
      logEvent({ actor: "system", message: `It's ${hour}:${String(minute).padStart(2, "0")} ET on a weekday — starting today's automatic run (target ${target}).`, level: "info" });
      startMorningRun({ target, query: null });
    } catch (e) {
      logEvent({ actor: "system", message: `Auto-run scheduler error: ${e.message}`, level: "error" });
    }
  }, 60_000);
}

// ── follow-up scheduler: runs every minute ───────────────────────────────────
let followupBusy = false; // re-entrancy guard: never run two follow-up batches at once
export function startFollowupLoop() {
  setInterval(async () => {
    if (process.env.SEND_DISABLED === "1") return; // dormant cloud: no follow-ups
    if (!iOwnSendLock()) return; // another instance owns sending — never double up
    if (followupBusy) return; // a prior batch is still sending — with 80–180s jitter a
    if (getSetting("paused") === "1") return; // batch can outlast the 60s interval, so
    if (!withinSendWindow()) return; // overlapping ticks would burst + double-send. skip.
    followupBusy = true;
    try {
    // Pull a wide window ordered oldest-first, then keep only leads whose inbox can
    // actually send under the current transport/pause config. A bare LIMIT 10 lets a
    // block of muted-inbox leads (e.g. tedcas.org rows while send_transport=smtp) sit at
    // the head of the scan and starve every sendable follow-up behind them.
    // Exclude muted inboxes IN SQL (not post-filter): a JS filter over a LIMIT 200 window
    // still starves once >200 muted rows sit at the head of the scan. Filtering in the query
    // means the 10-row window only ever contains sendable rows, no matter how many are muted.
    const allowed = activeInboxes().map((i) => i.email);
    if (!allowed.length) return; // no inbox can send right now → nothing to drain
    const allowedSet = new Set(allowed); // for the per-lead guard below (array feeds the SQL)
    const ph = allowed.map(() => "?").join(",");
    const due = db
      .prepare(`SELECT * FROM leads WHERE status='emailed' AND followup_due_at IS NOT NULL AND followup_due_at <= datetime('now') AND inbox_used IN (${ph}) ORDER BY followup_due_at ASC LIMIT 10`)
      .all(...allowed);
    if (!due.length) return;
    const testMode = getSetting("test_mode") === "1";
    const testRecipient = process.env.TEST_RECIPIENT || "";
    // same CAN-SPAM + test guards the initial-send path enforces
    if (!testMode && !getSetting("compliance_footer")) return;
    if (testMode && !testRecipient) return;
    const tpl = getSetting("followup_body");
    for (const lead of due) {
      if (sentTodayTotal() >= dailyCeiling()) break; // overall daily ceiling (initials + follow-ups)
      const inbox = lead.inbox_used;
      if (!allowedSet.has(inbox)) continue; // inbox muted under the current send_transport
      if (!inbox || !inboxEligible(inbox)) continue; // over its inbox OR domain cap
      if (isSuppressed(lead.email)) continue;
      // ATOMIC CLAIM: flip the row to followup_sent ONLY if it is still 'emailed'. If a
      // second loop/process (or an overlapping tick) already grabbed it, changes===0 and we
      // skip — so a follow-up can never go out twice even across two processes.
      const claimed =
        db
          .prepare(
            "UPDATE leads SET status='followup_sent', followup_due_at=NULL, last_touch_at=datetime('now') WHERE id=? AND status='emailed'"
          )
          .run(lead.id).changes === 1;
      if (!claimed) continue;
      const sender = senderNameFor(inbox);
      // Thread onto the ORIGINAL email rather than re-spinning the subject template.
      // Re-spinning sent "Re: <a subject the prospect never received>" on 69% of
      // follow-ups (774 of 1120) because email_subject is spintax. Reuse what was
      // actually sent, and pass its Message-ID so Gmail groups the two messages.
      const orig = db
        .prepare("SELECT subject, gmail_id FROM emails WHERE lead_id=? AND direction='out' AND kind='initial' ORDER BY id DESC LIMIT 1")
        .get(lead.id);
      const baseSubject = String(orig?.subject || fillTemplate(getSetting("email_subject"), lead, sender))
        .replace(/^\[TEST → [^\]]*\]\s*/, ""); // never inherit a test prefix into a live send
      const subject =
        (testMode ? `[TEST → ${lead.email}] ` : "") + (/^re:\s/i.test(baseSubject) ? baseSubject : `Re: ${baseSubject}`);
      const body = withCompliance(fillTemplate(tpl, lead, sender));
      try {
        const sent = await pacedSendVia({
          from: inbox,
          to: testMode ? testRecipient : lead.email,
          subject,
          body,
          // Only a real RFC Message-ID ("<...@host>") is a valid In-Reply-To. The
          // Gmail-API transport returns a hex message id instead, which would emit a
          // malformed header if send_transport ever flips off "smtp".
          inReplyTo: /^<.+@.+>$/.test(String(orig?.gmail_id || "")) ? orig.gmail_id : null,
        });
        db.prepare(
          "INSERT INTO emails (lead_id, inbox, direction, subject, body, kind, sent_at, gmail_id) VALUES (?, ?, 'out', ?, ?, 'followup', datetime('now'), ?)"
        ).run(lead.id, inbox, subject, body, sent?.id || null);
        logEvent({ actor: "send", message: `Gentle follow-up sent to ${lead.business_name}${testMode ? " (test copy to you)" : ""}.`, level: "success" });
      } catch (e) {
        // send failed AFTER we claimed — release the claim. Transient NETWORK failures
        // (the Jul 3 ENETUNREACH + Jul 6 ENOTFOUND/ETIMEOUT DNS blips) retry in ~15 min
        // SAME DAY; anything else (auth/rejection) waits a full day so a genuinely broken
        // inbox isn't hammered.
        const transient = /ENOTFOUND|ETIMEDOUT|ETIMEOUT|ENETUNREACH|ECONNRESET|ECONNREFUSED|EAI_AGAIN|getaddrinfo|queryA/i.test(String(e.message));
        const retryAt = transient
          ? new Date(Date.now() + 15 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ")
          : followupDueAt(1);
        db.prepare("UPDATE leads SET status='emailed', followup_due_at=? WHERE id=?").run(retryAt, lead.id);
        logEvent({ actor: "send", message: `Follow-up to ${lead.business_name} did not go through: ${e.message}${transient ? " (network blip — retrying in 15 min)" : ""}`, level: "error" });
      }
    }
    } finally {
      followupBusy = false;
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
