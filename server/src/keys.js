// Central API keystore: one place that knows every paid key the OS runs on.
// - Primary + optional fallback per service, persisted in DATA_DIR/api_keys.json (0600).
// - Lazy-seeded from process.env on first access (the server process already has env
//   loaded — this module NEVER reads a .env file from disk).
// - markFailed(service) flips the active key to the fallback when the primary hits an
//   auth/quota error (401/402/403); call sites retry once.
// - Nothing in this module ever logs or returns a full key: maskedInfo() shows the
//   last 6 characters only.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const SERVICES = {
  apify: { env: "APIFY_API_TOKEN", label: "Apify", credit_api: true },
  anymailfinder: { env: "ANYMAILFINDER_API_KEY", label: "AnyMailFinder", credit_api: true },
  openrouter: { env: "OPENROUTER_API_KEY", label: "OpenRouter", credit_api: true },
  elevenlabs: { env: "ELEVENLABS_API_KEY", label: "ElevenLabs", credit_api: true },
  kie: { env: "KIE_API_KEY", label: "KIE", credit_api: true },
  telegram: { env: "TELEGRAM_BOT_TOKEN", label: "Telegram bot", credit_api: false },
  // Content Posted: read-only post metrics. Two separate integrations — Instagram
  // is reached through graph.instagram.com (Instagram Login), Facebook through
  // graph.facebook.com (Page token). They cannot share a token.
  fb_page: { env: "FB_PAGE_ACCESS_TOKEN", label: "Facebook Page (metrics)", credit_api: false },
  ig_graph: { env: "IG_PAGE_ACCESS_TOKEN", label: "Instagram (metrics)", credit_api: false },
  // Curiosity Hook (YouTube Shorts + its own FB Page) posts through Upload-Post,
  // and its post-analytics endpoint is where those numbers are read back.
  upload_post: { env: "UPLOAD_POST_API_KEY", label: "Upload-Post (Curiosity Hook stats)", credit_api: false },
  // Site Stats reads traffic back out of PostHog. This is the PERSONAL api key
  // (phx_...), not the phc_ project token embedded in the site: that one is
  // write-only by design because it ships in public HTML and cannot read.
  posthog: { env: "POSTHOG_PERSONAL_KEY", label: "PostHog (site stats)", credit_api: false },
};

// Injected logger (same pattern as engine.js) — index.js owns logEvent; importing it
// here would be a circular import.
let logEvent = () => {};
export function bindKeysLogger(fn) {
  logEvent = fn;
}

// Resolved lazily (not at module load) so tests can set DATA_DIR before first use.
function storeFile() {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, "..", "data");
  return path.join(dataDir, "api_keys.json");
}

let state = null; // { service: { primary, fallback, rotated_at, active } }

function load() {
  if (state) return state;
  const file = storeFile();
  state = {};
  try {
    if (fs.existsSync(file)) state = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    // Corrupt store: start fresh from env rather than crash the server. Keys are
    // recoverable (env / rotation), a dead server is not.
    console.error("[keys] api_keys.json unreadable — reseeding from env:", e.message);
    state = {};
  }
  let dirty = false;
  for (const [service, meta] of Object.entries(SERVICES)) {
    const envVal = (process.env[meta.env] || "").trim();
    const cur = state[service];
    if (!cur) {
      state[service] = { primary: envVal || null, fallback: null, rotated_at: null, active: "primary" };
      dirty = true;
    } else if (cur.rotated_at === null && envVal && cur.primary !== envVal) {
      // Never rotated in the OS → the env var stays the source of truth (e.g. the key
      // was updated in Railway Variables). After the first in-OS rotation, store wins.
      cur.primary = envVal;
      dirty = true;
    }
  }
  if (dirty) save();
  return state;
}

function save() {
  const file = storeFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  // 0600: secrets file readable by the server user only. Write-then-rename = atomic,
  // a crash mid-write can never leave a half-written keystore.
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600); // rename preserves tmp's mode, but be explicit
}

function assertService(service) {
  if (!SERVICES[service]) throw new Error(`Unknown service "${service}" — known: ${Object.keys(SERVICES).join(", ")}`);
}

// Active key for a service: primary unless markFailed() flipped it to the fallback.
// Returns "" when nothing is configured (callers already handle missing keys).
export function getKey(service) {
  assertService(service);
  const s = load()[service];
  if (s.active === "fallback" && s.fallback) return s.fallback;
  return s.primary || "";
}

// Primary hit a 401/402/403. If a fallback exists and we're not already on it,
// switch to it and return true (caller should retry once). Otherwise false.
export function markFailed(service) {
  assertService(service);
  const s = load()[service];
  if (s.active === "fallback" || !s.fallback || s.fallback === s.primary) return false;
  s.active = "fallback";
  save();
  logEvent({
    actor: "system",
    message: `Primary ${SERVICES[service].label} key was rejected (auth/quota) — switched to fallback for ${service}.`,
    level: "warn",
  });
  return true;
}

