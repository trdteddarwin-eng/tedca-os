# Costs — Finance Breakdown

Verified against the code + 2026 pricing. Updated 2026-06-25.

## Headline
| | Cost | Driver |
|---|---|---|
| **Per email sent** | **~$0.05** | mostly AnyMailFinder |
| **Per 100 leads** | **~$5.30** | AMF ~$4 · Apify ~$1.20 · LinkedIn ~$0.10 · replies ~$0.02 |
| **Per day (~150 sends)** | **~$8** | AMF ~$6 · Apify ~$1.80 · LLM ~$0.10–0.20 |

Range is ~$8–16/day depending on the AnyMailFinder plan tier and how many leads are reused from the bank (reused = $0 scrape/verify).

## Your Claude subscription powers $0 of the app
Confirmed by code sweep — **no Anthropic SDK, no `ANTHROPIC_API_KEY`, no subscription auth** anywhere in `server/src`. Every automated AI call is a raw `fetch` to **OpenRouter** with `OPENROUTER_API_KEY`. The Max subscription only powers the interactive assistant (the chat), never the app — exactly as intended (ToS).

## Where every dollar goes
| Service | What | Cost | Free? |
|---|---|---|---|
| **AnyMailFinder** | owner email + LinkedIn per lead (2 credits, **only charged when a valid email is found**) | ~$0.04/lead (10k-credit plan) up to ~$0.09–0.15 on smaller plans | No — **biggest driver (~75–90%)** |
| **Apify** (`compass/crawler-google-places`) | Google Maps scrape | $4 / 1,000 results (~$0.004 each) | Free tier ~$5/mo, then paid |
| **OpenRouter** (LLM) | reply classify (Haiku), auto-reply draft (Sonnet), LinkedIn note (Haiku), content engine | <2% of total (~$0.10–0.20/day) | No, but tiny |
| Gmail API, IMAP/SMTP, Telegram | send + read replies + notify | $0 | Yes |

## LLM call sites (all OpenRouter)
| Where | Model | ~Cost/call | When |
|---|---|---|---|
| `replies.js` classify | claude-haiku-4-5 | ~$0.0005 | per real reply |
| `replies.js` auto-reply draft | claude-sonnet-4.5 | ~$0.003 | per interested/neutral reply (once/lead) |
| `linkedin.js` connect note | claude-haiku-4-5 | ~$0.001 | per lead with a LinkedIn URL |
| `skills.js` / `index.js` content | claude-sonnet-4.5 | ~$0.005–0.03 | manual content runs only (not the email pipeline) |

## The two things that actually cost money
1. **AnyMailFinder** — the verified-owner-email lookups. The **off-niche filter (now runs before AMF)** stops wasting these on cannabis stores / hospitals / nail salons.
2. **Apify** — currently **out of credit** (402 errors). Top this up to hit full 240/day; otherwise volume is capped by lead supply. See OUTSTANDING.md.

The cold-email bodies + follow-ups are **templated = $0 LLM**.
