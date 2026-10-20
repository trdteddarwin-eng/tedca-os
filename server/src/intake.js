// LEAD INTAKE — "feed it leads, it does the rest" (2026-09-09).
//
// Ted drops a lead file in (CSV / TSV / paste / Google Sheet). This module turns it
// into queued leads inside a named batch:
//   parse → map columns → dedupe against everything we ever touched → insert as
//   status='scraped', email_status=NULL (exactly what the morning run's producer
//   pulls) → price the batch in AnyMailFinder credits → Telegram summary.
//
// NOTHING here sends or verifies. Verification is the engine's job (verifyLead /
// the verify-ahead loop); sending is the morning run's. Intake only supplies.
import { db } from "./db.js";
import { randomUUID } from "node:crypto";
import { parseCsv, parsePaste, isEmailLike, isUrlLike, decodeText } from "./csv.js";
import {
  getSetting, realDomain, normName, domainFromWebsite,
  blockedEmailDomain, isOffNiche, queueRunway, runwayLine, maybeRunwayAlert, observedValidRate, verifyCreditsToday,
} from "./engine.js";
import { sendTelegram } from "./telegram.js";
import { sheetsApi, manychatConfigured, serviceAccountEmail } from "./igkeywords.js";

let logEvent = () => {};
export function bindIntakeLogger(fn) { logEvent = fn; }
const log = (message, level = "info") => logEvent({ actor: "intake", message, level });

