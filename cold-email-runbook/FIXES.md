# Everything We Faced & Fixed

Chronological-ish log of issues hit and how they were resolved. 2026-06-25.

## Infrastructure & sending
| # | Faced | Fixed |
|---|---|---|
| 1 | Railway **blocks outbound SMTP (587) + IMAP (993)** → the 12 Zapmail inboxes can't send/read from the cloud | Made the **Mac** the live sender; cloud is parked. `src/smtp.js`, `src/imap.js` |
| 2 | 5 Gmail inboxes leaking sends into a Zapmail-only campaign | Added `send_transport=smtp` gate across **initial, follow-up, auto-reply, AND the manual test-send** so Gmail inboxes are muted everywhere. `pool.js`, `engine.js`, `replies.js`, `index.js` |
| 3 | One inbox (april) sent everything — rotation reset every send | Switched to **least-used-inbox** selection → all 12 spread evenly. `engine.js sendBatch` |
| 4 | All sends fired in ~45 min (burst pattern) | **Spread pacing** via `send_gap_min_s/spread_s` (80–180s). `engine.js jitterMs` |
| 5 | Loops (`setInterval` + slow async) could spawn overlapping copies → bursts/double-sends | **Re-entrancy guards**: `followupBusy` (follow-up loop), `polling` (reply poll), plus a mid-run pause check. `engine.js`, `replies.js` |
| 6 | Warmup ramp was dead code (`capFor` math always returned the flat cap) | Fixed to `min(flat, ramp)` + a **`prewarmed` flag** so the current 12 stay at 20/day but a *new* inbox gets the 12→50 ramp. `engine.js`, `smtp.js` |
| 7 | Clicking "Run morning" during an active run threw an **unhandled rejection** (could kill the sender on Node 24) | Made `/api/run/morning` async + `await`. `index.js` |
| 7b | **Server CRASHED mid-run** when a Zapmail inbox's IMAP auth failed/dropped: `imapflow` fires an async `'error'` event (separate from the awaited call) and with no listener Node killed the whole process → run died, only the watchdog kept the box alive but couldn't resume the run. Silently cost real sends (seen 2026-06-26: run #22 died at 10:50). | (1) Attach `client.on('error', …)` to every ImapFlow client (`imap.js`). (2) Process-level `uncaughtException` / `unhandledRejection` handlers in `index.js` that **log and keep running** — no stray async error (IMAP/SMTP/fetch) can ever kill a live run again. |

## Lead quality & data
| # | Faced | Fixed |
|---|---|---|
| 8 | AnyMailFinder returned `sundar@google.com` etc. for leads whose "website" was a Google Maps/platform URL | **Platform-domain block list** (google, linktr.ee, booksy, gmail…). `engine.js blockedEmailDomain` |
| 9 | Multi-location chains (VIO Paramus + Clifton) share one owner email → same person emailed twice | **Recipient-level dedup** guard. `engine.js sendBatch` |
| 9b | The recipient dedup only blocked **same-day** repeats → **5 owners got 2 initial emails on different days** (metwell@lenoymed, auraheadspanj, completewellnessspas…). Plus weak ingest dedup created duplicate CRM rows. | **Defense-in-depth dedup baked in:** (1) ingest dedups by *real domain* or normalized name — platform domains like `google.com`/`sites.google.com` EXCLUDED so 105 distinct businesses aren't merged; (2) verify-time skip when AnyMailFinder returns an already-contacted owner email; (3) send-time guard switched from *today* to **ever** (`emailContactedElsewhere`); (4) migration quarantined 25 existing dup rows. Guarantees: never email one address twice, ever. `engine.js`. Verified with end-to-end inject-a-duplicate tests (12/12). One self-healing edge: a business scraped once with a domain + once without can make a transient dup row, quarantined at verify before any send. |
| 10 | `node:sqlite` "cannot be bound" error discarding leads when AMF found no owner | Coalesced AMF fields to `null` in `verifyOne`. `engine.js` (94 errors → 0) |
| 11 | We emailed off-niche businesses (cannabis store, **SEPHORA**, a Florida hospital, nail salons, an ENT clinic, a skincare association) | **Hybrid category filter** that runs at scrape AND before AnyMailFinder. `engine.js isOffNiche` — see NICHE-FILTER.md |
| 11b | We emailed **out-of-state** businesses (Denver, San Francisco, Florida, "Union City **CA**") — Google broadens a keyword once the local area is tapped out and returns places anywhere | **Geo guard.** Apify now scoped to `state: New Jersey` + `countryCode: us`; plus a deterministic `isOffGeo(state)` backstop at scrape AND before AnyMailFinder (drops a lead only when its state is KNOWN and not NJ — null/`US` are kept). Cleaned 20 already-in non-NJ leads → skipped, follow-ups cancelled. `engine.js isOffGeo`, `scrape.js` |

## Copy & reply handling
| # | Faced | Fixed |
|---|---|---|
| 12 | First test landed in spam; copy looked mass-blasted | Reactivation copy (research opener → proof → soft CTA), **business-name cleaning**, **spintax**, **no em dashes**, real Union NJ case study. `engine.js fillTemplate` |
| 13 | Hard bounces still got follow-ups + were never suppressed | **Bounce/NDR detection** → suppress the failed address + stop its sequence. `replies.js isBounce` |
| 14 | An out-of-office auto-reply killed a lead's sequence and triggered a bot-to-bot reply | **OOO detection** → ignore, keep the sequence running. `replies.js looksAutoResponder` |
| 15 | Auto-reply pitched the **wrong offer** (missed-call) + linked the wrong site | Rewrote Concierge prompts to the **reactivation** offer + link `database-reactivation-nine.vercel.app` |
| 16 | Auto-reply **hallucinated a price** ("$500/month") — breaks the performance-based offer + no-price rule | **11 prompt rules + an outbound safety screen**: any draft with a price/%/guarantee/wrong-link is BLOCKED and escalated to Telegram instead of sent. Plus injection scrub, suppression guard, legal/refund/"are you a bot" → human, empty/HTML handling, 20s fetch timeouts. `replies.js` |

## App / CRM / visibility
| # | Faced | Fixed |
|---|---|---|
| 17 | No LinkedIn in the CRM | LinkedIn column + per-lead **AI message** (manual send) + on-demand regenerate. `Crm.tsx`, `linkedin.js` |
| 18 | CRM had no filter; follow-up not visible | **Status filter + search**, and a **scheduled follow-up preview** per lead. `Crm.tsx`, `index.js` |
| 19 | No notifications; raw UTC timestamps | **Login digest**, **per-send toast** (+ native OS notify), **ET dates** everywhere. `App.tsx`, `Digest.tsx`, `Toast.tsx`, `format.ts`, `index.js /api/digest` |
| 19b | CRM showed **"emailed · 37"** when 174 leads were emailed, and **yesterday's sends vanished** | `/api/leads` capped at the newest 500 by id and the chips were counted **client-side** over that truncated list, so older emailed leads fell off. Fixed: **server-side `/api/leads/counts`** (GROUP BY over ALL leads) + **server-side `?status=`/`?q=` filtering** so the emailed filter returns all 174 incl. yesterday. Added a **"Sent" column**. `index.js`, `Crm.tsx`. QC: 4/4 numbers match the DB. |
| 20 | "Morning run done" Telegram linked dead `localhost` | Link → live Railway dashboard. `engine.js` |
| 21 | Cloud running old code | `railway up` synced cloud to current (stays parked). |
