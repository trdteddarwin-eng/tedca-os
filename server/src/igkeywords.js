// ManyChat (ig-comment-dm) control panel: read/write the bot's Google Sheet from the OS.
// The Modal-hosted bots (ig-comment-dm / fb-keyword-dm) read the "Keywords" tab with a
// 30s cache, so any change written here is live on Instagram/Facebook within ~30 seconds.
// Auth = the same Google service account the bots use; key staged at data/manychat_sa.json
// (chmod 600, gitignored — copied from the original in ~/Downloads).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { db } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SA_PATH =
  process.env.MANYCHAT_SA_PATH ||
  path.join(process.env.DATA_DIR || path.join(__dirname, "..", "data"), "manychat_sa.json");
const SHEET_ID = process.env.KEYWORD_SHEET_ID || "18KAK9e8o9HEMjuhcRVH8elpOZeTuqe02vnz_6pcWRx8";
// canonical column order, mirrors ig-comment-dm/add_keyword.py + the 2026-07-06 follow-gate
// columns (HANDOFF_TEDCA_OS.md §2): follow_gate yes/blank, optional gate_intro/gate_nudge copy.
const CANON = ["keyword", "link", "message", "triggers", "active", "post_url", "match_type", "follow_gate", "gate_intro", "gate_nudge"];

// The service-account JSON can arrive two ways:
//  - a file on disk (Mac dev: data/manychat_sa.json, gitignored, chmod 600), or
//  - an env var (Railway/cloud, where that gitignored file never lands → the old 503).
// Accept raw JSON or base64 (base64 survives env-var newline mangling of the private key).
function loadServiceAccount() {
  const raw = (process.env.MANYCHAT_SA_JSON || "").trim();
  if (raw) return JSON.parse(raw);
  const b64 = (process.env.MANYCHAT_SA_B64 || "").trim();
  if (b64) return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  return JSON.parse(fs.readFileSync(SA_PATH, "utf8"));
}

export function manychatConfigured() {
  return Boolean(
    (process.env.MANYCHAT_SA_JSON || "").trim() ||
      (process.env.MANYCHAT_SA_B64 || "").trim() ||
      fs.existsSync(SA_PATH)
  );
}

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let _tok = { v: null, exp: 0 };
async function accessToken() {
  if (_tok.v && Date.now() < _tok.exp - 60_000) return _tok.v;
  const sa = loadServiceAccount();
  const now = Math.floor(Date.now() / 1000);
  const hdr = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })
  );
  const sig = crypto.createSign("RSA-SHA256").update(`${hdr}.${claim}`).sign(sa.private_key);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${hdr}.${claim}.${b64url(sig)}` }),
  });
  const j = await res.json();
  if (!j.access_token) throw new Error(`google auth failed: ${JSON.stringify(j).slice(0, 160)}`);
  _tok = { v: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return _tok.v;
}

// generic Sheets API call against ANY spreadsheet (also used by crmbackup.js)
export async function sheetsApi(spreadsheetId, pathname, opts = {}) {
  const token = await accessToken();
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}${pathname}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`sheets ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}

const gs = (pathname, opts = {}) => sheetsApi(SHEET_ID, pathname, opts);

const colLetter = (n) => {
  let s = "";
  while (n) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
};

async function readTab(tab, range = "A1:Z1000") {
  const j = await gs(`/values/${encodeURIComponent(`'${tab}'!${range}`)}`);
  return j.values || [];
}

// Keywords tab -> [{...fields, row_n}] using the ACTUAL header row for column mapping.
// HEADER GUARD (HANDOFF §2 "also fixed today"): a corrupted A1 once silently disabled ALL
// keywords. If the header row no longer contains "keyword", restore the canonical header.
export async function listKeywords() {
  let values = await readTab("Keywords");
  if (!values.length) return { header: CANON, rows: [] };
  let rawHeader = values[0].map((h) => String(h || "").trim().toLowerCase());
  if (!rawHeader.includes("keyword")) {
    const fixed = [...CANON];
    await gs(`/values/${encodeURIComponent(`'Keywords'!A1:${colLetter(fixed.length)}1`)}?valueInputOption=RAW`, {
      method: "PUT",
      body: JSON.stringify({ values: [fixed] }),
    });
    values = await readTab("Keywords");
    rawHeader = values[0].map((h) => String(h || "").trim().toLowerCase());
  }
  const header = rawHeader;
  const rows = values.slice(1).map((r, i) => {
    const o = { row_n: i + 2 };
    header.forEach((h, c) => { if (h) o[h] = r[c] !== undefined ? String(r[c]) : ""; });
    return o;
  }).filter((o) => (o.keyword || "").trim() !== "");
  return { header, rows };
}

export async function recentActivity(n = 15) {
  const values = await readTab("Activity");
  if (values.length < 2) return [];
  const header = values[0].map((h) => String(h || "").trim().toLowerCase());
  return values.slice(-n).reverse().map((r) => {
    const o = {};
    header.forEach((h, c) => { if (h) o[h] = r[c] !== undefined ? String(r[c]) : ""; });
    return o;
  }).filter((o) => o.time && o.time.toLowerCase() !== "time");
}

