# Architecture

Three processes, one database, one live feed. ([README](./README.md) · [email engine](./email-engine.md) · [ops](./deploy-and-ops.md))

```
 Phone / Laptop ──► Railway cloud (24/7)                Your Mac (only when on)
                     one Docker container                worker/index.js
                     ├ Express API + WebSocket /ws       ├ polls /api/worker/jobs/claim every 3s
                     ├ built React app (static)          ├ runs Python from execution/ via .venv-leadgen
                     ├ engine + reply poller + loops     └ posts activity back to the same feed
                     └ SQLite on /data volume
```

## The three pieces

### 1. `server/` — Node + Express (port 8790 locally; Railway sets PORT)
- **`src/index.js`** — everything boots here: API routes, WebSocket feed, static frontend serving, and starts three background loops (`startFollowupLoop`, `startScheduler`, `startReplyLoop`). Refuses to start without `OS_PASSWORD` and `WORKER_TOKEN`.
- **`src/db.js`** — `node:sqlite` (`DatabaseSync`), WAL mode. DB file at `DATA_DIR/tedca-os.db` (local: `server/data/`, cloud: `/data` volume). Schema + seed defaults live here. **Do not use better-sqlite3 — it won't compile on Node 24.**
- **`src/engine.js`** — the morning cold-email run (see [email-engine.md](./email-engine.md)).
- **`src/gmail.js`** — per-inbox OAuth (loopback flow on a random localhost port), token store at `DATA_DIR/gmail_tokens.json` (mode 0600, never sent to browser), send (RFC-2047 subjects, In-Reply-To threading), read (message list + plain-text body extraction).
- **`src/replies.js`** — 24/7 reply poller + classifier + 3-branch handler.
- **`src/anymailfinder.js`** — CEO decision-maker search with company-email fallback; only `valid`/`verified` results count.
- **`src/telegram.js`** — one-way `sendMessage` notifications. **Blocking HITL approvals are not built yet.**
- **`src/skills.js`** — One-Click content skills: LLM script/topic generation + job queueing (see [one-click-skills.md](./one-click-skills.md)).
- No ORM, no framework beyond Express + `ws`. Dependencies: literally `express` and `ws`.

### 2. `app/` — React + Vite + Tailwind v4 (dev port 5173, sometimes drifts to 5175)
Dark mission-control theme: Instrument Serif display, Inter body, Space Mono data, signal red `#E63B2E`, ink `#111`, paper `#E8E4DD`. `src/api.ts` holds the fetch wrapper (session token in `sessionStorage`) and the auto-reconnecting WebSocket feed (`openFeed`).

Pages (`src/pages/`) — honest status:

| Page | Route | Status |
|---|---|---|
| Home | `/` | **Real.** Pixel office, run panel (niche dropdown + multi-city locations + lead target), KPIs from `/api/stats`, running-now, test-event button |
| Live Activity | `/activity` | **Real.** WebSocket feed of `activity_events` |
| Clients / CRM | `/crm` | **Real.** Leads table with status badges |
| Pipeline | `/pipeline` | **Real.** Leads by stage (scraped → emailed → follow-up → replied) |
| Automations | `/automations` | **Real.** Run history table |
| Inboxes | `/inboxes` | **Real.** Per-inbox Connect (OAuth), test-send button, **email copy editor** (subject / first email / follow-up, saved to settings) |
| Emails | `/emails` | **Real.** Every email in/out with lead context |
| One-Click Run | `/skills` | **Real.** Three skill cards with job polling |
| Projects | `/projects` | **Placeholder** — text only, deliberately no mock data (M9) |
| Second Brain | `/brain` | **Placeholder** — same (M9, needs local worker Obsidian access) |

### 3. `worker/` — local Mac job runner (`worker/index.js`)
Authenticates with `WORKER_TOKEN`, polls `BACKEND_URL` for queued jobs every 3s, heartbeats every 60s. Executes jobs by shelling out to workspace Python (`.venv-leadgen/bin/python execution/<script>.py`):

| Job type | Script | Timeout |
|---|---|---|
| `scrape` | `execution/scrape_google_maps.py --search "..." --limit N --json` | 9 min (server gives up at 10) |
| `tts` | `execution/gen_avatar_vo.py` | 9 min |
| `livephoto` | `execution/run_livephoto.py --topic --outdir` | 30 min |
| `carousel` | `execution/run_tedca_carousel.py --topic --outdir` | 15 min |

**Important:** `BACKEND_URL` in `tedca-os/.env` currently points at the **cloud**, so the worker serves the production job queue. If you need the *local* server's engine to scrape, flip `BACKEND_URL` back to `http://localhost:8790` (and back again after).

## Database (SQLite, one file)

Tables (see `server/src/db.js` for exact columns): `leads` (business, domain, email, email_status, status `scraped|emailed|followup_sent|replied|do_not_contact`, banked, followup_due_at), `runs`, `activity_events` (drives the feed), `emails` (every send/reply, full text), `costs`, `settings` (key/value: niche, city, daily_target, per_inbox_cap, test_mode, schedule_enabled, schedule_hour, paused, email copy templates, livephoto_topics_done), `jobs` (the worker queue), `clients` (CRM scaffold, unused), `seen_messages` (reply dedup, created in replies.js).

The spec called for Postgres; the deploy uses **SQLite via `node:sqlite` on a Railway volume** instead — zero-dep, survives redeploys, and avoids the better-sqlite3/Node-24 compile problem. Postgres remains a possible later migration.

## Auth

- **User:** `POST /api/login` with `OS_PASSWORD` → random in-memory session token (lost on server restart — users just log in again). All `/api/*` reads require it.
- **Worker:** static `WORKER_TOKEN` bearer on `/api/activity` (POST) and `/api/worker/*`.
- **WebSocket:** `/ws?token=` accepts either a session token or the worker token.

## The pixel office (Home)

`app/src/office.ts` + `components/Office.tsx` / `OfficeRoom.tsx`. Seven named agents map 1:1 to `activity_events.actor` values and wake/sleep from real event recency (working <2 min, online <10 min, else idle; error events show "Needs attention"):

| Agent | actor key | Job |
|---|---|---|
| Scout | `research` | Reads ICP, sets the brief |
| Harvester | `scrape` | Lead bank first, then one Apify run |
| Inspector | `verify` | AnyMailFinder find + verify, valid only |
| Courier | `send` | Sends with caps/rotation/jitter, banks leftovers |
| Concierge | `reply` | 24/7 reply handling |
| Mac Worker | `worker` | Local jobs + heartbeat |
| Dispatch | `system` | Runs, costs, Telegram |

Hovering an agent shows a dossier: about / what it did (last 3 real events) / next step. All copy is plain-words by design.

## Cost tracking (partial — be honest)

The `costs` table and the Home KPI exist, but **only the skills' OpenRouter calls log costs** (`skills.js` `llm()`). Reply classification/drafting, Apify, and AnyMailFinder spends are **not** logged yet. The $0.50 guardrail is enforced structurally (max 2 scrapes/run, free-tier Apify) rather than via tracked spend.
