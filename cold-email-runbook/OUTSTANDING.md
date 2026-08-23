# Outstanding — What's Still To Do

As of 2026-06-25. Nothing here blocks the campaign; it's running fine. Ordered by priority.

## 🔴 Operational (do soon)
- **Apify scraping is blocked — and it's NOT a top-up issue.** The 402 says
  `not-enough-usage-to-run-paid-actor · remaining usage $0.066`. The dashboard's "$X / $5.00"
  is **platform credit**; the Google Maps Scraper (`compass/crawler-google-places`) is a **paid
  Actor** with a *separate* usage allowance, which is what's empty. Watching/topping the $5
  platform number does NOT fix it. Three real fixes:
  1. **Upgrade Apify to a paid plan** (Starter ~$49/mo) — unlocks the paid Actor at scale. Simplest.
  2. **Switch the scraper to the Google Places API** — Google Cloud gives ~$200/mo free, enough
     for thousands of pulls. Best free path, but needs a build (`execution/scrape_google_maps.py`
     may be reusable). NOT yet wired into tedca-os.
  3. **Swap to a free Google-Maps Apify Actor** (platform-credit-only). Quality varies.
  Until one of these: daily volume = whatever the **lead bank** + AnyMailFinder can convert
  (~50–75/day off the current 124 banked), not the 240 target. AnyMailFinder itself HAS credit.
- **Keep the Mac awake**, especially 8:00–9:00am ET, or the scheduler can't fire the morning run.

## 🟡 Reply-handling hardening (medium — needs header access first)
These were identified in the audit but deferred because they need `gmail.js`/`imap.js` to
surface email headers they don't currently expose:
- **Header-based OOO detection** (`Auto-Submitted` / `X-Autoreply`) — today OOO is body/subject
  heuristic only. Reliable, but a body-only match escalates to Telegram instead of acting.
- **Alias / forwarded reply matching** (`In-Reply-To` / `References` threading) — today replies
  match by exact From-address, so a forwarded/alias reply could be missed.
- **Follow-up threading** — persist the initial `Message-ID` and set `In-Reply-To` so the "Re:"
  actually threads in the prospect's inbox.

## 🟡 Deliverability polish (before scaling past ~5k/day)
- **One-click List-Unsubscribe (RFC 8058 POST header)** — currently mailto-only (fine under 5k/day).
- **Daily-report date boundary** — `report.js todaysSends()` uses UTC `date('now')` while labels
  are ET; can double-count last-evening sends. Anchor to ET midnight.
- **Sending-domain websites** — the 4 `.co` domains have no website (mild spam signal). A simple
  landing page each would help (started in `/sending-domains/` but not deployed).

## 🟢 Optional / your call
- **Strict niche mode** — currently MIDDLE (keeps day spas, beauty salons, derm, plastic surgery).
  Can tighten to med-spa-only anytime (see NICHE-FILTER.md).
- **Soften money/guarantee words** in the cold body ("only pay when it works") — mild spam-trigger
  cluster, heavily mitigated by plain-text + spintax.
- **LinkedIn post enrichment** (Proxycurl/Clay) for hyper-personalized outreach — paid, low ROI for
  med-spa owners (they barely post on LinkedIn).
- **Auto-reply cap counting** — auto-replies aren't counted toward the per-inbox cap (low volume, minor).

## ✅ Done today (see FIXES.md)
Zapmail integration · Mac-as-sender · reactivation copy · platform + recipient dedup ·
send_transport mute · even rotation · spread pacing · re-entrancy guards · warmup ramp fix ·
crashable-endpoint fix · bounce handling · undefined-bind fix · reply-Concierge hardening ·
off-niche filter (pre-AMF) · CRM LinkedIn/filter/follow-up · notifications + ET dates · cloud sync.
