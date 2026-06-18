# The Cold-Email Engine

How the machine works, exactly as coded in `server/src/engine.js`, `gmail.js`, `anymailfinder.js`, `replies.js`. The visual PRD of this page is `tedca-os/email-prd.html` (serve with `python3 -m http.server 4319`). ([README](./README.md) · [architecture](./architecture.md))

## The morning run (`POST /api/run/morning` → `startMorningRun`)

Input: `target` (1–500, default 10 from the UI) and an optional `query`. The Home page composes the query as `"<niche> in <city1> | <niche> in <city2> | …"` — **multiple `|`-separated searches still equal ONE Apify run** (`execution/scrape_google_maps.py` handles multi-search). Defaults from settings: niche `med spa`, city `Bergen County NJ`.

The run is a **concurrent producer/consumer** — sending starts the moment the first verified lead exists:

1. **Producer (Harvester + Inspector):**
   - Pulls unworked leads (`status='scraped'`, not yet screened) — **bank first** (`ORDER BY banked DESC`).
   - Verifies each via AnyMailFinder: decision-maker ("CEO") search → if none indexed (typical for local spas), **falls back to any validated email at the domain**, preferring personal-looking addresses over `info@`/`contact@`-style generics. **Only `valid`/`verified` results pass; risky/unknown leads are marked and never re-checked.** A 402 (out of credits) stops verification gracefully.
   - If supply runs short: scrape more, **max 2 Apify runs per morning run** (`MAX_SCRAPES_PER_RUN = 2`), over-fetching **3× the deficit** because verification kills a chunk. Scrapes execute on the Mac via the `jobs` queue (worker must be running and pointed at this backend; 10-min server timeout).
2. **Consumer (Courier):** drains the verified queue while the producer fills it — see sending safety below.
3. **Wrap-up:** un-emailed leads are **banked** (`banked=1`) as tomorrow's free inventory; run summary saved; **Telegram report sent** (verified working).

A failed run never crashes the process — errors land in the run summary and the activity feed. (The spec's "self-healing retry via OpenRouter diagnosis" is **not built**.)

## Sending safety (the rules in code)

- **Verified emails only** — a lead without a validated address is never sent to. Bounces are what get inboxes flagged.
- **Per-inbox daily caps** — `per_inbox_cap` setting, default **20**; counted from the `emails` table per day; rotation picks the next inbox under cap; all capped → sending pauses until tomorrow.
- **Random 9–14s jitter** between sends.
- **Business hours only** — Mon–Fri 9:00–17:00 server-local (`withinSendWindow`); applies to follow-ups and the scheduler.
- **Exactly one follow-up** per lead, scheduled `+followup_days` (default 3) at send time; a minute-loop sends due follow-ups inside the window. Any reply nulls `followup_due_at` instantly.
- **Test mode** (`test_mode=1`, currently **ON**): every send diverts to `TEST_RECIPIENT`, with the real lead address embedded in the subject as `[TEST → lead@x]` — which the reply-matcher parses, so the full reply loop is testable against your own Gmail. Live mode is an explicit settings flip.
- **9am weekday scheduler** — built (`schedule_enabled`, `schedule_hour`, once-per-day guard via `last_auto_run_date`), currently **OFF**.

## Email copy

Templates live in the **settings table** (`email_subject`, `email_body`, `followup_body`) and are editable in the **Inboxes page UI** (merge fields: `{business_name} {first_name} {category} {rating} {review_count}`). The user's locked copy framework (memory `cold_email_copy_framework`): lowercase, <80 words, cold-read opener, loss aversion, video CTA, **no em dashes**. Note: the seed defaults in `db.js` are placeholders — the real copy is whatever is currently saved in the cloud DB's settings.

## Gmail integration

- Per-inbox OAuth **loopback flow** (Desktop OAuth client, Google Cloud project "My First Project", app in External/testing mode with the 5 addresses as **test users**). Connect buttons on the Inboxes page open the consent URL; a temporary localhost server catches the callback. The flow validates you signed into the *expected* address.
- Scopes: `gmail.send`, `gmail.readonly`, `gmail.modify`. Refresh tokens in `DATA_DIR/gmail_tokens.json` — re-uploadable to the cloud via `upload-tokens.mjs`.
- **5 inboxes, all OAuth'd and cloud-verified:** daniel, james, kevin, michael, joseph **@tedcas.org** (domain has an extra "s" — not tedca.org).
- Subjects are RFC-2047 encoded; replies are threaded via `In-Reply-To`/`References`.

## Reply handling (`replies.js`, Concierge — 24/7)

Polls every authorized inbox **every 2 minutes** (`in:inbox newer_than:3d`, deduped via `seen_messages`). For each new message from a known lead (matched by sender email OR the `[TEST → …]` subject tag):

1. Records the reply, sets lead `status='replied'`, **kills the follow-up instantly**.
2. Classifies via OpenRouter **`anthropic/claude-haiku-4-5`** → one of `interested | neutral | negative | unsubscribe` (classification failure → Telegram flag, no auto-reply).
3. Branches:
   - **interested / neutral** → drafts a short lowercase reply via **`anthropic/claude-sonnet-4.5`** answering their question + pointing to `https://tedca-patient-engine.vercel.app`, sends in-thread, Telegrams the user.
   - **negative** → **no reply sent**; Telegram flag with the text; human decides.
   - **unsubscribe** → `status='do_not_contact'` forever, no reply, Telegram notice. No exceptions.

## Verified vs. not (the honest board)

| Piece | State | Proof |
|---|---|---|
| 5 inboxes OAuth'd, tokens in cloud | ✅ verified | cloud test-sends ✓ from all 5 (`cloud-test.mjs`) |
| Scrape (multi-city, one run, dedupe) | ✅ verified | 33 real med spas in the CRM |
| Lead bank + reuse-before-scrape | ✅ verified | 33 banked; a retry run used $0 scraping |
| Data migration local → cloud | ✅ verified | 33 leads + email history imported (`migrate-data.mjs`) |
| Telegram notifications | ✅ verified | test message received |
| Verify (CEO → company fallback) | ⚠️ built, fallback API-tested | **needs one full run** |
| Send engine (caps/rotation/jitter/follow-up) | ⚠️ built | **needs the same full run to witness** |
| Reply 3-branch handling | ⚠️ built | **needs a real reply round-trip in test mode** |
| 9am scheduler | ⚠️ built, **OFF** | flips on by user's word |
| Blocking Telegram approvals (HITL) | ❌ not built | next on M8 |
| Self-healing retry loop | ❌ not built | spec §8, never implemented |
| Live mode | ❌ off by design | after a witnessed test run |
| Obsidian daily summary mirror | ❌ not built | promised in spec §7 |
