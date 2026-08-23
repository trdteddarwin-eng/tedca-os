# Dental Niche Filter

**Switched from med spa to dentist on 2026-08-12.** Stops off-niche businesses from
entering the pipeline. Google Maps loosely matches "dentist in <city>" and returns
nearby non-dental businesses. Code: `engine.js` (`isOffNiche`, `ON_NICHE_CATEGORY`,
`OFF_NICHE_CATEGORY`, `HARD_OFF_CATEGORY`).

## Where it runs (TWO gates)
1. **At scrape** (`ingestLeads`) — off-niche leads are never inserted.
2. **Before AnyMailFinder** (`verifyOne`) — belt-and-suspenders: any off-niche lead that
   slipped in (e.g. an old bank lead) is skipped **before a verification credit is spent**.

## The rules

**HYBRID (on-niche always wins).**
> A category is blocked **only if** it matches `OFF_NICHE_CATEGORY` **AND NOT** `ON_NICHE_CATEGORY`.

So a real practice mis-tagged by Google as "Medical clinic", or a "Cosmetic dentist"
(which also matches the blocked word `cosmetic`), or a "Pediatric dentist" (which also
matches the blocked word `pediatric`), is **kept**.

**HARD_OFF bypasses the hybrid rule.**
> If a category matches `HARD_OFF_CATEGORY`, it is blocked outright, even if ON matches.

This exists because dental labs, suppliers, schools and insurers all contain the word
"dental", so `ON_NICHE_CATEGORY` would otherwise rescue them. None of them can ever
become a customer, and each one that slips through costs an AnyMailFinder credit.

| Tier | Kept? | Examples |
|---|---|---|
| Core dental | ✅ keep | Dentist, Dental clinic, Family/General dentist |
| Dental specialties | ✅ keep | Orthodontist, Endodontist, Periodontist, Prosthodontist, Oral surgeon, Pediatric dentist |
| Dental services | ✅ keep | Denture care center, Emergency dental, Teeth whitening, Invisalign, Implants |
| Mis-tagged | ✅ keep | "Medical clinic", "Medical office" |
| Dental but not a practice | ⛔ **HARD block** | Dental laboratory, Dental supply store, Dental school, Dental insurance |
| Clearly off-niche | ⛔ block | pharmacy, hospital, urgent care, med spa, dermatology, chiropractic, veterinary, nail/hair salon, restaurant, gym, law firm… |

## Note on med spas
The previous campaign's niche is now **blocked**: `med spa`, `medi-spa`, `medical spa`,
`day spa`, `massage`, `botox`, `laser hair`, `dermatolog`, `plastic sur` are all in
`OFF_NICHE_CATEGORY`. The regex is `med(?:i|ical)?[ -]?spa`, which covers "med spa",
"medspa", "medi-spa" and "medical spa" (a plain `med ?spa` misses "Medical spa" —
that leak was caught in testing).

## Test coverage
Verified 2026-08-12 against 44 real Google Maps categories: 19/19 dental categories
kept, 25/25 off-niche categories blocked. Re-run that check after any regex edit.

## Switching niche again later
Six things are coupled and must move together, or the pipeline silently yields zero:
1. `niche` setting
2. `search_query` setting
3. `markets` table queries (all 48 rows carry the keyword)
4. `ON_NICHE_CATEGORY` / `OFF_NICHE_CATEGORY` / `HARD_OFF_CATEGORY` in `engine.js`
5. Email copy (`email_subject`, `email_body`, `followup_body`) — offer is niche-specific
6. `TARGET_STATE` in `engine.js` if the geography changes

The failure mode is silent: an off-niche regex that still blocks your new target drops
100% of leads at the scrape gate and the run reports "done" with zero leads.
