// AnyMailFinder v5.1: find + verify the decision-maker email for a company, and
// capture the LinkedIn URL + job title + name returned in the SAME call (no extra
// credits). Only "valid" emails are kept for sending — their validation is our
// bounce protection — but enrichment is saved even for risky/unsent leads.

import { getKey, markFailed } from "./keys.js";
import { alertCreditOut } from "./credit_alerts.js";

const DM_API = "https://api.anymailfinder.com/v5.1/find-email/decision-maker";
const COMPANY_API = "https://api.anymailfinder.com/v5.1/find-email/company";

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
    raw: d,
  };
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
