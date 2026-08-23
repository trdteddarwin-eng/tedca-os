# Cold Email Runbook — Tedca OS

The current state of the cold-email machine: how it runs, everything we built/fixed,
what it costs, and what's still open. **Last updated: 2026-06-27.**
(Supersedes the older `tedca-os/docs/` handoff, which describes a pre-Zapmail, missed-call-offer version.)

## Latest audit — 2026-06-27 (Sat)
- **Sends today: 0** — correct, not a bug. Weekends are off (window is Mon–Fri 8–5 ET).
- **Reply system: verified WORKING (both directions).** The reader polls all 17 inboxes; last
  successful read 2026-06-27 (687 inbound message IDs processed to date). A transient ~30s network
  blip mid-day failed one poll cycle on every inbox and **self-recovered on the next cycle** (the
  crash-resistance working). End-to-end logic proven: the one real inbound so far (an out-of-office,
  06-25) was read → classified → auto-replied correctly. Only 1 reply total = expected at this stage
  (spam placement on the `.co` sends + follow-ups not all out yet).
- **Fri 06-26 sent 206 — but via the `.co` (spam) inboxes, NOT tedcas.org.** Those runs fired before
  the transport switch fully took hold, so they likely hit spam. The switch is locked in now:
  **tedcas.org sends for real starting Mon 06-29.**
- **Apify still blocked** (402, paid-Actor allowance empty) — running off banked leads. See OUTSTANDING.md.

## Where things run
| Thing | Where | Notes |
|---|---|---|
| **Live sender** | **Your Mac** (`tedca-os/dev.sh`) | The campaign actually runs here. Mac must stay awake (esp. 8–9am ET for the auto-run). |
| Server / API | `localhost:8790` | also serves the built app |
| App (dev) | `localhost:5173` | Vite dev server |
| Public live view | `*.trycloudflare.com` tunnel | Read-only window into the **Mac's** real data |
| Cloud | `tedca-os-production.up.railway.app` | **Parked + safe to delete.** Own SEPARATE empty DB; can't send Zapmail (Railway blocks SMTP/IMAP). Code lives in git, so deleting loses nothing. ⚠️ This is NOT the Cloudflare link — the Cloudflare tunnel points to the **Mac** (real live data); Railway is the empty parked copy. |

> ⚠️ **railway.app shows the cloud's parked DB, NOT the live campaign.** Use the
> **trycloudflare.com** tunnel to see what's really happening on the Mac.

## The pipeline (in order)
```
1. SCRAPE        Apify Google Maps — ONE run, many NJ keyword+city searches
2. NICHE FILTER  drop off-niche categories (cannabis, nail, hospital, Sephora…)  ← see NICHE-FILTER.md
3. VERIFY        AnyMailFinder → owner email + name + LinkedIn (only "valid" kept)
                 ↳ off-niche is skipped BEFORE this so it never costs a credit
4. SEND          rotate the 12 Zapmail inboxes · 20/inbox/day SHARED cap · 80–180s jitter
                 · Mon–Fri 8am–5pm ET · spintax (no two identical) · CAN-SPAM footer + List-Unsubscribe
5. FOLLOW-UP     once per lead · 3 days later · SAME inbox · shares the 20 cap · defers if capped · stops on any reply
6. REPLY CONCIERGE  read (IMAP/Gmail) → classify → hardened auto-reply OR escalate to Telegram → update CRM
                 · bounces auto-suppress · out-of-office ignored · price/claim/wrong-link drafts blocked
7. LINKEDIN      per lead with a profile, AI drafts a connect message → shown in CRM → you send it manually
```

## Sending inboxes — CURRENT (changed 2026-06-26, see DELIVERABILITY below)
- **NOW SENDING:** the **tedcas.org** Gmail inboxes → **daniel · kevin · michael · joseph** (these land in the inbox).
- **RESTED** (warming up, not sending): all 12 `.co` Zapmail inboxes (outreachopszone, tryforgestack, mymyaigen, myoutreachart) **+ james@tedcas.org** — they land in spam right now.
- Rest list lives in the `paused_inboxes` setting; `send_transport=gmail` routes to tedcas.org only.

## DELIVERABILITY (why the switch — 2026-06-26)
Inbox-placement test showed the **4 `.co` domains land in SPAM** (brand-new + **no website**, even though SPF/DKIM/DMARC are valid). **tedcas.org lands in the INBOX** (has a website + is seasoned). So we switched live sending to tedcas.org and rested the `.co`'s to warm up. To bring the `.co`'s back: deploy a real website on each (HTML built in `../sending-domains/<domain>/index.html`, NOT yet deployed — needs DNS pointing) + ~2-4 weeks warmup, then re-test.

## Key settings (`settings` table)
`test_mode` (0=live) · `paused` (0=sending) · **`send_transport=gmail`** (tedcas.org) · **`paused_inboxes`** (rested emails, CSV) · `per_inbox_cap=20`
· `daily_target=240` · `schedule_hour=8` · `send_gap_min_s=80` / `send_gap_spread_s=100`
· `compliance_footer` · `email_subject` / `email_body` / `followup_body`

## The offer
Database reactivation for med spas — bring back past clients, no ad spend, performance-based.
Proof: a med spa in Union NJ, 5 past clients back in 30 days. Link → `database-reactivation-nine.vercel.app`.

## Restarting after any change
Always run `tedca-os/dev.sh` and confirm **3 ✓** (server :8790, app :5173, worker). The
engine reloads on restart. Pause first (`paused=1`), restart, then resume (`paused=0`).

## Auto-restart watchdog (so the stack self-heals)
A launchd agent (`com.tedca.os.watchdog`) runs `~/Library/Application Support/tedca-os/watchdog.mjs`
every 60s and restarts ONLY whatever is down — server, worker, or app — so a crash, sleep, or
closed IDE can't silently kill the morning send again (root cause of the 2026-06-26 8am miss).
- Script lives OUTSIDE `~/Downloads` because macOS (TCC) blocks launchd from running scripts in
  Downloads. The app it manages still lives in Downloads, so the **`node` binary needs Full Disk
  Access** (System Settings → Privacy & Security → Full Disk Access → add `/usr/local/bin/node`)
  for the watchdog to survive a full reboot. Verified working live (kill worker → auto-restored).
- Logs: `/tmp/tedca-watchdog.log` (restarts) and `/tmp/tedca-watchdog.err`.
- Still requires the Mac to be **awake** at 8am ET for the scheduler to fire.

## Other docs here
- **FIXES.md** — everything we faced and fixed (the full list)
- **COSTS.md** — finance breakdown ($/email, $/day, what uses what)
- **NICHE-FILTER.md** — the med-spa category filter
- **OUTSTANDING.md** — what's still to do + ops
