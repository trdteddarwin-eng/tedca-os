# Tedca OS — agentic mission-control for a cold-email business

A private, single-operator **mission-control web app** that runs an entire outbound business end to end.
Open it in the morning, click **one button**, and an agentic pipeline scrapes target leads, finds and
verifies the decision-maker's email, saves everything to a CRM, sends across multiple inboxes with
deliverability safety, schedules a follow-up, and handles replies — streamed live, step by step, to your
phone. It asks for a human decision over Telegram before anything irreversible or anything that spends money.

> Built by **Ted Charles / Tedca AI Agency** as the internal cockpit the agency runs on. This is the
> applied-AI pattern I forward-deploy into client businesses: agents that run a real workflow, with a human
> in the loop and hard cost/safety guardrails — not a chatbot.

## What it does

- **One-click cold-email engine** — pull ICP + angle from notes → reuse the lead bank or run **one** Apify
  scrape → find + verify the CEO email (valid-only) → save to Postgres → send ~100/day across rotating
  inboxes with jitter and per-inbox caps → schedule exactly one follow-up → bank the leftovers.
- **24/7 reply handling** — polls inboxes via the Gmail API, classifies each reply (interested / negative /
  unsubscribe) with an LLM, and branches: send the offer link, flag for a human, or hard-stop and suppress.
- **Human-in-the-loop** — any decision or spend > $0.50 pauses the run and asks over Telegram, then resumes.
- **Live activity feed** — a unified WebSocket stream of every step (cloud agents + the local Mac worker) so
  the whole machine is visible in real time on the phone.
- **CRM + cost tracking** — leads move `Scraped → Emailed → Follow-up → Replied`; every paid call is logged
  with a running monthly total.

## Architecture

```
 Phone + Laptop ──► TEDCA OS  (web app + Postgres + live WebSocket feed)
                      │                              │
             CLOUD agents (24/7)              LOCAL worker (Mac)
             • send + read replies            • Apify scrape (Python)
             • follow-ups                     • notes read/write
             • Telegram HITL gate             • streams activity to the same DB
                      └──────────────┬───────────────┘
        Gmail API · Apify · AnyMailFinder · OpenRouter · Telegram
```

- **One cloud brain** hosts the dashboard, Postgres, the live feed, and the always-on sending/reply agents.
- **A local worker** on the operator's Mac handles anything needing the filesystem / Python (the scrape,
  notes) and streams its activity into the same DB, so cloud + local work show up in one feed.
- **Hard rule:** *no button exists unless it actually works* — no mock data, no dead controls.

## Stack

- **Frontend:** React + Vite + Tailwind (dark mission-control theme), self-hosted fonts.
- **Backend:** Node (Express/Fastify) — runs the agents, shells out to Python execution scripts, serves a
  WebSocket activity feed.
- **DB:** Postgres (Railway in prod, local in dev).
- **Integrations:** Gmail API (send + read), Apify (scrape), AnyMailFinder (find + verify), OpenRouter
  (classification + light personalization), Telegram (human-in-the-loop).
- **Auth:** single-user password gate; all secrets server-side only.

## Repo layout

| Path | What's there |
|---|---|
| `app/` | React + Vite + Tailwind frontend (the dashboard) |
| `server/` | Node backend — agents, API, WebSocket feed |
| `worker/` | Local Mac worker (scrape + notes, streams activity) |
| `docs/` | Design docs |
| `BUILD.md` | The full build spec / product requirements |
| `index.html` | Visual companion to the spec (serve on `:4317`) |

## Running locally

Secrets live in `.env` (gitignored — see `BUILD.md §11` for the full list). Local-first: it runs entirely on
localhost with a local Postgres before any cloud deploy.

```bash
./dev.sh        # boots the server + app for local development
```

## Notes

- **Cost discipline:** one Apify run per scrape (never N), reuse the lead bank first, send to verified
  emails only. Apify is capped and the agent asks before exceeding $0.50.
- **Deliverability:** per-inbox daily caps with a warmup ramp, inbox rotation, randomized send windows, and
  auto-pause on rising bounces — built to stay inbox-count-agnostic as more inboxes are added.
- Full requirements, data model, and build order are in [`BUILD.md`](./BUILD.md).
