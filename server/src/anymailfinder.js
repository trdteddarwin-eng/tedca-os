// AnyMailFinder v5.1: find + verify the decision-maker email for a company, and
// capture the LinkedIn URL + job title + name returned in the SAME call (no extra
// credits). Only "valid" emails are kept for sending — their validation is our
// bounce protection — but enrichment is saved even for risky/unsent leads.

import { getKey, markFailed } from "./keys.js";
import { alertCreditOut } from "./credit_alerts.js";

const DM_API = "https://api.anymailfinder.com/v5.1/find-email/decision-maker";
const COMPANY_API = "https://api.anymailfinder.com/v5.1/find-email/company";
// Verify an address we already have (a lead file that came WITH emails). Priced far
// below a find (fractions of a credit; a repeat within 30 days is free), and it is
// the only honest way to keep Ted's supplied address instead of swapping it for
// whichever CEO AnyMailFinder guesses.
const VERIFY_API = "https://api.anymailfinder.com/v5.1/verify-email";

export function amfConfigured() {
  return Boolean(getKey("anymailfinder"));
}

async function post(url, body) {
  const send = () =>
    fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${getKey("anymailfinder")}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  let res = await send();
  // 401/403 = bad key, 402 = this account is out of credits. All three flip to the
  // fallback key (if set on the API Keys page) and retry ONCE — a fallback account
  // with credits keeps the verify loop alive. Only after that does 402 surface as
  // noCredits (the engine's existing stop signal).
  if ([401, 402, 403].includes(res.status) && markFailed("anymailfinder")) {
    res = await send();
  }
  if (res.status === 402) {
    await alertCreditOut("anymailfinder", 402, "AnyMailFinder account has no credits left.");
    return { noCredits: true };
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`AnyMailFinder returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  return { res, data };
}

// normalize a v5.1 response into our internal shape
function normalize(d = {}) {
  const status = String(d.email_status || "unknown").toLowerCase();
  const email = d.valid_email || d.email || (Array.isArray(d.emails) ? d.emails[0] : null);
  return {
    ok: status === "valid" && Boolean(email), // only valid emails are safe to send
    email: email || null,
    status,
    name: d.person_full_name || null,
    title: d.person_job_title || null,
    linkedin: d.person_linkedin_url || null,
    // real spend for the daily budget meter. If the provider ever stops sending the
    // field, assume list price on a hit rather than silently metering zero.
    credits: (() => {
      const c = d.credits_charged ?? d.credits_used;
      if (c != null) return Number(c) || 0;
      return status === "valid" && email ? 2 : 0;
    })(),
    raw: d,
  };
}

// Verify ONE known address. Returns { ok, status: valid|invalid|risky|unknown, credits, raw }.
// Never throws on a provider verdict; throws only on network/non-JSON so the caller
// can treat it as transient (leave the lead untouched, retry later).
// Only a verdict ABOUT THE ADDRESS may be recorded. Everything else must throw so
// the caller returns "error" and leaves the lead untouched for a later retry.
// 400/422 = "that string is not an email"; 429/408/423/425 = us, not them, and
// stamping those permanently kills good leads (the 2026-08-26 incident, 232 dead).
const ADDRESS_VERDICT_STATUS = new Set([400, 422]);
export async function verifyEmail(email) {
  if (!getKey("anymailfinder")) throw new Error("ANYMAILFINDER_API_KEY missing — set it in env or the API Keys page");
  const r = await post(VERIFY_API, { email: String(email).trim() });
  if (r.noCredits) return { ok: false, status: "no_credits", credits: 0 };
  const d = r.data || {};
  if (r.res && !r.res.ok) {
    if (ADDRESS_VERDICT_STATUS.has(r.res.status)) return { ok: false, status: "invalid", credits: 0, raw: d };
    // 401/403 after the fallback-key retry lands here too: an expired key must never
    // be read as "every address in Ted's batch is dead".
    throw new Error(`AnyMailFinder verify HTTP ${r.res.status}`);
  }
  const status = String(d.email_status || d.status || d.result || "unknown").toLowerCase();
  const norm = status === "valid" || status === "deliverable" ? "valid" : status === "invalid" || status === "undeliverable" ? "invalid" : status === "risky" || status === "catch_all" || status === "catch-all" || status === "accept_all" ? "risky" : "unknown";
  // credits_charged is real (confirmed against the live API: 0.2 a verify, 0 on a
  // repeat inside 30 days). Fall back to the list price if it ever goes missing, so
  // the daily budget can never silently become a no-op.
  const charged = d.credits_charged ?? d.credits_used;
  const credits = charged == null ? 0.2 : Number(charged) || 0;
  return { ok: norm === "valid", status: norm, credits, raw: d };
}

// Returns { ok, email, status, name, title, linkedin, raw }.
export async function findCeo({ domain, companyName }) {
  if (!getKey("anymailfinder")) throw new Error("ANYMAILFINDER_API_KEY missing — set it in env or the API Keys page");

  // 1. decision-maker (CEO) — returns email + LinkedIn + title in one shot
  const r = await post(DM_API, {
    ...(domain ? { domain } : {}),
    ...(companyName ? { company_name: companyName } : {}),
    decision_maker_category: ["ceo"],
  });
  if (r.noCredits) return { ok: false, status: "no_credits" };

  const out = normalize(r.data);
  if (out.email) return out; // found a person-level email (valid → send; risky → enrich only)

  // 2. fallback: any validated email at the domain (small biz with no indexed CEO)
  if (domain) {
    const c = await post(COMPANY_API, { domain });
    if (c.noCredits) return { ok: false, status: "no_credits" };
    const cOut = normalize(c.data);
    if (cOut.email) return cOut;
  }
  return { ok: false, status: out.status || "not_found", raw: r.data };
}
