// AnyMailFinder v5.1: find + verify the decision-maker email for a company, and
// capture the LinkedIn URL + job title + name returned in the SAME call (no extra
// credits). Only "valid" emails are kept for sending — their validation is our
// bounce protection — but enrichment is saved even for risky/unsent leads.

const DM_API = "https://api.anymailfinder.com/v5.1/find-email/decision-maker";
const COMPANY_API = "https://api.anymailfinder.com/v5.1/find-email/company";

export function amfConfigured() {
  return Boolean(process.env.ANYMAILFINDER_API_KEY);
}

async function post(url, body, key) {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 402) return { noCredits: true };
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
  const key = process.env.ANYMAILFINDER_API_KEY || "";
  if (!key) throw new Error("ANYMAILFINDER_API_KEY missing in .env");

  // 1. decision-maker (CEO) — returns email + LinkedIn + title in one shot
  const r = await post(DM_API, {
    ...(domain ? { domain } : {}),
    ...(companyName ? { company_name: companyName } : {}),
    decision_maker_category: ["ceo"],
  }, key);
  if (r.noCredits) return { ok: false, status: "no_credits" };

  const out = normalize(r.data);
  if (out.email) return out; // found a person-level email (valid → send; risky → enrich only)

  // 2. fallback: any validated email at the domain (small biz with no indexed CEO)
  if (domain) {
    const c = await post(COMPANY_API, { domain }, key);
    if (c.noCredits) return { ok: false, status: "no_credits" };
    const cOut = normalize(c.data);
    if (cOut.email) return cOut;
  }
  return { ok: false, status: out.status || "not_found", raw: r.data };
}
