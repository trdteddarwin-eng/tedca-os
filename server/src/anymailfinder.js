// AnyMailFinder: find + verify the decision-maker email for a domain.
// Only "valid" results are kept (their validation IS our verification).

const API = "https://api.anymailfinder.com/v5.0/search/decision-maker.json";
const COMPANY_API = "https://api.anymailfinder.com/v5.0/search/company.json";

// Local businesses rarely have an indexed "CEO" — fall back to any validated
// email at the domain. Prefer personal-looking addresses over generic ones.
const GENERIC = /^(info|contact|hello|office|admin|support|sales|booking|appointments|frontdesk|team)@/i;

async function findCompanyEmail(domain, key) {
  const res = await fetch(COMPANY_API, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ domain }),
  });
  if (res.status === 402) return { ok: false, status: "no_credits" };
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) return { ok: false, status: "not_found", raw: data };
  const emails = data.results?.emails || [];
  if (!emails.length) return { ok: false, status: "not_found", raw: data };
  const validation = String(data.results?.validation || "unknown").toLowerCase();
  const pick = emails.find((e) => !GENERIC.test(e)) || emails[0];
  return {
    ok: validation === "valid" || validation === "verified",
    email: pick,
    status: validation,
    name: null,
    raw: data,
  };
}

export function amfConfigured() {
  return Boolean(process.env.ANYMAILFINDER_API_KEY);
}

// Returns { ok, email, status, name, raw } — ok only when status is valid.
export async function findCeo({ domain, companyName }) {
  const key = process.env.ANYMAILFINDER_API_KEY || "";
  if (!key) throw new Error("ANYMAILFINDER_API_KEY missing in .env");

  const res = await fetch(API, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(domain ? { domain } : {}),
      ...(companyName ? { company_name: companyName } : {}),
      decision_maker_category: "ceo",
    }),
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`AnyMailFinder returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }

  if (res.status === 402) return { ok: false, status: "no_credits", raw: data };
  if (res.status === 404 || data?.success === false) {
    // no indexed decision-maker — fall back to any validated email at the domain
    if (domain) return findCompanyEmail(domain, key);
    return { ok: false, status: "not_found", raw: data };
  }
  if (!res.ok) throw new Error(`AnyMailFinder error ${res.status}: ${text.slice(0, 200)}`);

  // Field shapes vary by plan/version — check defensively.
  const results = data.results || data;
  const email = results.email || (Array.isArray(results.emails) ? results.emails[0] : null);
  const validation = results.validation || results.email_status || data.validation || "unknown";
  const name = results.person_full_name || results.full_name || null;

  if (!email || typeof email !== "string") return { ok: false, status: "not_found", raw: data };
  const status = String(validation).toLowerCase();
  return {
    ok: status === "valid" || status === "verified",
    email,
    status,
    name,
    raw: data,
  };
}
