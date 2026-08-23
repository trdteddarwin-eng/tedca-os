// The morning cold-email run: bank → (one scrape) → verify → send → bank rest.
// Server-side steps run here; the scrape executes on the user's Mac via the jobs queue.
import { db } from "./db.js";
import { findCeo, amfConfigured } from "./anymailfinder.js";
import { sendTelegram } from "./telegram.js";
import { sendingInboxes, sendVia, isSmtp } from "./pool.js";
import { smtpInboxCap, smtpFirstName } from "./smtp.js";
import { isSuppressed } from "./replies.js";
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
function alreadyEmailedAddress(email) {
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
const EXHAUST_NEW_MIN = 10;
export function marketForToday() {
  let m = db.prepare("SELECT * FROM markets WHERE status='active' ORDER BY id LIMIT 1").get();
  if (!m) {
    m = db.prepare("SELECT * FROM markets WHERE status='fresh' ORDER BY id LIMIT 1").get();
    if (m) {
      db.prepare("UPDATE markets SET status='active' WHERE id=?").run(m.id);
      logEvent({ actor: "research", message: `New market opened: ${m.name}. All scraping hunts there until it dries up.`, level: "success" });
    }
  }
  return m || null;
}
function recordMarketRun(market, newCount, scraped) {
  if (!market || !scraped) return; // bank-only runs say nothing about the market
  db.prepare("UPDATE markets SET runs_used=runs_used+1, last_run_at=datetime('now'), last_new_count=? WHERE id=?").run(newCount, market.id);
  if (newCount < EXHAUST_NEW_MIN) {
    db.prepare("UPDATE markets SET status='exhausted' WHERE id=?").run(market.id);
    const next = db.prepare("SELECT name FROM markets WHERE status='fresh' ORDER BY id LIMIT 1").get();
    logEvent({ actor: "research", message: `${market.name} is tapped out (only ${newCount} new businesses this run) — retired, never re-scraped. ${next ? `Tomorrow hunts: ${next.name}.` : "NO FRESH MARKETS LEFT — add more."}`, level: "warn" });
  }
}

export async function startMorningRun({ target, query }) {
  if (activeRun) throw new Error(`run ${activeRun} already in progress`);
  const niche = getSetting("niche");
  const city = getSetting("city");
  const market = query ? null : marketForToday();
  // Guard: an auto-run with no city left must NOT silently re-scrape the drained
  // default city. The old `getSetting("search_query")` / `niche in city` fallback
  // re-hunted tapped-out Miami → ~0 new leads → a mystery-weak day (this starved
  // Jul 15). Stand down and ping so a human queues fresh cities. Manual runs
  // (explicit query) are unaffected.
  if (!query && !market) {
    const msg = "Out of fresh cities — the market queue is empty. Skipping today's auto-run instead of re-scraping a drained city. Add cities to resume lead flow.";
    logEvent({ actor: "research", message: msg, level: "error" });
    sendTelegram(`🚨 Tedca OS: ${msg}`).catch(() => {});
    return null;
  }
  const searchQuery = query || market?.query || `${niche} in ${city}`;
  const info = db
    .prepare("INSERT INTO runs (agent, status, summary) VALUES ('cold-email', 'running', ?)")
    .run(`target ${target} · ${market ? `${market.name} · ` : ""}${searchQuery}`);
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

async function executeRun(runId, { target, searchQuery, market = null }) {
  const log = (actor, message, level = "info") => logEvent({ run_id: runId, actor, message, level });
  let newDiscovered = 0; // never-contacted businesses found by this run's scrapes (market exhaustion signal)
  let scrapeCompleted = false; // ONLY a scrape that actually returned results is exhaustion evidence — a fetch that died (Jul 7 DNS blip) says nothing about the market

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
    // off-niche → skip BEFORE AnyMailFinder so we never spend a credit on a non-med-spa
    if (isOffNiche(lead.category)) {
      db.prepare("UPDATE leads SET status='skipped', email_status='off_niche' WHERE id=?").run(id);
      log("verify", `${lead.business_name}: ${lead.category || "off-niche"} — not a med spa, skipped before AnyMailFinder (no credit spent).`, "info");
      return false;
    }
    // outside New Jersey → skip BEFORE AnyMailFinder so we never spend a credit out-of-area
    if (isOffGeo(lead.state)) {
      db.prepare("UPDATE leads SET status='skipped', email_status='off_geo' WHERE id=?").run(id);
      log("verify", `${lead.business_name}: ${lead.state} — outside New Jersey, skipped before AnyMailFinder (no credit spent).`, "info");
      return false;
    }
    if (!amfConfigured()) return Boolean(lead.email); // no key: use scraped email as-is
    if (!lead.domain && !lead.business_name) return false;
    try {
      const r = await findCeo({ domain: lead.domain, companyName: lead.business_name });
      if (r.status === "no_credits") {
        log("verify", "My email-finding credits ran out — I cannot confirm any more owner emails today.", "error");
        return "stop";
      }
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
        // cap per-search so the synchronous Apify scrape always finishes inside its
        // 5-minute limit (720-in-one-shot was timing out → 0 leads → 0 sends).
        const perSearch = Math.min(Math.max(Math.ceil((deficit * 3) / nSearches), 10), 20);
        log("scrape", `Not enough leads yet (${supplied} of ${target} ready). Going to Google Maps for more businesses — emails keep going out in the meantime. (scrape ${scrapesUsed} of ${MAX_SCRAPES_PER_RUN} allowed today)`, "warn");
        const scraped = await runScrapeJob(runId, { search: searchQuery, limit: perSearch });
        const inserted = ingestLeads(scraped, searchQuery);
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
  // market bookkeeping: retire the metro only when a COMPLETED scrape stops yielding
  // new businesses (a failed fetch is not evidence — it wrongly retired Scottsdale once)
  recordMarketRun(market, newDiscovered, scrapeCompleted);
  log("system", `Morning run finished. ${sent} email${sent === 1 ? "" : "s"} sent, ${leftovers} lead${leftovers === 1 ? "" : "s"} saved for tomorrow.`, "success");
  await sendTelegram(
    `☀️ Morning run done\n· ${sent} emails sent\n· ${leftovers} leads banked for tomorrow\n· search: ${searchQuery}\nDashboard → ${process.env.PUBLIC_URL || "https://tedca-os-production.up.railway.app"}`
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
function isOffNiche(category) {
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
const TARGET_STATE = /new jersey|new york|pennsylvania|connecticut|florida|texas|california|arizona|georgia|north carolina|tennessee|colorado|nevada|utah|^\s*(nj|ny|pa|ct|fl|tx|ca|az|ga|nc|tn|co|nv|ut)\.?\s*$/i;
const COUNTRY_ONLY = /^(us|u\.?\s?s\.?\s?a?\.?|united states)$/i;
function isOffGeo(state) {
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
    let domain = null;
    if (website) {
      try {
        domain = new URL(website.startsWith("http") ? website : `https://${website}`).hostname.replace(/^www\./, "");
      } catch {
        /* unparsable site */
      }
    }
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
      it.email ? "unknown" : null,
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
    n = n.split(/:\s*/)[0]; // "House of Ness: Ness Medical" → "House of Ness"
    n = n.split(/,\s*/)[0]; // comma location list
    n = n.split(/\s+at\s+[A-Z]/)[0]; // " at Clifton" location tag
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
    return n.trim();
  };

  // social proof: only cite numbers when we actually have them, otherwise use a
  // clean non-numeric line — never "great stars across many reviews".
  const hasStats = lead.rating != null && lead.review_count != null;
  const socialProof = hasStats
    ? pick([
        `${lead.rating} stars across ${lead.review_count} reviews is no joke`,
        `${lead.rating} stars across ${lead.review_count} reviews tells me your clients love you`,
        `those ${lead.rating} stars across ${lead.review_count} reviews say a lot`,
      ])
    : pick([
        "your reviews say a lot about how you treat people",
        "your reputation online clearly speaks for itself",
        "people clearly love what you do",
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

// Platforms / aggregators / free mailboxes. When a scraped "website" is really a
// Google Maps link, a Linktree, or a booking tool, AnyMailFinder resolves it to
// that PLATFORM's owner (e.g. sundar@google.com) and marks it "valid". Those are
// never the business owner — block them so we never email Sundar Pichai.
const BLOCKED_EMAIL_DOMAINS = new Set([
  "google.com", "googlemail.com", "linktr.ee", "glossgenius.com", "booksy.com",
  "vagaro.com", "fresha.com", "squareup.com", "square.site", "zoca.com",
  "instagram.com", "facebook.com", "fb.com", "yelp.com", "wixsite.com",
  "wix.com", "godaddy.com", "weebly.com", "wordpress.com", "blogspot.com",
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com",
  "union.edu",
]);
function blockedEmailDomain(email) {
  const dom = String(email || "").split("@")[1]?.toLowerCase().trim();
  return Boolean(dom) && BLOCKED_EMAIL_DOMAINS.has(dom);
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
function isSharedDomain(domain) {
  const d = String(domain || "").toLowerCase().trim();
  if (!d) return false;
  if (BLOCKED_EMAIL_DOMAINS.has(d) || SHARED_SITE_DOMAINS.has(d)) return true;
  for (const s of BLOCKED_EMAIL_DOMAINS) if (d.endsWith("." + s)) return true; // maps.google.com
  for (const s of SHARED_SITE_DOMAINS) if (d.endsWith("." + s)) return true;   // myspa.wixsite.com
  return false;
}
const normName = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
const realDomain = (domain) => (domain && !isSharedDomain(domain) ? String(domain).toLowerCase() : null);

// Has this email already been engaged through a DIFFERENT lead row? Covers
// multi-location chains (one owner email, many branches), re-scrapes, alias rows,
// and manual imports — anything we've emailed, that replied, bounced, or opted out.
// This is the bulletproof guarantee: even a duplicate that slips past ingest dedup
// can never be emailed a second time.
function emailContactedElsewhere(email, exceptId) {
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
    if (blockedEmailDomain(lead.email)) {
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
    const subject = (testMode ? `[TEST → ${lead.email}] ` : "") + fillTemplate(subjectTpl, lead, sender);
    const body = withCompliance(fillTemplate(bodyTpl, lead, sender));
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
      await pacedSendVia({ from: inbox, to, subject, body });
      db.prepare(
        "INSERT INTO emails (lead_id, inbox, direction, subject, body, kind, sent_at) VALUES (?, ?, 'out', ?, ?, 'initial', datetime('now'))"
      ).run(id, inbox, subject, body);
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
      const subject = (testMode ? `[TEST → ${lead.email}] ` : "") + `Re: ` + fillTemplate(getSetting("email_subject"), lead, sender);
      const body = withCompliance(fillTemplate(tpl, lead, sender));
      try {
        await pacedSendVia({ from: inbox, to: testMode ? testRecipient : lead.email, subject, body });
        db.prepare(
          "INSERT INTO emails (lead_id, inbox, direction, subject, body, kind, sent_at) VALUES (?, ?, 'out', ?, ?, 'followup', datetime('now'))"
        ).run(lead.id, inbox, subject, body);
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
