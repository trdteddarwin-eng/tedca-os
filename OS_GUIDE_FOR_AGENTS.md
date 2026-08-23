# Tedca OS — Onboarding Guide for Coding Agents

**Read this before touching any code.** This is a live, revenue-producing single-user system. It
sends real cold emails to real business owners, spends real money on APIs, and runs unattended
around the clock. A bad change here doesn't just break a feature — it can double-email a
prospect, blow through an API budget, or silently stop the sales pipeline for days before anyone
notices. Move carefully, verify everything, and prefer the smallest change that solves the
problem.

Owner: Ted Charles (Tedca AI Agency). Code lives at
`/Users/yoljean/Downloads/Ted Workspace/tedca-os`.

---

## 1. What this OS does

Tedca OS is Ted's **mission control** for a one-person AI-automation agency. It's a private web
app (password-gated, single user) that runs three loops:

1. **Outbound money loop (cold-email engine).** Scrape local businesses (Google Maps via Apify) →
   find + verify the owner's email (AnyMailFinder) → send a personalized cold email from a
   rotating pool of inboxes → schedule one follow-up → read replies and auto-classify/respond →
   hand off "hot" (replied) leads to Ted in a CRM thread view. This is the actual sales engine —
   see §4.
2. **Content / inbound loop.** One-click content generation (avatar videos, personal cloned-voice
   videos, carousels, "Live Photo" TikTok/IG posts, educational posts, video editing) rendered by
   a Mac-based worker running headless Claude Code agents, delivered to Telegram. Plus an
   Instagram/Facebook "comment → DM" bot control panel (ManyChat/ig-comment-dm) and post
   performance tracking (Content Posted).
3. **Agent-ops / control-room loop.** A live activity feed (WebSocket) showing every step any
   agent takes, a job queue/history view, API key + credit management, and a CRM for the whole
   pipeline (leads → replied → booked → won/lost).

**Hard product rule, stated in the README and worth repeating: "no button exists unless it
actually works."** No mock data, no dead controls, no fake "coming soon" UI wired to nothing —
if a feature isn't built, the page says so honestly (see `app/src/pages/Brain.tsx` /
`Projects.tsx` for the pattern: plain text explaining what's not live yet, not a fake button).

---

## 2. Architecture

```
 app/  (React + Vite + Tailwind, port 5173 dev)
   │  fetch("/api/...") with Bearer token, WebSocket /ws
   ▼
 server/  (Express + SQLite, port 8790 dev / 8790 in the Railway container)
   │  HTTP job queue (jobs table)
   ▼
 worker/  (Node process on Ted's Mac — polls the server for queued jobs)
   │  shells out to Python (execution/*.py) and headless Claude Code agents
   ▼
 Workspace-root scripts, brain/, execution/, playbooks/ (outside tedca-os/)
```

