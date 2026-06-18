# Next Steps (priority order)

The open list as of 2026-06-11, in the order the user wants it. Each item says how to verify it's actually done — remember: **no button exists unless it actually works.** ([README](./README.md) · [email engine](./email-engine.md) · [skills](./one-click-skills.md))

## ① Full E2E run test (bank → verify → send) — zero Apify needed
The single biggest unproven path. 33 leads are already banked in the cloud, so a small run (target ~5) should complete **without any scraping**: bank pull → AnyMailFinder verify (CEO → company fallback) → concurrent send across the 5 inboxes with caps/jitter → leftovers re-banked → Telegram report.
- Run from the live UI (Home → Run, small target), test mode ON, during Mon–Fri 9–17 (the send window gates it).
- Verify: emails arrive at TEST_RECIPIENT with `[TEST → …]` subjects, activity feed shows every step, run row says done, Telegram report lands. Watch AnyMailFinder credits (each found email costs credits — keep target small).

## ② Reply round-trip test
Reply to one of the `[TEST → …]` emails from the TEST_RECIPIENT Gmail.
- Verify within ~2 min: follow-up cancelled, lead → `replied`, classification ran, tailored lowercase reply (with the patient-engine link) arrives in-thread, Telegram ping. Also test a "stop emailing me" reply → `do_not_contact`, no reply sent.

## ③ Blocking Telegram HITL approvals (not built)
Build per BUILD.md §8: pause the run (`status='paused'`), Telegram the question, poll `getUpdates` for the user's answer, resume. Wire it at minimum to: anything >$0.50, and the test-mode→live flip.

## ④ One-Click automations verification pass — **user's current focus**
Click all three skills from the live cloud UI with the Mac worker running: avatar video (script + MP3), Live Photo (full build → Photos.app; its last agent run crashed at the finish with a 529 though artifacts were verified), carousel (already test-rendered ✓ — re-confirm via cloud path). Visual-audit every rendered artifact before reporting.

## ⑤ Flip test_mode OFF + schedule ON (only on the user's explicit go)
After ① and ② pass: set `test_mode=0`, `schedule_enabled=1` (hour 9). First live day: keep the target modest, watch bounces, confirm the bank refills.

## ⑥ Zapmail inbox onboarding (when purchased)
Follow the runbook in [decisions-and-ideas.md](./decisions-and-ideas.md): add 12 addresses to INBOXES + Railway vars, add as OAuth test users, Connect each, cap 10/day week one, confirm permanent warmup, ramp toward ~120/day across 17 inboxes.

## ⑦ Run-detail view + Obsidian daily mirror (promised, not built)
- Run-detail: click a run in Automations → its events, leads touched, emails, cost.
- Obsidian mirror: worker writes a plain daily summary into `brain/` (respect the confirm-before-edit rule in CLAUDE.md).

---

Also open, lower priority: full cost logging (Apify/AMF/reply-LLM → `costs`), inbox auto-pause on bounces, self-healing retry loop, Second Brain/Projects pages (M9), Content Engine V2.
