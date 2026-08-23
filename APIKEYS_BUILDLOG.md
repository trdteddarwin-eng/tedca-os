# API Keys Manager — Build Log

Goal: one OS page to (1) see remaining credit/usage per paid API key, (2) rotate any key,
(3) set a fallback key per service that auto-fires on 401/402/403 from the primary.

House rule: no button exists unless it actually works. This log records every action honestly,
including wrong turns. No full key ever appears in this file — masked (last 6) only.

---

## 2026-07-07 11:54 — Recon

Grepped repo + workspace `execution/` for env var names. Confirmed exact names:

| Service       | Env var                 | Live call site in tedca-os                     |
|---------------|-------------------------|------------------------------------------------|
| Apify         | `APIFY_API_TOKEN`       | `server/src/scrape.js` (run-sync actor call)   |
| AnyMailFinder | `ANYMAILFINDER_API_KEY` | `server/src/anymailfinder.js` (v5.1 find-email)|
| OpenRouter    | `OPENROUTER_API_KEY`    | `replies.js`, `skills.js`, `linkedin.js`, `index.js:977` |
| ElevenLabs    | `ELEVENLABS_API_KEY`    | `server/src/elevenlabs.js`                     |
| KIE           | `KIE_API_KEY`           | not in tedca-os server — used by `execution/*.py` scripts |
| Telegram bot  | `TELEGRAM_BOT_TOKEN`    | `server/src/telegram.js`, `worker/index.js` (display-only, no credit API) |

Note: the lead's brief says to wire the Apify + AnyMailFinder call sites "in engine.js" —
in reality engine.js imports them; the actual HTTP calls (where the key is used and where a
401/402/403 surfaces) live in `scrape.js` and `anymailfinder.js`. Wiring there = wiring the
live call sites engine.js uses. Recording this as a deliberate interpretation, not a deviation.

Also noted: `anymailfinder.js` already special-cases HTTP 402 as `noCredits` (engine stops the
verify loop). Fallback design must retry 402 with the fallback key first, and only return
`noCredits` if there is no fallback / fallback also fails.

Activity logging: `logEvent({actor, message, level})` exported from `server/src/index.js`;
engine gets it injected via `setLogEvent`. keys.js can't import from index.js (circular),
so keys.js will accept a logger via a setter, same pattern as engine.js uses.

## 2026-07-07 11:58 — Credit endpoint research (WebFetch, real docs)

| Service       | Endpoint | Auth | Fields used |
|---------------|----------|------|-------------|
| Apify         | `GET https://api.apify.com/v2/users/me/limits` | `Authorization: Bearer` | `data.limits.maxMonthlyUsageUsd`, `data.current.monthlyUsageUsd` (docs.apify.com/api/v2/users-me-limits-get). `/usage/monthly` exists too but /limits already carries used+cap in one call, so one request suffices. |
| OpenRouter    | `GET https://openrouter.ai/api/v1/key` | Bearer | `data.usage` (lifetime USD), `data.limit` (null = uncapped), `data.limit_remaining`. Current docs say `/api/v1/key`, NOT the older `/auth/key` the brief mentioned — using the documented one. A `/credits` endpoint was not confirmed in docs; not using unverified endpoints. |
| ElevenLabs    | `GET https://api.elevenlabs.io/v1/user/subscription` | `xi-api-key` header | `character_count`, `character_limit`, `next_character_count_reset_unix` |
| AnyMailFinder | `GET https://api.anymailfinder.com/v5.1/account` | `Authorization: <raw key>` (docs show NO Bearer prefix; matches proven-working `execution/test_decision_maker.py`) | `credits_left` (integer) |
| KIE           | `GET https://api.kie.ai/api/v1/chat/credit` | Bearer | `{code, msg, data}` — `data` = remaining credits (docs.kie.ai/common-api/get-account-credits). Main docs index doesn't link it, found via the common-api path. |
| Telegram bot  | none | — | Bot API has no billing/credit endpoint. Card shows the masked token + "no credit API" honestly. |

Wrong turn logged: `https://docs.kie.ai/api-reference` → 404; docs.kie.ai landing page claims credit
consumption is only visible in the web logs UI — but the dedicated common-api page documents the real
endpoint. Trust the endpoint page.

## 2026-07-07 12:00 — Design decisions before writing keys.js

1. Storage: `server/data/api_keys.json`, written atomically (tmp + rename), mode 0600.
   `DATA_DIR` env respected (same convention as db.js) and resolved lazily so tests can
   point at a temp dir.
2. Shape extends the brief with `active: "primary"|"fallback"` per service — markFailed must
   survive a restart, so which key is live has to be persisted.
3. Seed rule: while a service has never been rotated in the OS (`rotated_at === null`), the
   env var stays the source of truth (a Railway env update wins). After the first in-OS
   rotation, the store wins. Prevents "I updated Railway but the OS ignores it" surprises.
