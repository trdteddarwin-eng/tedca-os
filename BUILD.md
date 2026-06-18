# Tedca OS — Build Spec (V1)

> **You are the build agent.** Read this whole file before writing code, then build **V1** described below.
> A visual companion to this spec lives at `tedca-os/index.html` (serve it with
> `python3 -m http.server 4317` inside `tedca-os/` and open http://localhost:4317).
> Follow the workspace `CLAUDE.md` (3-layer architecture, $0.50 cost guardrails, secrets in `.env`,
> security hooks, OpenRouter not the Anthropic SDK). **Local-first: build and run it locally, prove every
> button works, and do NOT deploy to Railway until the user explicitly says so.**

---

## 0. How to use this file (build agent instructions)

1. **Inventory first.** Before building, list what already exists in the workspace and reuse it:
   `ls execution/ directives/ brain/` — there are existing Python scrapers, an AnyMailFinder flow,
   a lead-gen pipeline, and Obsidian notes. Reuse `execution/*.py` via the Node backend rather than
   rewriting scrapers. Read `brain/HOME.md` and any med-spa / ICP notes.
2. **Ask the user for every `[YOU PROVIDE]` item** (see §11) at the moment you need it — never invent
   keys or guess the inbox addresses. Secrets go in `tedca-os/.env`, never printed to the browser or chat.
3. **Build in the milestone order in §10.** Each milestone must END in something that actually works and
   is verified (curl the endpoint, run the agent, screenshot the UI). 
4. **The hard rule (the user's acceptance test):** _no button exists unless it actually works._ Do not ship
   mock buttons, fake data, or dead links. A button that doesn't do real work = V1 failed.
5. When a step needs a decision or spends money, **pause and ask via Telegram** (see §8).

---

## 1. North star

A private, password-gated **mission-control web app** to run Tedca. The user opens it each morning,
clicks one button, and a cold-email machine runs end to end: pull target + ICP from Obsidian → reuse the
lead bank or do ONE scrape → find + verify the CEO email → save everything → send across his inboxes with
safety → one follow-up → handle replies. He watches it live; it Telegrams him when it needs him. It runs in
the cloud so it's alive on his phone even when his Mac is off.

**Scope of THIS build = V1 only:** the OS shell + the Cold-Email Engine + CRM + reply handling + live
activity feed + Telegram human-in-the-loop + cost tracking. Content Engine is V2 (see §13) — **do not build it now.**

---

## 2. Architecture

```
 Phone + Laptop ──► TEDCA OS  (Railway: web app + Postgres + live WebSocket feed)
                      │                              │
             CLOUD agents (24/7)              LOCAL worker (user's Mac)
             • send + read replies            • Apify scrape (reuses execution/*.py)
             • follow-ups                      • Obsidian read/write (brain/)
             • Telegram HITL gate              • streams activity to the same cloud DB
                      └──────────────┬───────────────┘
   Gmail API · Apify · AnyMailFinder · OpenRouter · Telegram · Obsidian · (warmup tool, external)
```

- **One cloud brain** (Railway) hosts the dashboard, Postgres, the WebSocket feed, and the always-on agents
  (sending, reply-reading, follow-ups).
- **A local worker** on the user's Mac handles anything needing the filesystem / Python / Obsidian (the
  Apify scrape, brain/ reads & writes). It connects to the same backend and **streams its activity events to
  the same DB**, so the phone shows local + cloud work in one unified live feed.
- **Dev vs prod:** develop locally first (local Postgres or SQLite). Deploy to Railway only on the user's go.

---

## 3. Tech stack

- **Frontend:** React + Vite + Tailwind (match the user's existing site stack). Dark "mission-control" theme.
- **Backend:** Node (Express or Fastify). Runs agents, shells out to existing Python `execution/` scripts,
  serves a **WebSocket** (or SSE) live activity feed.
- **DB:** Postgres on Railway in prod; local Postgres or SQLite in dev. One schema (see §7).
- **Local worker:** a small Node (or Python) process the user starts on his Mac; authenticates to the
  backend and posts activity/runs to the same DB.
- **Auth:** single-user password gate (one passcode in env). Secrets server-side only, never shipped to the browser.

---

## 4. Brand & look

Match the new Tedca brand (see `tedca-os/index.html` for the exact system):
- **Display serif:** Instrument Serif (headlines, italic red accents).
- **UI/body:** Inter. **Data/labels:** Space Mono.
- **Colors:** signal red `#E63B2E`, ink `#111`, paper `#E8E4DD`. **Dark mission-control** aesthetic for the app.
- Fully phone-responsive. Self-host fonts (woff2) — no third-party font CDN.

---

## 5. The Cold-Email Engine (V1 core)

One **"Run morning cold email"** button kicks off the pipeline, streamed live step by step:

| # | Step | What it does | Tool |
|---|------|--------------|------|
| 1 | **Target + Brief** | Ask the user how many leads he wants (or use default). Pull the ICP + winning angle from Obsidian (`brain/`). | Obsidian + OpenRouter |
| 2 | **Bank or Scrape** | Reuse yesterday's un-emailed **lead bank** FIRST. Only if the bank is low, do **ONE** Apify run (never N — cost rule). One search returns many businesses + domains. | Apify (`execution/*.py`) |
| 3 | **Find CEO + Verify** | Run leads through AnyMailFinder to find the **exact CEO** email **and verify** it. Keep **valid only**; **skip risky/catch-all/unknown**. | AnyMailFinder |
| 4 | **Save + Report** | Save every lead + field to Postgres **and** mirror a summary to Obsidian. Stop at the target count. Telegram the user a report. | Postgres + Obsidian + Telegram |
| 5 | **Send + Bank Rest** | Send to **verified only**, ~100/day to start, rotating inboxes with safety. Schedule exactly **ONE** follow-up. Save un-emailed leftovers as the **bank** for tomorrow. | Gmail API |

### Cost discipline (hard rules)
- **ONE Apify run per scrape**, never multiple calls. One search → many leads + domains.
- **Reuse the lead bank before scraping new.** Only scrape when the bank can't fill today's send.
- **Verification is FREE via AnyMailFinder** — treat its "valid" status as the verification. Send valid only.
- **NO paid enrichment.** Personalize from the data the Apify scrape already returned (business name,
  category, rating, review count, website). Use merge fields + at most one tiny LLM line for top prospects.
  Be fast, cheap, low-token.

### Sending safety (don't get flagged by Google)
- Per-inbox daily caps (~20–30, ramping up over time), **rotate across all inboxes**, randomized send windows
  + jitter (e.g. 9–14s gaps), **auto-pause** any inbox whose bounces/spam rise.
- **Built inbox-count-agnostic** — the user will add more inboxes; spread volume thinner as inboxes are added.
- Start ~100/day total across inboxes, ramp slowly. **Send only to verified emails** (bounces are what get
  inboxes flagged).
- An **external warmup tool** keeps inboxes healthy (the user runs it separately; just keep inboxes connected).

---

## 6. Reply handling (cloud, 24/7, free via Gmail API)

Poll the inboxes via Gmail API for replies. **Any reply stops all follow-ups to that lead.** Then classify
with OpenRouter and branch:

- **Interested / neutral / hesitant** → agent emails a short tailored message + the user's AI-services link
  `https://tedca-patient-engine.vercel.app` ("a system already built for you"). Mark **Replied**, **Telegram the user.**
- **Negative (not unsubscribe)** → **flag + Telegram the user**, send **no** link, stop follow-ups. Human decides.
- **Unsubscribe / "stop emailing me"** → **HARD stop**: mark **Do-Not-Contact**, suppress forever, never email
  again. No reply, no link, no follow-up. No exceptions.

(The personalized message is reply-only — do NOT generate per-lead pages on the scrape side.)

---

## 7. Data model (Postgres)

Minimum tables (extend as needed):
- **leads** — id, business_name, domain, category, rating, review_count, website, ceo_name, email,
  email_status (valid/risky/unknown), source, scraped_at, status (`scraped|emailed|followup_sent|replied|
  do_not_contact`), inbox_used, last_touch_at, banked (bool).
- **runs** — id, agent, started_at, finished_at, status (`running|paused|done|failed`), cost_usd, summary.
- **activity_events** — id, run_id, ts, actor (research/scrape/send/system), message, level. (Drives the live feed.)
- **emails** — id, lead_id, inbox, direction (out/in), subject, body, kind (initial/followup/reply), sent_at.
- **costs** — id, run_id, provider, amount_usd, ts. (Per-run + monthly total on Home.)
- **settings** — niche, daily_target, per_inbox_cap, inboxes[], paused (bool).
- **clients** — scaffold for CRM (none yet): name, source, status, deal_value, last_contact, notes.

Mirror a human-readable daily summary into Obsidian (`brain/`) so the vault stays the readable source of truth.

---

## 8. Human-in-the-loop · self-healing · cost

- **Blocking Telegram HITL:** when an agent needs a decision (or is about to spend >$0.50), it Telegrams the
  user and **pauses the run (status `paused`), polling Telegram until he replies**, then resumes from where it
  stopped. Nothing irreversible happens without his reply.
- **Self-healing:** on any failure → capture the exact error → ask OpenRouter to diagnose → **retry with a fix**
  (cap N attempts) → if still failing, stop, Telegram the reason, and append to workspace `error-log.md`.
  No silent failures.
- **Cost tracking:** log every paid API/LLM call to `costs` → show per-run cost + a running **monthly total**
  on Home. Respect the $0.50 guardrail (Apify capped, ask before exceeding).

---

## 9. Ops modules (dashboard)

- **Home / KPIs** — leads, emails sent, replies, **cost this month**, what's running now (live).
- **Clients / CRM** — auto-populated from scrapes; live status `Scraped → Emailed → Follow-up → Replied`.
- **Pipeline** — every lead's stage through to Call → Closed.
- **Projects** — reads & writes `brain/HOME.md`.
- **Automation status** — each agent: on/off, last run, result, cost.
- **Second Brain** — Obsidian `brain/` browsing; edits write back **with a confirm step** (per CLAUDE.md rule).
- **Live Activity** — the unified WebSocket feed (local + cloud), clean step lines + expandable raw log,
  plus a **Runs history** (status, output, duration, cost).

---

## 10. Build order (each milestone must actually work)

1. **Shell** — Vite+React+Tailwind app, dark theme, password gate, nav, empty modules. Runs locally.
2. **Backend + DB + live feed** — Node server, Postgres schema (§7), WebSocket activity feed. A test event
   appears live in the UI.
3. **Local worker** — starts on the Mac, connects, posts an activity event that shows up in the cloud feed.
4. **Scrape step (real)** — wire the "Run" button → local worker runs ONE Apify scrape (reuse `execution/*.py`)
   → leads land in `leads` + the live feed shows it. Lead bank logic: reuse before scrape.
5. **Find + verify (real)** — AnyMailFinder finds CEO + verifies; valid-only saved; risky skipped.
6. **Send (real)** — Gmail API send across inboxes with caps/rotation/jitter; one follow-up scheduler;
   leftovers banked. Send to a test address first, then go live on the user's go.
7. **Reply handling (real)** — Gmail API reply polling + classify + 3 branches + Telegram + suppression list.
8. **HITL + self-healing + cost** — blocking Telegram approvals, retry/diagnose loop, cost logging + monthly total.
9. **CRM / Pipeline / Projects / Brain** modules reading real data.
10. **Deploy to Railway** — only after the user approves. Postgres on Railway; cloud agents 24/7; local worker
    stays on his Mac for scrape/Obsidian.

---

## 11. `[YOU PROVIDE]` — ask the user for these (never invent)

Put all secrets in `tedca-os/.env` (gitignored). Ask the user; do not print them to chat/browser.

```
# Gmail (THE critical path — send + read replies)
GMAIL_OAUTH_CLIENT_ID=        # [YOU PROVIDE] Google Cloud OAuth client
GMAIL_OAUTH_CLIENT_SECRET=    # [YOU PROVIDE]
INBOXES=                      # [YOU PROVIDE] the 5 addresses (confirm: Google Workspace?)
# Lead pipeline
APIFY_TOKEN=                  # [YOU PROVIDE] (note: free tier = 1 run/day — OK w/ lead-bank reuse?)
ANYMAILFINDER_API_KEY=        # [YOU PROVIDE]
OPENROUTER_API_KEY=           # exists in workspace .env — confirm reuse
# Notify + control
TELEGRAM_BOT_TOKEN=           # [YOU PROVIDE or reuse existing bot]
TELEGRAM_CHAT_ID=             # [YOU PROVIDE]
# App
OS_PASSWORD=                  # [YOU PROVIDE] login passcode
DATABASE_URL=                 # local in dev; Railway Postgres in prod
PATIENT_ENGINE_URL=https://tedca-patient-engine.vercel.app   # confirm
```

**Also ask the user (content / settings):**
- **Med-spa ICP** — point to a `brain/` note, or have the agent draft one (who, their pain, the offer/angle).
- **Cold email copy** — initial + ONE follow-up (user writes, or approves agent-drafted "missed-call-recovery").
- **Reply message** copy (what's said when sending the patient-engine link).
- **Volume** — starting per-inbox cap + daily total (~20/inbox → ~100/day?) and the per-run **lead target**
  (ask each morning, or default 100).
- **Warmup tool** — which one he uses.
- Confirms: OK to run a local worker on the Mac · Obsidian vault = workspace `brain/` · the patient-engine link.

---

## 12. Guardrails (from workspace CLAUDE.md)

- Ask the user before any action that may cost **>$0.50**. Apify capped at $0.50/run, one run.
- Secrets only in `.env` / Railway env. Never hardcode keys; never print them; never paste in chat.
- `except Exception:` not bare `except:` in Python. `os.getenv("KEY","")` with no real defaults.
- Clean `.tmp/` for intermediates. Deliverables to the app/DB.
- **Local-first: do not deploy to Railway until the user says "deploy."**

---

## 13. V2 — Content Engine (DO NOT BUILD YET — context only)

"One piece of content, posted everywhere." The agent doesn't INVENT talking-head video — it edits avatar
clips the user generates.
- **Tedca agency** (IG · FB · TikTok · LinkedIn): avatar pipeline = 11Labs VO → HeyGen woman avatar →
  Claude Code edit in Tedca style (`directives/tedca_video_edit.md` + `directives/tedca_mg_edit_and_livephoto.md`)
  → agent adds a CTA at the end → post to IG + FB. Promotes Claude skills/Code. Audience = people who SELL
  (coaches, course/community owners, promoters). Comment→DM runs through **ManyChat** (keyword → auto-DM,
  already set up externally). LinkedIn ("how AI helps your business") + a website = LATER.
- **Personal brand** (TikTok only): Live Photo series "Claude Code things you didn't know it could do"
  (caption 1 + caption 2) via the `tiktok-livephoto` directive + Claude Code tips (agent finds topics).
  **Delivery:** agent renders the Live Photo **locally on the Mac**, drops it in Photos, and **Telegrams the
  user it's ready** with the captions — the user **AirDrops to his phone and posts manually** (no iCloud,
  TikTok has no Live-Photo upload API).

---

## 14. Acceptance criteria (how the user judges V1)

- Click **Run morning cold email** → it really scrapes (or reuses the bank), finds + verifies CEOs, saves to
  CRM, and sends real email across inboxes — visible live, step by step.
- A real reply gets classified and handled (link / flag / hard-stop) and Telegrams the user.
- The agent pauses for Telegram approval before spending and resumes on reply.
- Home shows real KPIs + a real monthly cost total.
- **Every clickable thing does real work.** Nothing is a mock.