// ── column mapping ───────────────────────────────────────────────────────────
export const FIELDS = ["business_name", "website", "email", "ceo_name", "first_name", "last_name", "phone", "city", "state", "category", "rating", "review_count", "notes"];
const SYNONYMS = {
  business_name: ["business", "businessname", "business_name", "company", "companyname", "company_name", "name", "title", "practice", "practicename", "clinic", "organization", "org", "account"],
  website: ["website", "web", "site", "url", "domain", "websiteurl", "website_url", "homepage", "link"],
  email: ["email", "e-mail", "emailaddress", "email_address", "mail", "owneremail", "contactemail", "work_email", "workemail"],
  ceo_name: ["owner", "ownername", "owner_name", "contact", "contactname", "contact_name", "ceo", "ceoname", "fullname", "full_name", "person", "decisionmaker", "decision_maker", "dr", "doctor", "dentist"],
  first_name: ["first", "firstname", "first_name", "fname", "givenname"],
  last_name: ["last", "lastname", "last_name", "lname", "surname", "familyname"],
  phone: ["phone", "phonenumber", "phone_number", "tel", "telephone", "mobile", "cell"],
  city: ["city", "town", "locality"],
  state: ["state", "region", "province", "st"],
  category: ["category", "categoryname", "industry", "niche", "type", "vertical", "specialty"],
  rating: ["rating", "stars", "score", "totalscore", "googlerating"],
  review_count: ["reviews", "reviewcount", "review_count", "reviewscount", "numreviews", "ratingcount"],
  notes: ["notes", "note", "comment", "comments", "remarks"],
};
const normHeader = (h) => String(h || "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
export function mapHeaders(headers) {
  const mapping = {};
  const taken = new Set();
  for (const h of headers) {
    const n = normHeader(h);
    let hit = null;
    for (const [field, syns] of Object.entries(SYNONYMS)) {
      if (taken.has(field)) continue;
      if (syns.includes(n) || syns.includes(n.replace(/[_-]/g, ""))) { hit = field; break; }
    }
    // fuzzy: header CONTAINS a synonym word ("Business Email" → email, "Website URL" → website)
    if (!hit) {
      for (const [field, syns] of Object.entries(SYNONYMS)) {
        if (taken.has(field)) continue;
        if (syns.some((s) => s.length >= 4 && n.includes(s))) { hit = field; break; }
      }
    }
    mapping[h] = hit;
    if (hit) taken.add(hit);
  }
  return mapping;
}

// Apply a mapping to raw rows → lead-shaped objects (+ raw for audit).
function rowsToLeads(headers, rows, mapping) {
  const out = [];
  for (const r of rows) {
    const lead = { raw: {} };
    headers.forEach((h, i) => {
      const v = r[i] == null ? "" : String(r[i]).trim();
      lead.raw[h] = v;
      const f = mapping[h];
      if (f && v && !lead[f]) lead[f] = v;
    });
    if (!lead.ceo_name && (lead.first_name || lead.last_name)) lead.ceo_name = [lead.first_name, lead.last_name].filter(Boolean).join(" ");
    // a "website" cell that is actually an email, or vice versa — be forgiving
    if (lead.website && !lead.email && isEmailLike(lead.website)) { lead.email = lead.website; lead.website = ""; }
    if (lead.email && !isEmailLike(lead.email)) { lead.notes = [lead.notes, `bad email cell: ${lead.email}`].filter(Boolean).join(" · "); lead.email = ""; }
    if (lead.email) lead.email = lead.email.toLowerCase();
    if (!lead.website && lead.email && !blockedEmailDomain(lead.email, { allowFreeMail: false })) {
      // a business email implies the business domain — lets the dedupe key work
      lead.website = lead.email.split("@")[1];
    }
    lead.domain = domainFromWebsite(lead.website);
    if (!lead.business_name && lead.domain) lead.business_name = lead.domain.split(".")[0].replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    if (!lead.business_name && lead.ceo_name) lead.business_name = lead.ceo_name;
    out.push(lead);
  }
  return out;
}

// ── sources ──────────────────────────────────────────────────────────────────
export function parseUpload(buffer, filename = "") {
  const rows = parseCsv(buffer);
  if (!rows.length) throw new Error("The file has no rows.");
  const headers = rows[0];
  // a headerless one-column list (all emails / all URLs) — synthesize a header
  if (headers.length === 1 && (isEmailLike(headers[0]) || isUrlLike(headers[0]))) {
    return parsePaste(decodeText(buffer));
  }
  return { headers, rows: rows.slice(1), source: "csv", filename };
}

export function parseText(text) {
  const p = parsePaste(text);
  if (!p.rows.length) throw new Error("Nothing to import — paste rows or one email / website per line.");
  return { ...p, source: "paste" };
}

// Google Sheet: needs the sheet shared (Viewer is enough) with the service account.
export async function readSheet(url) {
  const m = String(url || "").match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!m) throw new Error("That does not look like a Google Sheets link.");
  const id = m[1];
  const gid = (String(url).match(/[#&?]gid=(\d+)/) || [])[1];
  if (!manychatConfigured()) throw new Error("Google service account is not configured on this server, so private Sheets cannot be read. Export the sheet as CSV and drop it here instead.");
  let title = null;
  try {
    const meta = await sheetsApi(id, "?fields=sheets.properties");
    const sheets = (meta.sheets || []).map((s) => s.properties);
    const pick = gid ? sheets.find((s) => String(s.sheetId) === String(gid)) : sheets[0];
    title = pick?.title || null;
  } catch (e) {
    const sa = serviceAccountEmail();
    if (/403|404/.test(String(e.message))) throw new Error(`Google would not open that sheet. Share it (Viewer) with ${sa || "the service account"} and try again.`);
    throw e;
  }
  const range = encodeURIComponent(`'${title || "Sheet1"}'!A1:ZZ100000`);
  const data = await sheetsApi(id, `/values/${range}`);
  const values = data.values || [];
  if (values.length < 2) throw new Error("That sheet tab is empty (needs a header row plus at least one lead).");
  const headers = values[0].map((h) => String(h || "").trim());
  const width = headers.length;
  const rows = values.slice(1).map((r) => Array.from({ length: width }, (_, i) => (r[i] == null ? "" : String(r[i]).trim()))).filter((r) => r.some(Boolean));
  return { headers, rows, source: "sheet", filename: title ? `${title} (Google Sheet)` : "Google Sheet" };
}

// ── dedupe + pricing (pure read) ─────────────────────────────────────────────
const GENERIC_LOCAL = /^(info|office|contact|hello|hi|admin|frontdesk|front|reception|team|support|sales|billing|mail|enquiries|inquiries|appointments|booking|bookings)$/i;

// Build every dedupe index in FOUR table scans, not three queries per row.
// Per-row `alreadyEmailedAddress` / `emailContactedElsewhere` / `isSuppressed` each
// cost ~1.3 ms on the live DB (no usable index — they compare lower(email)), so a
// 10k-row file would block the event loop for ~25 s, twice, stalling the send loop
// and the 90 s owner-lock heartbeat along with it.
const CONTACTED_STATUSES = ["emailed", "followup_sent", "replied", "bounced", "do_not_contact", "opted_out"];
function existingKeys() {
  const domains = new Set(), names = new Set(), emails = new Set(), contacted = new Set(), suppressed = new Set();
  for (const r of db.prepare("SELECT business_name, domain, city, email, status FROM leads").all()) {
    const rd = realDomain(r.domain);
    if (rd) domains.add(rd);
    names.add(normName(r.business_name) + "|" + normName(r.city));
    names.add(normName(r.business_name) + "|");
    if (r.email) {
      const e = String(r.email).toLowerCase();
      emails.add(e);
      if (CONTACTED_STATUSES.includes(r.status)) contacted.add(e);
    }
  }
  for (const r of db.prepare("SELECT email FROM suppressions").all()) suppressed.add(String(r.email).toLowerCase());
  // any address that has ever received an initial, even under a since-reset lead row
  for (const r of db.prepare("SELECT DISTINCT lower(l.email) e FROM emails em JOIN leads l ON l.id=em.lead_id WHERE em.direction='out' AND em.kind='initial' AND l.email IS NOT NULL").all()) {
    if (r.e) contacted.add(r.e);
  }
  return { domains, names, emails, contacted, suppressed };
}

export function analyze(parsed, mappingOverride = null) {
  const headers = parsed.headers;
  const mapping = mappingOverride || mapHeaders(headers);
  const leads = rowsToLeads(headers, parsed.rows, mapping);
  const keys = existingKeys();
  const seenDomains = new Set(), seenNames = new Set(), seenEmails = new Set();
  const verdicts = []; // per row: {ok, reason}
  const dupes = { email: 0, domain: 0, name_city: 0, suppressed: 0, contacted: 0, in_file: 0 };
  let rejected = 0, supplied = 0, generic = 0, needLookup = 0, ok = 0;
  const nicheWarn = [];
  for (const l of leads) {
    let reason = null;
    const email = l.email || null;
    const rd = realDomain(l.domain);
    const nameKey = normName(l.business_name) + "|" + normName(l.city);
    const nameOnly = normName(l.business_name) + "|";
    if (!l.business_name && !l.domain && !email) reason = "empty row (no business, website, or email)";
    else if (email && blockedEmailDomain(email, { allowFreeMail: true })) reason = "platform address (not an owner)";
    else if (email && keys.suppressed.has(email)) { reason = "opted out / bounced before"; dupes.suppressed++; }
    else if (email && keys.contacted.has(email)) { reason = "already contacted"; dupes.contacted++; }
    else if (email && keys.emails.has(email)) { reason = "email already in the CRM"; dupes.email++; }
    else if (rd && keys.domains.has(rd)) { reason = "business already in the CRM (same website)"; dupes.domain++; }
    else if (!rd && l.business_name && (keys.names.has(nameKey) || (!l.city && keys.names.has(nameOnly)))) { reason = "business already in the CRM (same name)"; dupes.name_city++; }
    else if (email && seenEmails.has(email)) { reason = "duplicate inside this file"; dupes.in_file++; }
    else if (rd && seenDomains.has(rd)) { reason = "duplicate inside this file"; dupes.in_file++; }
    else if (!rd && !email && seenNames.has(nameKey)) { reason = "duplicate inside this file"; dupes.in_file++; }
    if (reason) {
      if (/^empty|^platform/.test(reason)) rejected++;
      verdicts.push({ ok: false, reason });
      continue;
    }
    if (email) { seenEmails.add(email); supplied++; if (GENERIC_LOCAL.test(email.split("@")[0])) generic++; }
    else needLookup++;
    if (rd) seenDomains.add(rd);
    seenNames.add(nameKey);
    if (l.category && isOffNiche(l.category)) nicheWarn.push(l.business_name);
    verdicts.push({ ok: true });
    ok++;
  }
  const validRate = observedValidRate();
  // AnyMailFinder: ~0.2 credits per supplied-address verify, 2 credits per FOUND owner (0 on not-found)
  const estCredits = Number((supplied * 0.2 + needLookup * 2 * validRate).toFixed(1));
  return {
    headers, mapping, fields: FIELDS, leads, verdicts,
    total: leads.length, new: ok, rejected, dupes, supplied, generic, need_lookup: needLookup,
    valid_rate: Number(validRate.toFixed(2)), est_credits: estCredits,
    expected_sendable: Math.round(supplied * 0.85 + needLookup * validRate),
    sample: leads.slice(0, 8).map((l, i) => ({ business_name: l.business_name || "", website: l.website || "", email: l.email || "", ceo_name: l.ceo_name || "", city: l.city || "", state: l.state || "", verdict: verdicts[i] })),
    niche_warnings: nicheWarn.slice(0, 10),
  };
}

// ── preview store (so commit doesn't re-upload) ──────────────────────────────
const previews = new Map(); // token → { parsed, ts }
const PREVIEW_TTL_MS = 30 * 60 * 1000;
function gcPreviews() { const now = Date.now(); for (const [k, v] of previews) if (now - v.ts > PREVIEW_TTL_MS) previews.delete(k); }

export function preview(parsed, mappingOverride = null) {
  gcPreviews();
  const token = randomUUID();
  previews.set(token, { parsed, ts: Date.now() });
  const a = analyze(parsed, mappingOverride);
  const { leads, verdicts, ...pub } = a; // never ship the full parsed file back to the browser
  return { token, source: parsed.source, filename: parsed.filename || null, ...pub, credits_today: verifyCreditsToday(), credits_budget: Number(getSetting("verify_daily_budget_credits") || 200) };
}
export function remap(token, mapping) {
  gcPreviews();
  const p = previews.get(token);
  if (!p) throw new Error("That preview expired — upload the file again.");
  const a = analyze(p.parsed, mapping);
  const { leads, verdicts, ...pub } = a;
  return { token, source: p.parsed.source, filename: p.parsed.filename || null, ...pub, credits_today: verifyCreditsToday(), credits_budget: Number(getSetting("verify_daily_budget_credits") || 200) };
}

// ── commit ───────────────────────────────────────────────────────────────────
export async function commit(token, { name, niche, priority, template_subject, template_body, notes, mapping } = {}) {
  gcPreviews();
  const p = previews.get(token);
  if (!p) throw new Error("That preview expired — upload the file again.");
  const a = analyze(p.parsed, mapping || null);
  if (!a.new) throw new Error("Nothing new to import — every row was a duplicate or unusable.");
  const batchName = String(name || p.parsed.filename || `Feed ${new Date().toISOString().slice(0, 10)}`).slice(0, 120);
  const batchNiche = String(niche || getSetting("niche") || "").slice(0, 60);
  const prio = Number.isFinite(Number(priority)) ? Math.max(0, Math.min(999, Number(priority))) : 10;

  const insertBatch = db.prepare(
    "INSERT INTO lead_batches (name, source, niche, status, priority, template_subject, template_body, row_count, notes, skipped_json) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)"
  );
  const insertLead = db.prepare(`
    INSERT INTO leads (business_name, domain, category, rating, review_count, website, ceo_name, email, email_status, phone, city, state, notes,
                       source, scraped_at, status, banked, batch_id, supplied_email, raw_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, datetime('now'), 'scraped', 0, ?, ?, ?, datetime('now'))
  `);
  let batchId = null, inserted = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    const skipped = { rejected: a.rejected, ...a.dupes };
    const info = insertBatch.run(batchName, p.parsed.source || "csv", batchNiche, prio, template_subject || null, template_body || null, a.total, notes || null, JSON.stringify(skipped));
    batchId = Number(info.lastInsertRowid);
    a.leads.forEach((l, i) => {
      if (!a.verdicts[i]?.ok) return;
      const rating = l.rating != null && l.rating !== "" && Number.isFinite(Number(l.rating)) ? Number(l.rating) : null;
      const reviews = l.review_count != null && l.review_count !== "" && Number.isFinite(Number(l.review_count)) ? Math.round(Number(l.review_count)) : null;
      insertLead.run(
        l.business_name || l.domain || l.email, l.domain || null, l.category || null, rating, reviews, l.website || null, l.ceo_name || null,
        l.email || null, l.phone || null, l.city || null, l.state || null, l.notes || null,
        `import:${batchId}`, batchId, l.email ? 1 : 0, JSON.stringify(l.raw).slice(0, 4000)
      );
      inserted++;
    });
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw e;
  }
  previews.delete(token);

  const runway = queueRunway();
  const dupeTotal = Object.values(a.dupes).reduce((x, y) => x + y, 0);
  log(`Fed "${batchName}": ${inserted} new lead${inserted === 1 ? "" : "s"} queued (${a.supplied} came with emails, ${a.need_lookup} need an owner lookup; ${dupeTotal} duplicates and ${a.rejected} unusable rows skipped). ${runwayLine(runway)}.`, "success");
  await sendTelegram(
    `🥣 Leads fed: "${batchName}"\n· ${inserted} new queued (${a.supplied} with emails, ${a.need_lookup} need lookup)\n· ${dupeTotal} dupes + ${a.rejected} unusable skipped\n· est. ~${a.est_credits} AnyMailFinder credits\n· ${runwayLine(runway)}`
  ).catch(() => {});
  await maybeRunwayAlert("after feeding").catch(() => {});
  const batch = getBatch(batchId);
  return { batch, inserted, skipped: { rejected: a.rejected, ...a.dupes }, runway };
}

// ── batches ──────────────────────────────────────────────────────────────────
const COUNT_SQL = `
  SELECT batch_id,
    SUM(status='scraped' AND email_status IS NULL) pending,
    SUM(status='scraped' AND email_status='valid' AND email IS NOT NULL) ready,
    SUM(status IN ('emailed','followup_sent','sending')) sent,
    SUM(status='replied') replied,
    SUM(status='bounced') bounced,
    SUM(status IN ('skipped','do_not_contact','opted_out') OR (status='scraped' AND email_status IS NOT NULL AND email_status<>'valid')) dead,
    COUNT(*) inserted
  FROM leads WHERE batch_id IS NOT NULL GROUP BY batch_id`;
function decorate(b, counts) {
  const c = counts || { pending: 0, ready: 0, sent: 0, replied: 0, bounced: 0, dead: 0, inserted: 0 };
  let skipped = {};
  try { skipped = JSON.parse(b.skipped_json || "{}"); } catch { skipped = {}; }
  const { skipped_json, ...rest } = b;
  return { ...rest, skipped, counts: { fed: b.row_count, inserted: c.inserted, pending: c.pending, ready: c.ready, sent: c.sent, replied: c.replied, bounced: c.bounced, dead: c.dead } };
}
export function listBatches() {
  const counts = new Map(db.prepare(COUNT_SQL).all().map((r) => [r.batch_id, r]));
  const rows = db.prepare("SELECT * FROM lead_batches ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, priority, id DESC").all();
  return rows.map((b) => decorate(b, counts.get(b.id)));
}
export function getBatch(id) {
  const b = db.prepare("SELECT * FROM lead_batches WHERE id=?").get(id);
  if (!b) return null;
  const c = db.prepare(COUNT_SQL.replace("GROUP BY batch_id", "AND batch_id=? GROUP BY batch_id")).get(id);
  return decorate(b, c);
}
export function updateBatch(id, patch = {}) {
  const b = db.prepare("SELECT * FROM lead_batches WHERE id=?").get(id);
  if (!b) throw new Error("batch not found");
  const sets = [], vals = [];
  if (patch.status != null) {
    if (!["active", "paused", "archived"].includes(patch.status)) throw new Error("status must be active | paused | archived");
    sets.push("status=?"); vals.push(patch.status);
  }
  if (patch.priority != null) { sets.push("priority=?"); vals.push(Math.max(0, Math.min(999, Number(patch.priority) || 0))); }
  if (patch.name != null) { sets.push("name=?"); vals.push(String(patch.name).slice(0, 120)); }
  if (patch.niche != null) { sets.push("niche=?"); vals.push(String(patch.niche).slice(0, 60)); }
  if (patch.notes != null) { sets.push("notes=?"); vals.push(String(patch.notes).slice(0, 2000)); }
  if ("template_subject" in patch) { sets.push("template_subject=?"); vals.push(patch.template_subject ? String(patch.template_subject) : null); }
  if ("template_body" in patch) { sets.push("template_body=?"); vals.push(patch.template_body ? String(patch.template_body) : null); }
  if (!sets.length) return getBatch(id);
  vals.push(id);
  db.prepare(`UPDATE lead_batches SET ${sets.join(", ")} WHERE id=?`).run(...vals);
  if (patch.status && patch.status !== b.status) log(`Batch "${b.name}" ${patch.status === "active" ? "resumed" : patch.status}.`, "info");
  return getBatch(id);
}
