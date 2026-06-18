# Tedca OS — Handoff Docs

**Start here.** This folder lets a fresh Claude session continue the Tedca OS project with zero prior context. Everything here is grounded in the actual code and verified state as of **2026-06-11**.

## What this project is

Tedca OS is a private, password-gated **mission-control web app** that runs Tedca (the user's AI agency — med-spa niche, missed-call text-back offer). The core of V1 is a **cold-email machine**: one button (or a 9am scheduler) pulls leads from a bank or one Google Maps scrape, finds + verifies owner emails, sends across 5 Gmail inboxes with safety rules, schedules exactly one follow-up, and handles replies 24/7 — all visible live in a pixel-office dashboard, with Telegram notifications.

- **Live cloud deploy:** https://tedca-os-production.up.railway.app (Railway project `tedca-os`, id `6215778c-add2-4c91-95fe-5c5d3925029e`)
- **Code:** `tedca-os/` — `server/` (Express + node:sqlite), `app/` (React + Vite + Tailwind), `worker/` (local Mac job runner)
- **Original spec:** `tedca-os/BUILD.md` · **Visual PRDs:** `tedca-os/index.html` (serve on :4317) and `tedca-os/email-prd.html` (:4319)
- **Memory files:** `~/.claude/projects/-Users-yoljean-Downloads-Ted-Workspace/memory/tedca_os_build_state.md` and `tedca_os_prd.md`

## State in one paragraph

The app is **deployed and live on Railway** (single Docker container, SQLite on a `/data` volume, serving API + built React app from one URL). 5 `tedcas.org` inboxes (daniel, james, kevin, michael, joseph — note the **s** in tedca**s**.org) are OAuth'd; their tokens were imported to the cloud and **test sends from the cloud succeeded from all 5**. 33 med-spa leads + full email history were migrated to the cloud DB. The engine (bank-first scrape, AnyMailFinder verify, concurrent send, follow-ups, 3-branch reply handling, Telegram notifications) is **built and individually tested**, but a **full end-to-end run (bank → verify → send) has not yet been witnessed**, the reply round-trip is untested, blocking Telegram approvals are **not built**, test mode is **ON** (all sends divert to TEST_RECIPIENT), and the 9am scheduler is built but **OFF**. Three One-Click content skills (avatar video VO, TikTok Live Photo, Instagram carousel) are wired through the Mac worker; carousel test-rendered successfully, livephoto produced verified artifacts but its agent crashed at the finish, so the skills need one verification pass — that's the user's current focus.

## Doc map

| File | What's in it |
|---|---|
| [architecture.md](./architecture.md) | The three processes, DB schema, auth, job queue, the pixel office, what each UI page does |
| [email-engine.md](./email-engine.md) | The morning run pipeline, sending safety, reply handling, test mode, what's verified vs. not |
| [one-click-skills.md](./one-click-skills.md) | Avatar video / Live Photo / carousel skills, voices, scripts, current test status |
| [deploy-and-ops.md](./deploy-and-ops.md) | dev.sh, Railway deploy + CLI, helper scripts, every known gotcha |
| [decisions-and-ideas.md](./decisions-and-ideas.md) | Locked decisions (Gmail-not-Instantly, verify-don't-enrich, SQLite), Zapmail plan, ideas not yet built |
| [next-steps.md](./next-steps.md) | The prioritized open list ①–⑦ |

## The user's working rules (non-negotiable)

1. **No button exists unless it actually works.** No mocks, no fake data. Placeholder pages must say so in plain text (see Brain/Projects pages).
2. **Never deploy without an explicit go** from the user.
3. **Ask before any spend > $0.50.**
4. **Plain-words activity messages** — the live feed talks like a person, not like a log file.
5. **Visual-audit all renders** — read every output PNG/frame before calling content work done.
6. **Delegate auxiliary/token-heavy work to background subagents**; keep architecture, secrets, money, deploys, and final verification in the main session.
7. **Always run `tedca-os/dev.sh` after any code change** and confirm its three ✓ lines before saying it's ready.
8. **Never read `.env` files directly** — the workspace security hook blocks it. Scripts read secrets at runtime.
