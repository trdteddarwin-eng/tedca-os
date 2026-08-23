// Cloud-native Google Maps scraper via Apify REST (compass/crawler-google-places).
// Runs in-process on the server — no Mac worker, no Python — so lead-gen works in
// the cloud with the laptop off. Needs APIFY_API_TOKEN in env (set in Railway).
import { getKey, markFailed } from "./keys.js";
import { alertCreditOut } from "./credit_alerts.js";

const ACTOR = "compass~crawler-google-places";

export function apifyConfigured() {
  return Boolean(getKey("apify"));
}

// Returns an array of place items (same shape the Python scraper produced).
export async function scrapeGoogleMaps(search, limit = 10) {
  if (!getKey("apify")) throw new Error("APIFY_API_TOKEN not set — add it in Railway Variables or the API Keys page");

  // "a | b" = multiple searches in ONE actor run (cost rule: one run, many searches)
  const searches = String(search || "")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!searches.length) return [];

  const input = {
    searchStringsArray: searches,
    maxCrawledPlacesPerSearch: Number(limit) || 10,
    language: "en",
    deeperCityScrape: false,
    oneReviewPerRow: false,
    // Geographic boundary: the campaign targets New Jersey. Without this the actor
    // broadens a keyword once the local area is tapped out and returns out-of-state
    // places (Denver, SF, Florida). countryCode + state clip results to NJ at the
    // source; engine.js isOffGeo() is the deterministic backstop for anything that
    // slips through. Overridable via env if the target area ever changes.
    countryCode: process.env.APIFY_COUNTRY || "us",
    // No single-state clip: the campaign now targets multiple states (NJ/NY/PA/CT).
    // Per-search location in the query drives geography; engine.js isOffGeo() is the
    // deterministic backstop. Set APIFY_STATE in env to re-clip to one state if needed.
    ...(process.env.APIFY_STATE ? { state: process.env.APIFY_STATE } : {}),
  };

  // ASYNC run + poll (NOT run-sync-get-dataset-items). The sync endpoint has a hard
  // 300s server limit and 408s the moment the actor takes longer — 8 searches × 20
  // places tipped past 300s on Jul 17 and starved the whole day's send. Starting the
  // run and polling removes that ceiling. `timeout=600` caps the actor's own run at
  // 10 min so a stuck actor can't burn credits forever. Token in the Authorization
  // header, never the URL — query strings land in proxy/APM logs verbatim.
  const startRun = () =>
    fetch(`https://api.apify.com/v2/acts/${ACTOR}/runs?timeout=600`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${getKey("apify")}` },
      body: JSON.stringify(input),
    });
  let res = await startRun();
  // Auth/quota failure on the primary key → flip to the fallback key (if one is
  // set on the API Keys page) and retry ONCE. markFailed() logs the switch.
  if ([401, 402, 403].includes(res.status) && markFailed("apify")) {
    res = await startRun();
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    // out of credit (402) or key rejected (401/403) → ping Telegram so Ted knows lead-gen stalled
    if ([401, 402, 403].includes(res.status)) {
      await alertCreditOut("apify", res.status, body.slice(0, 140));
    }
    throw new Error(`Apify run start failed (${res.status}): ${body}`);
  }
  const runData = (await res.json())?.data;
  const runId = runData?.id;
  const datasetId = runData?.defaultDatasetId;
  if (!runId || !datasetId) throw new Error("Apify run start: missing run id / dataset id");

  // Poll the run until it finishes (up to ~9 min wall, safely under the 600s actor cap).
  const deadline = Date.now() + 9 * 60 * 1000;
  let status = runData?.status || "RUNNING";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 8000));
    const s = await fetch(`https://api.apify.com/v2/actor-runs/${runId}`, {
      headers: { Authorization: `Bearer ${getKey("apify")}` },
    });
    if (!s.ok) continue; // transient poll blip — keep waiting
    status = (await s.json())?.data?.status;
    if (["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT", "TIMED_OUT"].includes(status)) break;
  }
  if (status !== "SUCCEEDED") throw new Error(`Apify run did not succeed (status: ${status})`);

  // Fetch the results from the run's dataset.
  const ds = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?clean=true`, {
    headers: { Authorization: `Bearer ${getKey("apify")}` },
  });
  if (!ds.ok) throw new Error(`Apify dataset fetch failed (${ds.status})`);
  const items = await ds.json();
  return Array.isArray(items) ? items : [];
}
