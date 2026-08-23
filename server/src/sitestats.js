// ──────────────────────────────────────────────────────────────────────────
// Site stats — daily numbers for the rank-and-rent sites, in one place.
//
// Three independent sources, each allowed to fail on its own. A dashboard that
// blanks out entirely because one upstream is down is worse than useless, so
// every source returns { ok, error } and the page renders whatever came back.
//
//   traffic  PostHog HogQL       today vs yesterday, live, needs a PERSONAL key
//   leads    Apps Script doGet   the actual money metric, public endpoint
//   search   gsc_history.csv     Google impressions/clicks, local file, lags ~3d
//
// Why PostHog needs a second key: the phc_ token embedded in the site is
// write-only by design (it ships in public HTML). Reading anything back
// requires a personal API key, which is why traffic reports "not configured"
// until one is set rather than silently showing zero.
// ──────────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getKey } from "./keys.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The sites this dashboard knows about. Adding a second rank-and-rent site is
// a new entry here, not new code.
export const SITES = {
  epoxy: {
    label: "Epoxy Flooring Bergen",
    domain: "epoxyflooringbergen.com",
    posthogProjectId: "561531",
    posthogHost: "https://us.posthog.com",
    leadsEndpoint:
      "https://script.google.com/macros/s/AKfycbzpw3gTn5ULOwzyYKbQeP5pI-dvfUfGe-n8DD0wkKFZwvEWG9qsGOb5m-SjnsYxELTr/exec",
    // Local only. Railway has no copy of the rank-and-rent repo, so this is
    // expected to be missing in the cloud and the section just reports so.
    gscHistoryCsv: path.join(
      __dirname, "..", "..", "..", "rank-and-rent", "tracking", "gsc_history.csv"
    ),
  },
};

// The site sells to New Jersey, and Ted reads this over morning coffee in the
// same timezone. Bucketing by UTC would roll the day over at 8pm and make
// "today" wrong for the whole evening.
// Must stay byte-identical to ANON_QUERY in rank-and-rent/tracking/gsc_report.py.
// It labels the impressions/clicks Search Console reports in a day's total but
// withholds from the query dimension. Summed into daily totals, excluded from
// top queries.
const ANON_QUERY = "(anonymized long-tail)";

const TZ = "America/New_York";

function dayKey(d) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

function dayOffset(n) {
  return dayKey(new Date(Date.now() + n * 86400000));
}

// ---------------------------------------------------------------- traffic ---