// Rotate the primary and/or set the fallback. A new primary resets active to
// "primary" (a fresh key deserves a fresh chance). Values are trimmed; empty
// strings are ignored (no accidental key wipes).
export function setKeys(service, { primary, fallback } = {}) {
  assertService(service);
  const s = load()[service];
  const p = typeof primary === "string" ? primary.trim() : "";
  const f = typeof fallback === "string" ? fallback.trim() : "";
  if (!p && !f) throw new Error("Nothing to update — provide primary and/or fallback.");
  if (p) {
    s.primary = p;
    s.active = "primary";
  }
  if (f) s.fallback = f;
  s.rotated_at = new Date().toISOString();
  save();
  return maskedFor(service);
}

function mask(key) {
  if (!key) return null;
  // last 4 only (vendor-dashboard convention) — enough to tell keys apart, nothing more.
  return "…" + String(key).slice(-4);
}

function maskedFor(service) {
  const s = load()[service];
  const meta = SERVICES[service];
  return {
    service,
    label: meta.label,
    env: meta.env,
    has_credit_api: meta.credit_api,
    masked_primary: mask(s.primary),
    masked_fallback: mask(s.fallback),
    active: s.active === "fallback" && s.fallback ? "fallback" : "primary",
    rotated_at: s.rotated_at,
  };
}

// Everything the UI needs, with keys masked to the last 6 chars. Full keys never
// leave this module through here.
export function maskedInfo() {
  load();
  return Object.keys(SERVICES).map(maskedFor);
}

// ---- live credit lookups ---------------------------------------------------
// One fetcher per service, each against the provider's real usage endpoint
// (researched 2026-07-07, sources in APIKEYS_BUILDLOG.md). Every fetcher runs with
// a 5s timeout and NEVER throws — on any failure it returns {kind:"unknown"} so the
// route stays alive. Numbers are real or absent; we never fake a credit figure.

async function getJson(url, headers) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const CREDIT_FETCHERS = {
  // docs.apify.com/api/v2/users-me-limits-get → data.limits/current in USD per month
  apify: async (key) => {
    const j = await getJson("https://api.apify.com/v2/users/me/limits", { Authorization: `Bearer ${key}` });
    const used = j?.data?.current?.monthlyUsageUsd;
    const limit = j?.data?.limits?.maxMonthlyUsageUsd;
    if (typeof used !== "number" || typeof limit !== "number") return { kind: "unknown" };
    return {
      kind: "usd",
      unit: "$",
      used: round2(used),
      limit: round2(limit),
      remaining: round2(Math.max(0, limit - used)),
      detail: "monthly platform usage",
    };
  },
  // anymailfinder.com/email-finder-api/docs/account → { credits_left } ; raw key, no Bearer
  anymailfinder: async (key) => {
    const j = await getJson("https://api.anymailfinder.com/v5.1/account", { Authorization: key });
    if (typeof j?.credits_left !== "number") return { kind: "unknown" };
    return { kind: "credits", unit: "credits", remaining: j.credits_left, limit: null, detail: "verified find = 2 credits" };
  },
  // openrouter.ai/docs → GET /api/v1/key → data.{usage, limit, limit_remaining}
  openrouter: async (key) => {
    const j = await getJson("https://openrouter.ai/api/v1/key", { Authorization: `Bearer ${key}` });
    const d = j?.data;
    if (!d || typeof d.usage !== "number") return { kind: "unknown" };
    if (typeof d.limit === "number") {
      return {
        kind: "usd",
        unit: "$",
        used: round2(d.usage),
        limit: round2(d.limit),
        remaining: round2(typeof d.limit_remaining === "number" ? d.limit_remaining : Math.max(0, d.limit - d.usage)),
        detail: "key credit limit",
      };
    }
    // No limit set on the key → OpenRouter reports lifetime usage only.
    return { kind: "usd", unit: "$", used: round2(d.usage), limit: null, remaining: null, detail: "no key limit set — lifetime usage shown" };
  },
  // elevenlabs.io/docs → GET /v1/user/subscription, xi-api-key header
  elevenlabs: async (key) => {
    const j = await getJson("https://api.elevenlabs.io/v1/user/subscription", { "xi-api-key": key });
    if (typeof j?.character_count !== "number" || typeof j?.character_limit !== "number") return { kind: "unknown" };
    return {
      kind: "characters",
      unit: "chars",
      used: j.character_count,
      limit: j.character_limit,
      remaining: Math.max(0, j.character_limit - j.character_count),
      detail: j.next_character_count_reset_unix
        ? `resets ${new Date(j.next_character_count_reset_unix * 1000).toLocaleDateString()}`
        : "this billing period",
    };
  },
  // docs.kie.ai/common-api/get-account-credits → { code, msg, data: <remaining> }
  kie: async (key) => {
    const j = await getJson("https://api.kie.ai/api/v1/chat/credit", { Authorization: `Bearer ${key}` });
    if (j?.code !== 200 || typeof j?.data !== "number") return { kind: "unknown" };
    return { kind: "credits", unit: "credits", remaining: j.data, limit: null, detail: "account balance" };
  },
};

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Live remaining-credit lookup for one service using its ACTIVE key. Never throws.
export async function fetchCredits(service) {
  assertService(service);
  if (!SERVICES[service].credit_api) return { kind: "none", detail: "provider has no credit API" };
  const key = getKey(service);
  if (!key) return { kind: "unknown", detail: "no key configured" };
  try {
    return await CREDIT_FETCHERS[service](key);
  } catch (e) {
    return { kind: "unknown", detail: `lookup failed (${String(e.message || e).slice(0, 60)})` };
  }
}