4. Logger: keys.js can't import logEvent from index.js (circular import) — it takes a logger
   via `bindKeysLogger()`, the same pattern engine.js uses.
5. Call sites: wiring goes in scrape.js + anymailfinder.js (the actual fetch()es engine.js
   calls). AMF's existing 402→noCredits path is preserved: 402 retries once on the fallback
   key first; only if there's no fallback (or it also fails) does the engine see no_credits.
6. Node is v24 — global fetch + AbortSignal.timeout(5000) fine.

## 2026-07-07 12:05 — Build

- **`server/src/keys.js`** (new): keystore. `getKey` / `markFailed` / `setKeys` / `maskedInfo` /
  `fetchCredits` / `bindKeysLogger` / `SERVICES`. Atomic 0600 writes to `DATA_DIR/api_keys.json`,
  lazy env seed, per-service credit fetchers (5s timeout, never throw, never fake a number).
- **`server/src/scrape.js`**: token now comes from `getKey("apify")` at request time;
  401/402/403 → `markFailed("apify")` → retry ONCE with the fallback. `apifyConfigured()`
  reads the keystore (so a key rotated in the OS counts as configured).
- **`server/src/anymailfinder.js`**: same wiring in the shared `post()` helper — both the
  decision-maker and company endpoints get failover for free. Order matters and is tested:
  fallback retry runs BEFORE the 402→`noCredits` mapping, so a funded fallback account keeps
  the verify loop alive; `noCredits` only surfaces when there's no fallback (or it failed too).
- **`server/src/index.js`**: `bindKeysLogger(logEvent)` + two `requireUser` routes —
  `GET /api/api-keys` (masked info + live credits via `Promise.all`, each fetcher 5s-capped,
  `unknown` on failure) and `POST /api/api-keys {service, primary?, fallback?}` (logs
  "API key rotated for <service> from the OS" — the key itself is never logged).
- **`app/src/pages/ApiKeys.tsx`** (new): one card per service — big remaining number + bar when
  the provider reports a limit, honest "credits: unknown" / "no credit API" otherwise, masked
  primary/fallback with active badge ("active — primary failed" when failed over), "rotated N
  days ago", password-type inputs + Replace primary / Set fallback buttons (both hit the real
  POST route). Refresh-credits button re-runs the live lookups.
- **`app/src/App.tsx`**: NAV `{ to:"/apikeys", label:"API Keys", short:"Keys", icon:"key" }`,
  hand-drawn key SVG in ICONS, `<Route path="/apikeys">`.
- Not touched: engine.js (it consumes scrape/anymailfinder unchanged), other services' call
  sites (replies/skills/linkedin/elevenlabs still read env directly — they migrate later),
  the dev stack (not restarted), real `server/data/` (verified: no api_keys.json there).

## 2026-07-07 12:08 — Verification (all recorded honestly)

1. `node --check` — keys.js, scrape.js, anymailfinder.js, index.js: **all OK**.
2. `cd app && npx tsc --noEmit` — **exit 0, 0 errors**.
3. Standalone keystore test (`/tmp/apikeys-test/test.mjs`, temp `DATA_DIR`, fake
   `APIFY_API_TOKEN='apify_api_test123456'`): **24/24 PASS** — env seed, 0600 perms on
   api_keys.json, last-6 masking (full key provably absent from maskedInfo output),
   setKeys+rotated_at, markFailed flip + single masked-safe activity event, re-arm on new
   primary, guards (unknown service / empty update throw), telegram→`none`, keyless→`unknown`,
   and a fresh child process proving the store persists and wins over env after rotation.
4. Fallback call-site test (`/tmp/apikeys-test/test-fallback.mjs`, stubbed `fetch`, no network):
   **10/10 PASS** — Apify 402 → exactly 2 calls (primary then fallback) → results returned;
   subsequent scrapes go straight to the fallback; AMF 401 → retry once with fallback →
   valid email returned; AMF 402 with NO fallback → 1 call, `no_credits` preserved (the
   engine's stop signal is intact).
5. Temp test dirs deleted. Nothing committed to git. Stack not restarted — `keys.js` routes and
   call-site wiring go live on the lead's next restart; `api_keys.json` self-creates on first
   access.

Honest limitations:
- Live credit numbers were NOT verified against the real provider accounts (that needs the real
  keys, which only the running server has — and hitting them from here was out of scope). The
  endpoints are documented + the AMF one is proven by existing execution scripts; failures
  degrade to "credits: unknown", never a fake number.
- OpenRouter keys with no key-limit set show lifetime usage (no "remaining" exists at key level).
- KIE/Telegram keys aren't used by any tedca-os server call site yet — their cards manage the
  keys and (for KIE) show balance; failover for them has no call site to wire.
- Env-var changes after an in-OS rotation are ignored by design (store wins once rotated_at is
  set) — documented here so it never reads as a bug.
