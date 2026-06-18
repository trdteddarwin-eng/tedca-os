# Decisions & Ideas

Locked decisions (not derivable from code), the business context, and ideas discussed but not built. ([README](./README.md) · [next steps](./next-steps.md))

## Business context

Tedca = the user's AI agency. Current niche: **med spas** (configurable — the Home page has a niche dropdown). Offer: **missed-call text-back** — "when someone calls and no one picks up, we text them back in 60 seconds and book them." The cold email's goal is a *reply*; interested replies get pointed at the pre-built demo: https://tedca-patient-engine.vercel.app. Lead model overall: content → comment → close (see memory `tedca_outbound_state`).

## Locked decisions

- **Gmail API directly, NOT Instantly.** Avoids Instantly's $96/mo reply tier — reply-reading is free via the Gmail API. Pay only for warmup (external). Built inbox-count-agnostic: scale by adding inboxes, not volume per inbox.
- **Verify, don't enrich.** AnyMailFinder's "valid" status IS the verification (free with the find). No paid enrichment — personalization comes from data the scrape already returned (name, category, rating, reviews). Bounces are what get inboxes flagged, so valid-only is the #1 safety rule.
- **Bank first, scrape last.** Yesterday's un-emailed leads are free inventory. Max 2 Apify runs per morning run; the Apify token is **free-tier (1 run/day)** so the engine over-fetches 3× and banks aggressively.
- **SQLite, not Postgres** (deviation from BUILD.md): `node:sqlite` on a Railway volume. Reasons: better-sqlite3 won't compile on Node 24, zero deps, one file the user owns. Postgres is a possible future migration, not a current need.
- **Single container serves API + frontend** — one URL, no CORS, no separate static host.
- **Test mode until explicitly flipped.** Every send diverts to TEST_RECIPIENT with `[TEST → lead@x]` in the subject so even the reply loop is testable safely.
- **Email copy framework** (locked, memory `cold_email_copy_framework`): lowercase, <80 words, cold-read opener, loss aversion, video CTA, no em dashes. Editable live in the Inboxes UI.
- **Plain-words feed.** Activity messages read like a person ("Found the owner — confirmed real"), never like logs.

## Zapmail plan (purchase incoming — onboarding runbook)

The user is buying **12 pre-warmed Google mailboxes on 4 rented domains** from Zapmail: **$149 first payment, then $84/mo**, full Workspace credentials promised. When they arrive:

1. Add the 12 addresses to `INBOXES` in `.env` (and Railway vars via `deploy-vars.mjs`).
2. Add each as an **OAuth test user** on the Google Cloud OAuth client (app is in testing mode).
3. **Connect** each on the Inboxes page (per-inbox OAuth).
4. **Cap them at 10/day for week one** (pre-warmed ≠ warm forever), then ramp toward the default 20.
5. **Warmup must run permanently** — ask Zapmail if warmup is included ongoing; otherwise wire Mailreach or Warmy on every inbox in the pool.
6. Target: **~120 sends/day across 17 inboxes** (5 tedcas.org + 12 Zapmail).

**Rented vs. owned:** the Zapmail inboxes and their 4 domains are **disposable rented capacity** — reputation dies with the subscription. The asset is the **CRM database** (leads, conversations, full email history in `tedca-os.db`) and the relationships that land in the user's real inboxes. Never let anything irreplaceable live only on rented infra.

## The pixel office & agent roster

A deliberate product decision: the Home page is a pixel-art "office" where seven named agents visibly work, doze, and err — driven by real `activity_events` only, never animation theater. Roster: **Scout** (research) · **Harvester** (scrape) · **Inspector** (verify) · **Courier** (send) · **Concierge** (replies) · **Mac Worker** (local hands) · **Dispatch** (system). Hover = dossier (about / what it did / next step) in plain words. Keep new actors mapped to this roster or extend `app/src/office.ts` deliberately.

## Ideas discussed, not built

- **Blocking Telegram HITL approvals** — agent Telegrams a question, freezes the run (`status='paused'`), polls for the user's reply, resumes. Spec'd in BUILD.md §8; the current `telegram.js` is one-way only. Highest-value missing safety piece.
- **Self-healing loop** — on failure: capture error → OpenRouter diagnoses → retry with fix (capped) → else stop + Telegram + `error-log.md`. Spec'd, not implemented.
- **Run-detail view** — click a run in Automations → its events, leads touched, cost. Promised to the user.
- **Obsidian daily mirror** — write a human-readable daily summary into `brain/` so the vault stays the readable source of truth (spec §7). Needs the worker (filesystem) + the confirm-before-edit rule from CLAUDE.md.
- **Second Brain + Projects pages** — Obsidian browsing/editing via the local worker (M9). Pages exist as honest placeholders.
- **Full cost tracking** — log Apify/AMF/reply-LLM spends to `costs`, not just skills LLM calls.
- **Inbox auto-pause** on bounce/spam signals (spec'd in sending-safety, not implemented).
- **Content Engine V2** (BUILD.md §13) — "one piece of content, posted everywhere": avatar-clip editing pipeline, ManyChat comment→DM, personal-brand Live Photo cadence. Explicitly out of V1 scope; the One-Click skills are its seed.
- **Postgres migration** — only if SQLite-on-volume becomes a limit.