- **`server/`** — Express API + SQLite (`node:sqlite`, NOT better-sqlite3 — it doesn't compile on
  Node 24, don't add it back) + a `ws` WebSocket server for the live activity feed. Owns every
  integration: Gmail API, SMTP/Zapmail, AnyMailFinder, Apify, OpenRouter, Telegram, ElevenLabs,
  ManyChat/Meta Graph API. This is where almost all logic lives.
- **`app/`** — React 18 + Vite 6 + Tailwind 4 dashboard. Talks to the server exclusively through
  `app/src/api.ts` (`api()`, `apiForm()`, `apiBlobUrl()`, `openFeed()`). No direct DB or
  third-party API access from the browser — everything is proxied and authenticated server-side.
- **`worker/`** (`worker/index.js`) — runs **only on Ted's Mac**, polls
  `POST /api/worker/jobs/claim` every 3s using a separate `WORKER_TOKEN` (not the user session
  token), executes jobs (scrape, TTS, video edit, motion graphic, carousel, Live Photo, AgentOS
  post, etc.), and reports back via `POST /api/worker/jobs/:id/complete` and
  `POST /api/activity`. Several job types spawn a **headless Claude Code agent** with
  `--permission-mode bypassPermissions` (see §10 — this is a known risk area).

### Local vs Railway (cloud)

Both run the exact same `server/` + `app/` code — no branching logic for "local" vs "cloud"
except a few env-gated switches:

| | Local (Mac) | Railway (cloud) |
|---|---|---|
| Server port | `:8790` | `:8790` inside the container, Railway proxies it |
| App | Vite dev server `:5173` (drifts to `:5175` if busy) | Built and served as static files by the Express server (`APP_DIST=/os/app/dist`) |
| Worker | Runs locally, `BACKEND_URL` can point at either local or cloud | Never runs in the cloud — cloud has no filesystem/Python/Claude Code access for that |
| DB | `server/data/tedca-os.db` (SQLite) | SQLite on a Railway **volume mounted at `/data`** (`DATA_DIR=/data`) — survives redeploys |
| Sending | Live sender (when `test_mode=0` and caps allow) | **`SEND_DISABLED=1`** — hard kill switch, see below |
| Scraping | Falls back to dispatching a job to the Mac worker if Apify isn't configured server-side | Calls Apify directly (`server/src/scrape.js`) — lead-gen works with the laptop off |

**`SEND_DISABLED=1`** (Railway env var only) is checked in `pool.js: sendVia()`,
`engine.js: startScheduler()`, `engine.js: startFollowupLoop()`, and `hotleads.js`. While set, the
cloud instance is a fully working dashboard that **cannot send a single email** — this is the
backstop that lets the cloud run 24/7 as a dormant mirror/future-live-sender without risking a
double-send while the Mac is still the live sender. **Do not remove or bypass this without an
explicit instruction from Ted**, and treat any code path that sends email as needing to respect
it.

### Data directory

`DATA_DIR` env var (defaults to `server/data/` locally) holds everything stateful and secret:
`tedca-os.db` (+ `-shm`/`-wal`), `api_keys.json`, `gmail_tokens.json`, `smtp_inboxes.json`,
`manychat_sa.json`, `uploads/`, `output/`, `backups/`. **None of this is committed** —
`.gitignore` and `.dockerignore`/`.railwayignore` all exclude `server/data/`, `.env`, `*.env`.

### Deploy shape

One Docker container (`Dockerfile`): builds the React app (`app/dist`), installs server deps,
runs `node server/src/index.js` with `NODE_ENV=production`, `DATA_DIR=/data`,
`APP_DIST=/os/app/dist`. `railway.json` wires the Dockerfile builder + `/api/health` healthcheck
+ restart-on-failure (max 5 retries).

---

## 3. Data model (SQLite, `server/src/db.js`)

All tables are created with `CREATE TABLE IF NOT EXISTS` + additive `ALTER TABLE ... ADD COLUMN`
migrations wrapped in `try { } catch { /* column already exists */ }` — **this is the project's
migration pattern**. To add a column: add another guarded `ALTER TABLE` block near the others in
`db.js`, never a destructive migration. `PRAGMA journal_mode = WAL` is set; note the code review
flagged that `PRAGMA busy_timeout` is **not** set (see §10 — a known gap, be aware if you touch
concurrent writes).

| Table | Purpose | Key columns |
|---|---|---|
| `leads` | The CRM / pipeline core. One row per business. | `status` (lifecycle, see below), `email_status` (verification outcome), `banked` (saved for a future run), `followup_due_at`, `inbox_used`, CRM fields (`linkedin_url`, `contact_title`, `stage`, `deal_value`, `tags`, `notes`, `sentiment`, `ceo_name`, `phone`, `city`, `state`) |
| `emails` | Every email sent or received. | `lead_id`, `inbox`, `direction` (`out`/`in`), `kind` (`initial`/`followup`/`reply`/`test`), `subject`, `body`, `sent_at`, `gmail_id` |
| `runs` | One row per morning cold-email run. | `status` (`running`/`paused`/`done`/`failed`), `summary`, `cost_usd` |
| `activity_events` | The live feed (source of `/api/activity` + the WebSocket broadcast). | `run_id`, `actor` (`research`/`scrape`/`verify`/`send`/`reply`/`system`/`worker`/`agentos`), `level` (`info`/`warn`/`error`/`success`), `message` |
| `jobs` | The worker job queue. | `type`, `params` (JSON), `status` (`queued`/`claimed`/`done`/`failed`), `result` |
| `settings` | Key-value config, editable from the UI. | See §4 for the safety-critical keys |
| `costs` | Per-provider spend log. | `provider`, `amount_usd` |
| `clients` | Legacy/simple client list (mostly superseded by `leads` + CRM fields). | |
| `sessions` | Login session tokens (never expire — see §10). | `token`, `created_at` |
| `markets` | Market/metro rotation for the scraper. | `status` (`fresh`/`active`/`exhausted`), `runs_used`, `last_new_count` |
| `suppressions` | Permanent opt-out list, keyed by lowercased email. | Checked by `isSuppressed()` before every send |
| `seen_messages` | Dedup for the reply poller (never re-process a message). | |
| `edit_projects` / `edit_versions` | Clip Editor version history (branching video edits). | |
| `content_posts` / `content_metrics` | IG/FB post tracking + metrics time series. | |

### Lead lifecycle (`leads.status`)

```
scraped → sending → emailed → followup_sent → replied
                        │            │
                        ▼            ▼
                    bounced      do_not_contact
                        
   (any point) → skipped   (off-niche / off-geo / dup / suppressed — dead-ended, never sent)
```

- `scraped` — ingested, not yet verified or not yet sent. `banked=1` means "saved for tomorrow,
  not touched today."
- `sending` — **transient claim state** during an atomic send (see §4). A lead stuck here after a
  crash means the send may or may not have gone out — `startOwnerHeartbeat()` on boot logs a
  warning and holds it out of the pool; a human must review and manually set it back.
- `emailed` — initial sent, follow-up scheduled (`followup_due_at`).
- `followup_sent` — follow-up sent, no more automated touches.
- `replied` — lead responded; follow-ups cancelled; this is a "Hot Lead" (see `hotleads.js` /
  `HotLeads.tsx`).
- `bounced` — hard bounce detected, address suppressed, no more sends.
- `do_not_contact` — explicit opt-out (unsubscribe keyword or LLM-classified `unsubscribe`).
  Permanent, checked via `suppressions` table too.
- `skipped` — dead-ended before ever being sendable (see `email_status` below for why).

### `email_status` (why a lead never got an email)

`valid` (safe to send), `risky`/`unknown`/`not_found` (AnyMailFinder couldn't confirm),
`platform` (only email found was a platform/aggregator address, e.g. `sundar@google.com`),
`duplicate` (same owner already contacted via another lead row), `dup_recipient` (final guard
right before send caught a dupe), `off_niche` / `off_geo` (filtered by category/state regex before
ever spending an AnyMailFinder credit), `suppressed` (address previously opted out or bounced).

---

## 4. The cold-email engine (`server/src/engine.js`) — read this before touching sending logic

This is the highest-stakes file in the repo. `startMorningRun()` → `executeRun()` runs a
**producer/consumer pipeline**: a `producer()` keeps a queue of verified, sendable leads topped
up (scraping more via Apify when supply runs low), while `sendFromQueue()` drains it concurrently
— so sending starts immediately from the lead bank instead of waiting for a fresh scrape.

### Pipeline stages

1. **Bank first.** Every run checks `leads WHERE banked=1 AND status='scraped'` before scraping —
   free, reuses yesterday's leftovers.
2. **Scrape (Apify)** — `runScrapeJob()`. Cloud calls Apify directly
   (`scrape.js: scrapeGoogleMaps()`); local falls back to dispatching a `scrape` job to the Mac
   worker if no Apify key is configured server-side. **Cost guard: `MAX_SCRAPES_PER_RUN = 2`** —
   never more than 2 Apify calls per run, and each run uses **one** actor call covering multiple
   search strings (`"a | b"` syntax), never N calls. Off-niche (`isOffNiche()`, regex against
   `category`) and off-geo (`isOffGeo()`, regex against `state`) leads are dropped **before**
   insertion in `ingestLeads()`, and again before AnyMailFinder in `verifyOne()` — so a bad match
   never costs a verification credit.
3. **Verify (AnyMailFinder)** — `anymailfinder.js: findCeo()`. Tries `decision-maker` (CEO) first,
   falls back to `company` (any validated email at the domain). **Only `email_status='valid'`
   emails are ever queued to send** — this is the bounce-protection guarantee. Platform/aggregator
   domains (`BLOCKED_EMAIL_DOMAINS` — google.com, gmail.com, wixsite.com, booksy.com, etc.) are
   rejected even if AnyMailFinder calls them "valid." A domain that already produced a contacted
   lead is **never re-queried** (`emailContactedElsewhere()` checked before AnyMailFinder even
   runs, via `verifyOne()`'s pool query).
4. **Send** — `sendBatch()` / `sendFromQueue()`. See "Sending safety" below.
5. **Follow-up** — `startFollowupLoop()`, runs every 60s, sends exactly one follow-up per lead at
   a randomized business-hour time (`followupDueAt()` — 3±1 days out, random hour/minute so it's
   not a robotic exact-time repeat).
6. **Bank the rest** — any `status='scraped'` lead left at the end of a run gets `banked=1` for
   tomorrow.

### Safety mechanisms (do not weaken any of these without asking)

- **`SEND_DISABLED=1`** kill switch — see §2.
- **`test_mode` setting** (`"1"`/`"0"`) — when on, every send (initial, follow-up, auto-reply)
  redirects to `TEST_RECIPIENT` from `.env`, never a real lead, and the subject is prefixed
  `[TEST → lead@x]`. Checked independently on **every** automated send path. This is the primary
  safety net for testing changes — **always test with `test_mode=1` first.**
- **Single-owner send lock** — `iOwnSendLock()` / `startOwnerHeartbeat()`. Only one live process
  may hold the `send_owner` setting (heartbeat refreshed every 30s, 90s TTL). Guards against two
  server instances (a stale orphan + a fresh one) both sending. **Known gap:** the lock is a
  non-atomic check-then-write (see §10, CODE_REVIEW finding A1) — be careful if you touch it.
- **Atomic per-lead claim.** Follow-ups: `UPDATE leads SET status='followup_sent' WHERE id=? AND
  status='emailed'`, only proceed if `changes===1`. Initial sends currently do **not** have the
  same atomic claim before send (CODE_REVIEW finding A2) — a known open risk, not something to
  quietly "fix" as a side effect of an unrelated change; flag it if you're asked to touch this
  path.
- **Multiple dedup layers**, all defense-in-depth: `alreadyEmailedAddress()` (has this exact
  address ever received an `initial`, even under a different lead row?),
  `emailContactedElsewhere()` (same email, different lead id, already in a contacted status),
  ingest-time domain/name dedup in `ingestLeads()`, and a final check inside `sendBatch()` before
  the send call. **Never email the same person twice, ever** — not just "not today."
- **Caps.** `per_inbox_cap` (default 20/day/inbox), `per_domain_cap` (default 24/day/domain — a
  domain can host multiple inboxes), `daily_send_ceiling` (default 220 — initials + follow-ups
  combined), plus a per-SMTP-inbox age **ramp** (`smtp.js: smtpInboxCap()` — 12→50 over the first
  week for a non-prewarmed inbox). `capFor()` takes the **minimum** of the flat setting and the
  ramp.
- **Bounce circuit breaker** — `startBounceGuard()`, every 30 min: warns at 3% 7-day bounce rate,
  **auto-pauses** the inbox (adds to `paused_inboxes` setting) at 5%, Telegrams Ted.
- **CAN-SPAM gate** — live sends are blocked entirely if `compliance_footer` setting is unset
  (`sendBatch()` checks this before sending anything non-test).
- **Send pacing/jitter** — `jitterMs()`, 8s floor + configurable spread, held **inside** the
  single global send-chain mutex (`_sendChain`) so the morning-run loop and follow-up loop can
  never interleave into a burst.
- **Business-hours window** — `withinSendWindow()`: Mon–Fri 8:00–17:00 America/New_York, computed
  from wall-clock ET regardless of server TZ.
- **Market rotation** — one metro at a time (`markets` table); a market that yields fewer than
  `EXHAUST_NEW_MIN=10` new businesses on a completed scrape is retired and never re-scraped
  (`recordMarketRun()`).
- **Spintax + template safety** — `fillTemplate()` uses callback-based `.replaceAll()` (never
  raw `$`-pattern replace, which could mis-expand `$&`/`$$` from scraped text) and strips CR/LF
  from interpolated fields so scraped business names can't inject headers.

### Sending transports (`pool.js`, `gmail.js`, `smtp.js`)

`pool.js: sendVia({from, to, subject, body, ...})` is the single entry point every send path uses
— it checks `SEND_DISABLED` first, then routes by inbox: `isSmtpInbox(from)` →
`smtp.js: sendEmailSMTP()` (nodemailer, Zapmail app-password inboxes, `.co` domains), else
`gmail.js: sendEmail()` (Gmail API, OAuth refresh-token flow, `tedcas.org` `.org` domains).

`engine.js: activeInboxes()` is the actual pool the engine draws from: `sendingInboxes()`
(union of Gmail + SMTP) filtered by the **`send_transport` setting** (`"smtp"` → Zapmail only,
`"gmail"` → tedcas.org only, unset → all) and then by **`paused_inboxes`** (comma-separated
emails resting to protect deliverability — set manually or by the bounce guard). **If you add a
new sending path, it must go through `activeInboxes()` / `sendVia()`, never call `gmail.js` or
`smtp.js` directly** — several P2 findings in the code review are exactly this mistake
(`/api/gmail/test-send` bypasses `activeInboxes()`, `replies.js` auto-reply doesn't check
`paused_inboxes`).

Sender identity: `senderNameFor(inbox)` looks up the SMTP inbox's persona first name
(`smtp.js: smtpFirstName()`, from `smtp_inboxes.json`), falling back to a capitalized local-part —
this is who the email is signed as (`{sender_name}` template token).

### Scheduler

`startScheduler()` (`engine.js`), ticks every 60s: fires once per weekday at `schedule_hour`
(default 8 ET) plus a randomized 0–44 min offset derived from the date (never a robotic exact
`HH:00`), with **catch-up** logic if the window was missed (a downed stack, a DNS blip) — it fires
at the next healthy tick within the send window instead of losing the day. Guarded by
`SEND_DISABLED`, `iOwnSendLock()`, `schedule_enabled` setting, `paused` setting, and an atomic
`last_auto_run_date` claim (only one process/tick can claim "today"). Daily volume varies ±15%
around `daily_target` so totals aren't an identical flat number every day.

---

## 5. API keys + credits (`server/src/keys.js`)

Central keystore for every paid provider: `apify`, `anymailfinder`, `openrouter`, `elevenlabs`,
`kie`, `telegram`, `fb_page`, `ig_graph` (see `SERVICES` map). Persisted to
`DATA_DIR/api_keys.json`, written `0600`, atomic write-then-rename. **Lazily seeded from
`process.env` on first read only** — this module never reads a `.env` file itself; the server
process's already-loaded env is the source on first boot, then the store wins.

- `getKey(service)` — returns the **active** key (primary, unless flipped to fallback).
- `markFailed(service)` — on a 401/402/403 from a provider, flips to the fallback key (if set) and
  the caller retries once. This pattern is used in `anymailfinder.js`, `scrape.js`. If you add a
  new provider integration, follow the same retry-once-on-auth-failure shape.
- `setKeys(service, {primary, fallback})` — used by `PUT /api/api-keys`; rotates from the OS UI.
- `maskedInfo()` / `mask()` — **full keys never leave this module.** Only last-4 masked strings
  reach the API/UI. Never log a full key, never return one from a new route.
- `fetchCredits(service)` — live remaining-balance lookups per provider (Apify monthly USD usage,
  AnyMailFinder credits_left, OpenRouter key limit, ElevenLabs character quota, KIE credits). Each
  fetcher has its own 5s timeout and **never throws** — returns `{kind:"unknown"}` on any failure
  so one dead provider can't crash the API Keys page. Follow this pattern for any new fetcher.
- `credit_alerts.js` — Telegram alert (6h debounce per service) when Apify or AnyMailFinder run
  out of credit or get rejected; wired at the exact two call sites that would otherwise silently
  stall lead-gen.

---

## 6. The frontend (`app/src/`)

React 18 + Vite 6 + Tailwind 4, dark "mission control" theme, hand-drawn SVG icon set inline in
`App.tsx` (no icon library dependency). Routing via `react-router-dom`; `App.tsx` owns the `NAV`
array (route → label → icon) and renders both a collapsible desktop sidebar and a mobile bottom
bar from that single array — **adding a page means adding one `NAV` entry + one `<Route>`**, both
in `App.tsx`.

**Auth:** `Login` component posts `{password}` to `/api/login`; the returned Bearer token is kept
in `sessionStorage` (not a cookie) via `api.ts: setToken()`/`getToken()`. Every subsequent request
goes through `api.ts: api()` (JSON) or `apiForm()` (multipart uploads) or `apiBlobUrl()` (auth'd
binary fetch → object URL, used for streaming video/audio). A `401` response anywhere clears the
token and hard-redirects to `/`. Server-side, `requireUser` (session token) and `requireWorker`
(separate `WORKER_TOKEN`, used only by the Mac worker) gate every route — see `index.js`.

**Live feed:** `api.ts: openFeed()` opens `/ws?token=<bearer>` with auto-reconnect (exponential
backoff capped at 15s) and is consumed by `Activity.tsx` and `Digest.tsx`.

### Pages (`app/src/pages/`, 18 screens)

| Page | Route | What it does |
|---|---|---|
| `Home.tsx` | `/` | Stats overview + morning run trigger |
| `Activity.tsx` | `/activity` | Live WebSocket feed of every agent action |
| `Crm.tsx` | `/crm` | Full lead table, filters, per-lead detail/edit |
| `HotLeads.tsx` | `/hotleads` | Replied leads — thread view, manual reply, AI ghost-draft (never auto-sends) |
| `Pipeline.tsx` | `/pipeline` | Funnel view: scraped → verified → emailed → replied, AnyMailFinder attrition breakdown |
| `Projects.tsx` | `/projects` | Not yet wired (honest placeholder — reads `brain/HOME.md` eventually) |
| `Automations.tsx` | `/automations` | Run history |
| `Inboxes.tsx` | `/inboxes` | Gmail OAuth connect + SMTP inbox status, test-send |
| `Emails.tsx` | `/emails` | Every email sent/received, searchable |
| `Skills.tsx` | `/skills` | One-click content skills (avatar video, personal video, Live Photo, carousel, motion graphic, video edit, edu post) |
| `ClipEditor.tsx` | `/editor` | Versioned video-edit projects (branching revisions) |
| `ManyChat.tsx` | `/manychat` | IG/FB comment→DM keyword control panel |
| `ContentPosted.tsx` | `/content` | IG/FB post performance metrics |
| `AgentOS.tsx` | `/agentos` | AgentOS skill store / post generation / campaign wiring |
| `ApiKeys.tsx` | `/apikeys` | Key rotation + live credit balances |
| `Jobs.tsx` | `/jobs` | Worker job history/scoreboard, media playback |
| `PostEditor.tsx` | `/post-editor` | Multi-slide post copy revision + re-render |
| `Brain.tsx` | `/brain` | Not yet wired (honest placeholder) |

All pages fetch exclusively via `../api` (`api.ts`) against `/api/*` — there is no other data
path from the browser. `components/Digest.tsx` (login-since digest) and `components/Toast.tsx`
(toast notifications) are shared UI. `format.ts` holds `fmtET()`/`fmtAgo()` timestamp helpers.

---

## 7. HARD RULES for making changes

These are non-negotiable. If a task seems to require breaking one, stop and ask Ted rather than
proceeding.

1. **No button exists unless it actually works.** Never wire a UI control to a stub, mock data, or
   a route that 404s. If something isn't built yet, say so in the UI (see `Brain.tsx`) rather than
   faking it.
2. **Never weaken the send-safety stack**: `SEND_DISABLED`, `test_mode`, the single-owner send
   lock, per-lead dedup (`alreadyEmailedAddress`, `emailContactedElsewhere`), the daily/inbox/
   domain caps, the bounce circuit breaker, or the CAN-SPAM compliance-footer gate. Any new send
   path must go through `pool.js: sendVia()` and respect `engine.js: activeInboxes()`.
3. **Never hardcode a secret or read `.env` directly.** Secrets come from `process.env` (already
   loaded by the server's `--env-file` flags) or from the `keys.js` store. **Never read
   `.env`/`credentials.json`/`token.json`/any file under `server/data/` as part of a coding task**
   — those are gitignored for a reason and a workspace security hook blocks `.env` reads. If a
   task seems to require reading a secret file, it doesn't — use `process.env` or ask the key
   store.
4. **Parameterized SQL only.** Every existing query uses `db.prepare(...).run/get/all(...params)`.
   Never string-concatenate user input into SQL. The one dynamic-table-name query in
   `/api/admin/import-data` uses a fixed table allowlist and DB-derived column names — that
   pattern is fine to imitate, raw interpolation of request-body values is not.
5. **After ANY change, run `./dev.sh`** (from `tedca-os/`) and confirm its **three green ✓ lines**
   (server `:8790`, app, worker) before telling anyone the change is ready. This is a locked
   feedback rule — the stack has died silently mid-session before. If any check fails, read the
   corresponding log (`/tmp/tedca-server.log`, `/tmp/tedca-app.log`, `/tmp/tedca-worker.log`)
   before declaring anything done.
6. **Do NOT restart the stack while a run is actively sending.** Check `GET /api/run/status` /
   the Activity feed / Home page for an active run before running `dev.sh` or deploying — `dev.sh`
   SIGKILLs the server, and a kill mid-send can leave a lead stuck in `status='sending'` (crash
   recovery holds it out of the pool for manual review, but it's better to just not do this).
   Prefer to wait for a natural pause, or confirm with Ted first.
7. **Keep secrets out of git.** `.gitignore`, `.dockerignore`, and `.railwayignore` all exclude
   `server/data/`, `.env`, `*.env` — don't add code that writes secrets anywhere else, and don't
   "fix" the ignore files to include them.
8. **Respect the `SEND_DISABLED` cloud/local split.** Code that runs identically in both places is
   correct; don't add a Railway-only send path or a way around the flag.
9. **Test with `test_mode=1` first**, verify the Activity feed / `emails` table show what you
   expect, before ever touching `test_mode` or `SEND_DISABLED` in a way that could reach a real
   inbox.
10. **Never spend real money without checking first.** Apify/AnyMailFinder/OpenRouter/ElevenLabs
    calls cost money. `MAX_SCRAPES_PER_RUN=2` and the "one Apify run per scrape, many searches"
    pattern are cost guards — don't add a code path that loops API calls per-item when a batched
    call is possible, and flag anything that could meaningfully increase spend before shipping it.

---

## 8. How to run, test, and deploy

### Local dev

```bash
cd "tedca-os"
./dev.sh
```

Idempotent — kills anything on `:8790`, any `server/src/index.js`/`tedca-os/worker`/
`tedca-os/app...vite` process (including "zombie" processes that lost a port race but are still
running send loops — a real incident this guards against), restarts server + app + worker, and
prints three ✓/✗ health lines. Logs: `/tmp/tedca-server.log`, `/tmp/tedca-app.log`,
`/tmp/tedca-worker.log`. Server: `:8790`. App: Vite `:5173` (drifts to `:5175` if busy — `dev.sh`
prints the real one). Worker: polls `BACKEND_URL` — **defaults to whatever `.env` has set, which
may be the cloud URL**; local scrape/skill jobs need `BACKEND_URL=http://localhost:8790`.

### Manual verification after a change

- Watch `/activity` (or tail `/tmp/tedca-server.log`) while exercising the changed flow.
- For anything touching sending: set `test_mode=1` in Settings, trigger the flow, confirm the
  email in `/emails` / your `TEST_RECIPIENT` inbox, and check `leads.status` transitioned as
  expected — **before** ever testing with `test_mode=0`.
- For worker/skill changes: watch `/jobs` for the job to move `queued → claimed → done`, check
  the Telegram delivery if the skill sends one.

### Deploy (cloud)

**Deploy is manual, via the Railway CLI — there is no GitHub auto-deploy.**

```bash
cd "tedca-os"
/Users/yoljean/.npm-global/bin/railway up --service tedca-os   # not on PATH — use the full path
```

- **Never deploy without Ted's explicit go.**
- The cloud instance runs with `SEND_DISABLED=1` — it stays a fully functional, non-sending
  mirror/control-room until Ted explicitly flips that off for a cutover.
- `railway.json` → Dockerfile build, healthcheck `/api/health`, restart on failure (max 5).
- SQLite persists on a Railway **volume** at `/data` — redeploys don't wipe it.
- `deploy-vars.mjs` — one-shot script that copies required env vars from local `.env` files to the
  Railway service (values passed to the CLI, never printed/logged).
- Root `.gitignore` ignores all `package.json`; `tedca-os/.gitignore` explicitly re-includes them
  (`!package.json`, `!**/package.json`) because Railway reads `.gitignore` on upload — **don't
  remove those re-include lines**, builds will fail with "package.json not found."

---

## 9. Known issues / gotchas (read before touching adjacent code)

Pulled from `CODE_REVIEW_2026-07-06.md` and `SECURITY_AUDIT_2026-07-12.md` (both in the repo root
— read them in full before any deep change to sending, auth, or the worker). None of these are
blocking for normal feature work, but if your change touches the same area, be aware:

**Send-safety (Cluster A, code review):**
- The single-owner send lock (`iOwnSendLock()`) is a non-atomic check-then-write across three
  statements — two processes racing on a stale/empty lock can both "win." `sendFromQueue()` also
  only checks the lock once at the start of a run, not on every iteration.
- Initial sends have no atomic per-lead claim before sending (follow-ups do). Two producers could
  theoretically both enqueue and send the same lead.
- `db.js` never sets `PRAGMA busy_timeout` — a concurrent-write `SQLITE_BUSY` after a successful
  send (mail already left) can leave the lead un-recorded and get it re-sent next run.

**Auth / attack surface (Cluster B, code review + security audit):**
- `/api/login` has **no rate-limiting, lockout, or backoff** — the one shared `OS_PASSWORD` is
  brute-forceable at full request speed. This is the #1 finding in the security audit.
- The 64MB JSON body limit (`express.json({limit:"64mb"})`) applies globally, including to
  unauthenticated `/api/login` — a pre-auth memory-exhaustion amplifier.
- No `helmet`/security headers (`HSTS`, `X-Content-Type-Options`, `X-Frame-Options`/CSP) —
  clickjacking + MIME-sniffing exposure, `X-Powered-By: Express` fingerprints the stack.
- Session tokens never expire, aren't rotated, and are passed as URL query params on `/ws` and
  `/api/skills/file` (leak into logs/Referer).
- The worker runs headless Claude Code with `--permission-mode bypassPermissions` on prompts built
  from job params that ultimately originate from authenticated UI input (`topic`, `notes`,
  `folder`) — a prompt-injection past the login gate could reach shell execution on Ted's Mac.
  Don't extend this pattern to new job types without deliberately thinking about it.
- `/api/agentos/upload-video` doesn't sanitize `file.originalname` before joining it into a
  filesystem path (path-traversal write) — the sibling `_editStorage` uploader **does** sanitize
  correctly; if you touch either uploader, use the sanitized pattern.

**Deliverability / correctness (P2, code review):**
- The auto-reply path (`replies.js`) doesn't check `paused_inboxes` before replying from the
  receiving inbox — it can reactivate a bounce-guard-paused inbox on an incoming reply.
- `/api/gmail/test-send` sends from every configured inbox (including paused ones) and its sends
  don't count against caps.
- Follow-ups go out as "Re:" with no `In-Reply-To`/`References` header (unthreaded — a spam
  signal); the initial send's transport message-id isn't currently persisted to enable this.
- `PUT /api/settings` does no validation — any value other than the exact string `"1"` for
  `test_mode` is treated as "not live," but a boolean `true`/`false` sent by mistake could
  silently do the wrong thing. Be careful with settings writes from new UI.

**Doc drift you'll notice:** the root `README.md` describes the DB as Postgres — it's actually
SQLite (`node:sqlite`, see `server/src/db.js`). Trust the code, not that README line, if they
disagree. `docs/architecture.md`, `docs/email-engine.md`, `docs/deploy-and-ops.md` are generally
more current; skim them too if you need more depth than this guide provides.

---

## 10. Safe change checklist

**Before starting:**
- [ ] Read the relevant section of this guide + the specific source file(s) end to end — don't
      pattern-match from a fragment.
- [ ] Check `GET /api/run/status` / the Activity feed for an active run before restarting anything.
- [ ] If touching sending, dedup, caps, or the send lock, re-read §4 and the matching
      `CODE_REVIEW_2026-07-06.md` finding — know what's already a known gap vs. what you'd be
      introducing new.
- [ ] Confirm `test_mode` is `1` if you're about to exercise any send path.

**While changing:**
- [ ] Use parameterized SQL (`db.prepare(...).run(...)`) — no string interpolation into queries.
- [ ] Any new send path routes through `pool.js: sendVia()` and `engine.js: activeInboxes()`.
- [ ] Any new paid-API call reuses `keys.js: getKey()`/`markFailed()` and stays inside the $0.50
      ask-first / batch-not-loop cost discipline.
- [ ] No secret ever gets hardcoded, logged, or returned from an API route in full (mask like
      `keys.js: mask()` does).
- [ ] New DB columns are additive `ALTER TABLE ... ADD COLUMN` wrapped in try/catch, matching
      `db.js`'s existing pattern — never a destructive migration.
- [ ] New frontend pages get one `NAV` entry + one `<Route>` in `App.tsx`, and only call the
      backend through `app/src/api.ts`.
- [ ] New UI controls are wired to something real before they ship (Rule #1, §7) — no stubs.

**After changing:**
- [ ] Run `./dev.sh` from `tedca-os/` and get all three ✓ lines. Read the logs on any ✗.
- [ ] Exercise the changed flow with `test_mode=1` (or against the Jobs/Activity feed for
      non-sending changes) and confirm the expected DB/UI state.
- [ ] Re-read your diff for anything that touches `SEND_DISABLED`, `test_mode`, caps, dedup, or
      secrets handling — these deserve a second look every time regardless of what you were asked
      to change.
- [ ] Do not deploy to Railway (`railway up`) without Ted's explicit go-ahead, even after local
      verification passes.
- [ ] If you noticed a known issue from §9 get worse, or found a new one, say so explicitly rather
      than silently fixing (or silently leaving) it — safety-relevant findings should be
      surfaced, not folded quietly into an unrelated diff.
