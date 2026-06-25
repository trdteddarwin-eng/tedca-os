// Cloud-native Google Maps scraper via Apify REST (compass/crawler-google-places).
// Runs in-process on the server — no Mac worker, no Python — so lead-gen works in
// the cloud with the laptop off. Needs APIFY_API_TOKEN in env (set in Railway).
const ACTOR = "compass~crawler-google-places";

export function apifyConfigured() {
  return Boolean(process.env.APIFY_API_TOKEN);
}

// Returns an array of place items (same shape the Python scraper produced).
export async function scrapeGoogleMaps(search, limit = 10) {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) throw new Error("APIFY_API_TOKEN not set — add it in Railway Variables");

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
  };

  // run-sync-get-dataset-items runs the actor and returns the results in one call
  const url = `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?token=${token}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(`Apify scrape failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  const items = await res.json();
  return Array.isArray(items) ? items : [];
}