async function fetchTraffic(site) {
  const key = getKey("posthog");
  if (!key) {
    return {
      ok: false,
      configured: false,
      error: "No PostHog personal API key set. Add one on the API Keys page.",
    };
  }

  // One round trip for both numbers. Grouping by day and letting the caller
  // pick today/yesterday beats two queries that could straddle midnight.
  const hogql = `
    SELECT toDate(timestamp) AS day,
           countIf(event = '$pageview') AS views,
           count(DISTINCT person_id)    AS visitors,
           countIf(event = 'click_to_call')  AS calls,
           countIf(event = 'form_submit')    AS forms,
           countIf(event = 'generate_lead')  AS leads,
           countIf(event = 'quote_estimate') AS estimates
    FROM events
    WHERE timestamp >= now() - INTERVAL 8 DAY
    GROUP BY day
    ORDER BY day DESC`;

  const res = await fetch(`${site.posthogHost}/api/projects/${site.posthogProjectId}/query/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query: hogql } }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return {
      ok: false,
      configured: true,
      error: `PostHog ${res.status}${res.status === 401 ? " (key rejected)" : ""}: ${body.slice(0, 160)}`,
    };
  }

  const json = await res.json();
  const days = (json.results || []).map((r) => ({
    day: String(r[0]).slice(0, 10),
    views: Number(r[1]) || 0,
    visitors: Number(r[2]) || 0,
    calls: Number(r[3]) || 0,
    forms: Number(r[4]) || 0,
    leads: Number(r[5]) || 0,
    estimates: Number(r[6]) || 0,
  }));

  const blank = { views: 0, visitors: 0, calls: 0, forms: 0, leads: 0, estimates: 0 };
  const pick = (k) => days.find((d) => d.day === k) || { day: k, ...blank };

  return {
    ok: true,
    configured: true,
    today: pick(dayOffset(0)),
    yesterday: pick(dayOffset(-1)),
    days,
  };
}

// ------------------------------------------------------------------ leads ---

// A lead row is synthetic if it is one of our own end-to-end tests or an
// obvious spam bot. On 2026-08-21 the panel reported "1 lead yesterday, 4 this
// week" when the real count was ZERO: seven rows were diagnostics and one was a
// bot. Inflated lead counts are worse than none here, because lead volume is
// the entire pitch to a prospective renter.
//
// Filtering happens on read rather than by deleting rows, so the sheet keeps its
// audit trail and future test rows are handled automatically.
const TEST_PHONE_SUFFIXES = ["0000", "0123", "0322", "0888", "0999", "1234"];
const TEST_NAME_TOKENS = ["TEST", "DIAGNOSTIC", "DBG", "SAFE TO DELETE"];
// Real submissions carry one of these tags, written by the site's own forms.
const REAL_LEAD_TAGS = ["HERO BAR", "QUOTE UNLOCKED", "HOT LEAD", "BOOKED MEASURE"];

function isSyntheticLead(r) {
  const blob = `${r.name} ${r.message} ${r.town} ${r.service}`.toUpperCase();
  if (TEST_NAME_TOKENS.some((t) => blob.includes(t))) return true;

  const digits = String(r.phone || "").replace(/\D/g, "");
  if (digits && TEST_PHONE_SUFFIXES.includes(digits.slice(-4))) return true;

  // Spam bots: an unusable phone number and none of the form's own tags. A real
  // US number is 10 digits, or 11 starting with the country code 1. The bot that
  // got through on 2026-08-20 used `89468759124` - 11 digits, so a bare length
  // check passed it, but no US number starts with 8 at that length.
  const tagged = REAL_LEAD_TAGS.some((t) => String(r.message || "").toUpperCase().includes(t));
  if (!tagged && digits) {
    const usable =
      digits.length === 10 || (digits.length === 11 && digits.startsWith("1"));
    if (!usable) return true;
  }

  return false;
}

async function fetchLeads(site) {
  const res = await fetch(`${site.leadsEndpoint}?type=leads&n=200`, {
    redirect: "follow",
  });
  if (!res.ok) return { ok: false, error: `Lead sheet ${res.status}` };

  const json = await res.json().catch(() => null);
  if (!json || !json.ok) return { ok: false, error: "Lead sheet returned an unexpected body" };

  // Rows arrive newest first. Blank rows are the signature of the old Apps
  // Script failing to parse a payload, so they are surfaced rather than hidden:
  // a spike in these means leads are being eaten again.
  const rows = (json.rows || []).map((r) => {
    const ts = r.timestamp ? new Date(r.timestamp) : null;
    const blank = !r.name && !r.phone && !r.email;
    return {
      day: ts && !isNaN(ts) ? dayKey(ts) : null,
      when: ts && !isNaN(ts) ? ts.toISOString() : null,
      name: String(r.name || ""),
      phone: String(r.phone || ""),
      town: String(r.town || ""),
      service: String(r.service || ""),
      message: String(r.message || ""),
      source: String(r.source_page || ""),
      blank,
    };
  });

  // Everything below counts REAL leads only. `syntheticRows` is surfaced so the
  // number stays visible rather than quietly vanishing.
  const real = rows.filter((r) => !r.blank && !isSyntheticLead(r));
  const synthetic = rows.filter((r) => !r.blank && isSyntheticLead(r));

  const countOn = (k) => real.filter((r) => r.day === k).length;
  const last7 = new Set(Array.from({ length: 7 }, (_, i) => dayOffset(-i)));

  return {
    ok: true,
    today: countOn(dayOffset(0)),
    yesterday: countOn(dayOffset(-1)),
    last7: real.filter((r) => r.day && last7.has(r.day)).length,
    total: real.length,
    blankRows: rows.filter((r) => r.blank).length,
    syntheticRows: synthetic.length,
    recent: real.slice(0, 12),
  };
}

// ----------------------------------------------------------------- search ---

function readSearch(site) {
  if (!site.gscHistoryCsv || !fs.existsSync(site.gscHistoryCsv)) {
    return {
      ok: false,
      error: "No Search Console history on this machine. Run tracking/gsc_report.py locally.",
    };
  }

  const text = fs.readFileSync(site.gscHistoryCsv, "utf8").trim();
  const lines = text.split("\n");
  const header = lines.shift().split(",");
  const idx = (n) => header.indexOf(n);

  const byDay = new Map();
  const queries = new Map();
  let latest = "";

  for (const line of lines) {
    // Queries can contain commas, so split from the right where the numeric
    // columns are fixed-width in count rather than trusting a naive split.
    const parts = line.split(",");
    if (parts.length < header.length) continue;
    const date = parts[idx("date")];
    const tail = parts.slice(-4);
    const impressions = Number(tail[0]) || 0;
    const clicks = Number(tail[1]) || 0;
    const position = Number(tail[3]) || 0;
    const query = parts.slice(2, parts.length - 4).join(",");

    if (date > latest) latest = date;
    // Position is weighted by impressions. A flat mean lets a query with one
    // impression at position 3 outweigh one with 50 impressions at position 60.
    const d = byDay.get(date) || { day: date, impressions: 0, clicks: 0, posSum: 0, n: 0 };
    d.impressions += impressions; d.clicks += clicks;
    d.posSum += position * impressions; d.n += impressions;
    byDay.set(date, d);

    // ANON_QUERY is the remainder Search Console withholds from the query
    // dimension. It belongs in the daily totals above but is not a query, so it
    // must never appear in a "top queries" list.
    if (query === ANON_QUERY) continue;

    const q = queries.get(query) || { query, impressions: 0, clicks: 0, posSum: 0, n: 0, lastSeen: date };
    q.impressions += impressions; q.clicks += clicks;
    q.posSum += position * impressions; q.n += impressions;
    if (date > q.lastSeen) q.lastSeen = date;
    queries.set(query, q);
  }

  const days = [...byDay.values()]
    .map((d) => ({ day: d.day, impressions: d.impressions, clicks: d.clicks, position: d.n ? +(d.posSum / d.n).toFixed(1) : 0 }))
    .sort((a, b) => (a.day < b.day ? 1 : -1));

  const top = [...queries.values()]
    .filter((q) => q.lastSeen === latest)
    .map((q) => ({ query: q.query, impressions: q.impressions, clicks: q.clicks, position: q.n ? +(q.posSum / q.n).toFixed(1) : 0 }))
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 15);

  return {
    ok: true,
    // Google's data is 2-3 days behind, so labelling this "today" would be a
    // lie. The dashboard shows the date it actually covers.
    latestDay: latest,
    days: days.slice(0, 8),
    topQueries: top,
    stale: latest < dayOffset(-4),
  };
}

// ------------------------------------------------------------------- api ----

export async function siteStats(siteId = "epoxy") {
  const site = SITES[siteId];
  if (!site) throw new Error(`unknown site: ${siteId}`);

  // Independent sources run together and settle independently: a PostHog
  // outage must not take the lead count down with it.
  const [traffic, leads] = await Promise.all([
    fetchTraffic(site).catch((e) => ({ ok: false, error: String(e.message || e) })),
    fetchLeads(site).catch((e) => ({ ok: false, error: String(e.message || e) })),
  ]);

  let search;
  try {
    search = readSearch(site);
  } catch (err) {
    search = { ok: false, error: String(err.message || err) };
  }

  return {
    site: { id: siteId, label: site.label, domain: site.domain },
    generatedAt: new Date().toISOString(),
    today: dayOffset(0),
    yesterday: dayOffset(-1),
    traffic,
    leads,
    search,
  };
}