// add-or-update by keyword (case-insensitive), same semantics as add_keyword.py.
// Extends the header row with any canonical columns it lacks before writing.
export async function upsertKeyword(fields) {
  const kw = String(fields.keyword || "").trim();
  if (!kw) throw new Error("keyword required");
  if (!String(fields.link || "").trim()) throw new Error("link required");
  const values = await readTab("Keywords");
  let header = (values[0] || []).map((h) => String(h || "").trim().toLowerCase()).filter(Boolean);
  if (!header.length) header = [...CANON];
  const missing = CANON.filter((c) => !header.includes(c));
  if (missing.length) {
    header = [...header, ...missing];
    await gs(`/values/${encodeURIComponent(`'Keywords'!A1:${colLetter(header.length)}1`)}?valueInputOption=RAW`, {
      method: "PUT",
      body: JSON.stringify({ values: [header] }),
    });
  }
  const row = header.map((h) => {
    const v = fields[h];
    if (v === undefined || v === null) return "";
    return String(v);
  });
  const existing = values.slice(1).findIndex((r) => String(r[header.indexOf("keyword")] || "").trim().toLowerCase() === kw.toLowerCase());
  if (existing >= 0) {
    const rowN = existing + 2;
    await gs(`/values/${encodeURIComponent(`'Keywords'!A${rowN}:${colLetter(header.length)}${rowN}`)}?valueInputOption=RAW`, {
      method: "PUT",
      body: JSON.stringify({ values: [row] }),
    });
    return { updated: true, row_n: rowN };
  }
  await gs(`/values/${encodeURIComponent(`'Keywords'!A1:${colLetter(header.length)}`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: "POST",
    body: JSON.stringify({ values: [row] }),
  });
  return { updated: false, appended: true };
}

let _sheetGid = null;
async function keywordsGid() {
  if (_sheetGid !== null) return _sheetGid;
  const meta = await gs(`?fields=sheets.properties`);
  const s = (meta.sheets || []).find((x) => x.properties?.title === "Keywords");
  if (!s) throw new Error("Keywords tab not found");
  _sheetGid = s.properties.sheetId;
  return _sheetGid;
}

// duplicate detection (HANDOFF §3): two active rows with the same keyword whose scopes
// overlap (both global, or same post_url, or one global + one locked) = ambiguous firing.
export function findDuplicateWarnings(rows) {
  const act = rows.filter((r) => String(r.active || "TRUE").toUpperCase() !== "FALSE");
  const byKw = {};
  for (const r of act) (byKw[(r.keyword || "").trim().toLowerCase()] ||= []).push(r);
  const warnings = [];
  for (const [kw, group] of Object.entries(byKw)) {
    if (group.length < 2) continue;
    const scopes = group.map((r) => (r.post_url || "").trim());
    const overlap = new Set(scopes).size < scopes.length || scopes.includes("");
    if (overlap) warnings.push(`keyword "${kw}" appears on ${group.length} active rows with overlapping scope — the bot fires the FIRST match only`);
  }
  return warnings;
}

// health (HANDOFF §3 widget): webhooks answer 403 to bare GETs when healthy; token is a
// long-lived IG token, ~60-day life. The expiry date lives in settings (key `ig_token_expiry`)
// so refreshing the token can RESET the countdown — a hardcoded date silently goes stale and
// the warning lies forever. Seeded with the original 2026-06-03 mint (+60d).
const TOKEN_EXPIRY_SEED = "2026-08-02";
const IG_TOKEN_DAYS = 60;

export function getTokenExpiry() {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key='ig_token_expiry'").get();
    if (row && row.value) return row.value;
  } catch { /* settings table not ready */ }
  return TOKEN_EXPIRY_SEED;
}

// Called after Ted refreshes the IG token: restart the ~60-day clock from today.
export function markTokenRefreshed(days = IG_TOKEN_DAYS) {
  const next = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('ig_token_expiry', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).run(next);
  return next;
}
export async function botHealth() {
  const ping = async (url) => {
    // Modal serverless containers cold-start; first hit can exceed 5s. Long timeout +
    // one retry so a sleeping-but-healthy bot never reads as "down".
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(url, { method: "GET", signal: AbortSignal.timeout(15000) });
        return r.status === 403 ? "up" : `odd (${r.status})`;
      } catch { /* retry once */ }
    }
    return "down";
  };
  const [ig, fb] = await Promise.all([
    ping("https://trdteddarwin--ig-comment-dm-web.modal.run/webhook"),
    ping("https://trdteddarwin--fb-keyword-dm-web.modal.run/webhook"),
  ]);
  const expiry = getTokenExpiry();
  const daysLeft = Math.round((new Date(expiry) - Date.now()) / 86400000);
  return { ig, fb, token_days_left: daysLeft, token_est_expiry: expiry };
}

export async function deleteKeyword(keyword) {
  const kw = String(keyword || "").trim().toLowerCase();
  const { header, rows } = await listKeywords();
  void header;
  const hit = rows.find((r) => (r.keyword || "").trim().toLowerCase() === kw);
  if (!hit) throw new Error(`keyword "${keyword}" not found`);
  const gid = await keywordsGid();
  await gs(`:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({
      requests: [
        { deleteDimension: { range: { sheetId: gid, dimension: "ROWS", startIndex: hit.row_n - 1, endIndex: hit.row_n } } },
      ],
    }),
  });
  return { deleted: true };
}
