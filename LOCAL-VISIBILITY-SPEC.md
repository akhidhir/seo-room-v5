# Local Visibility — spec

New page. Nothing existing is modified. Maps Rankings, Smart Map Ranking and Ranking Orbits stay exactly as they are.

Agreed 2 August 2026.

---

## Why

Three pages currently measure "your Maps position" and disagree, because each runs a different search:

| Page | Query sent | Measured from |
|---|---|---|
| Ranking Orbits | `plumber` | GPS points on a geometric grid |
| Suburb coverage | `plumber` | A location *name* (city-level) |
| Smart Map Ranking | `plumber` | GPS point at the suburb |

On top of that, the grid data behind Orbits is sparse — Projection Plumbing was found at 2–3 points of 25 — and reach was calculated as the furthest single hit, so one lucky point read as "proven reach 10–15km" while the business was invisible almost everywhere.

This page answers a different question: **not "what is my number" but "where am I losing, why, and is it fixable".**

---

## Core rule

> Every number states its source and its date.

    Measured 2 Aug 2026 · "plumber" · GPS at suburb · top 20 · 3 of 3 points

Applies to table rows, gap panels, prospect reports and exports. **If a number cannot say where it came from and when, it is not shown.**

This one rule would have prevented most of what the 1 Aug review found: stale reach figures presented as current, competitor counts measured nationwide, suburbs placed at wrong distances.

---

## 1. Measurement

| Setting | Default | Notes |
|---|---|---|
| Radius | 25 km | User set |
| Suburbs | Every suburb inside the radius | From the ABS dataset (`AU_SUBURBS`), never the hardcoded `SUBURB_GPS` list |
| Points per suburb | 3 | 1 / 3 / 9 selectable |
| Keywords | 2 | Per project, explicitly set — never derived |
| Query | The **bare keyword** | `plumber`, not `plumber Cashmere` |
| Search | DataForSEO Maps, `location_coordinate`, depth 20 | Same method as a grid scan, so the numbers reconcile |

### Why the bare keyword

`plumber` and `plumber Cashmere` are different Google searches. Generic queries are proximity-driven; suburb-named ones pull in businesses from much further out. Using the bare keyword keeps this page consistent with grid scanning.

### Why suburbs, not a geometric grid

A 5×5 grid spends points on bushland and industrial estates. Sampling at suburbs puts every measurement somewhere real, and population tells you which results are worth anything.

### Guards — hard requirements

| Rule | Behaviour |
|---|---|
| Suburb state must match the business's state | Reject a NSW "Richmond" for a QLD client |
| Suburb must be inside the radius | Reject anything beyond it |
| **No coordinate → no measurement** | Fail loudly. **Never** fall back to a nationwide `location_name` search |
| Sanity check the results | If most returned businesses are >200 km away, flag the run as wrong rather than saving it |

The third rule is not theoretical. The competitor scan was doing exactly this — the survey strips lat/lng from its payload, so the browser sent none back and every lookup silently became a nationwide search that returned plausible-looking numbers.

### Three distinct states — never collapsed

| State | Meaning |
|---|---|
| `#4` | Measured, ranked 4th |
| `absent` | Measured, not in the top 20 |
| `—` | Not measured |

A failed lookup is **not** `absent`. It stays unmeasured.

---

## 2. Gap analysis — the differentiator

### Winnable

> A competitor at **equal or greater distance** from that suburb who **outranks** you there.

If someone further away still beats you, proximity is not the cause, so it is fixable. Losing to someone closer is geography.

Competitor coordinates come back in the same Maps results already being paid for — no extra API cost.

**Service-area businesses hide their address**, so some competitors return no coordinates. Those are flagged `distance unknown`, never silently dropped or silently counted.

### Compared against the top 3, not one

One competitor may be an outlier. Three shows a pattern. Display carries a pattern column:

| Factor | You | Best rival | Pattern |
|---|---|---|---|
| Reviews | 115 | 341 | 3 of 3 ahead |
| Suburb page | none | 890 words | 3 of 3 have one |
| Directories | 14 of 25 | 22 of 25 | 2 of 3 ahead |

The pattern column separates "one rival is strong here" from "this is table stakes and you're missing it".

### The eleven factors

Google ranks local results on relevance, distance and prominence. Rule out distance and these are what remain.

| Factor | Source | Fetched |
|---|---|---|
| Review count | Maps result | Free, already returned |
| Review score | Maps result | Free, already returned |
| Primary category | Maps result | Free, already returned |
| Review recency | DataForSEO business data | Once per competitor |
| Reviews naming the suburb | Same call | Once per competitor |
| Suburb page exists | Crawl their sitemap | Once per competitor |
| Content depth (word count) | Crawl the page | Free |
| Templated-content check | Existing similarity check | Free |
| On-page targeting (title, H1, opening) | Crawl the page | Free |
| Internal links to that page | Crawl | Free |
| Directories listed on | 25-directory `site:` scan | Once per competitor |
| Backlinks / domain rank | DataForSEO Backlinks | Once per competitor |
| Organic rank | DataForSEO SERP | Once per keyword |

**Not a factor: team or company size.** Google has no such signal. It only shows up indirectly, via reviews.

### Structure that keeps it affordable

| Layer | Frequency |
|---|---|
| Positions per suburb | Every run |
| Competitor profiles | Monthly |

Distance and position vary by suburb. Reviews, backlinks and pages do not — so they are a monthly snapshot joined onto every suburb row.

### Website gap — evidence it matters

HouseWorks has ~100 suburb pages, including Willetton and Canning Vale, and ranks in neither (checked on Google Maps, 2 Aug 2026). Page existence is not the differentiator; what is on the page is.

So the signal is **"is their page better than ours"**, not "do they have one".

---

## 3. History — the moat

**Every run writes a dated snapshot.** Nothing reads it for weeks. It cannot be backfilled.

Joined to `wp_change_history`, which already records what changed and when:

> "Kallangur page added 3 Aug — rank went absent → #7 over 4 weeks."

| Phase | Needs |
|---|---|
| Store snapshots | Day one |
| Before/after on changes | ~6 weeks of history |
| Pooled patterns across clients | ~3 months |
| A model, if it earns its place | After the above |

### On machine learning

ML is not the differentiator — every SEO tool claims AI. The differentiator is **the dataset it would run on**: "we made this change, on this date, in this suburb, and the rank moved this much."

Nobody else has that, because nobody else both executes the fix and measures the result in one system. Reporting tools cannot produce it. It compounds monthly and cannot be copied by shipping a feature.

Simple before-and-after on recorded actions beats a model, and gives proof of cause a model cannot.

**With one client and no history, a model would find noise and present it confidently** — the exact failure mode removed from this dashboard on 1 August.

---

## 4. Prospect report — lead generation

Same system minus anything needing access. Public data only.

| Available | Needs their access |
|---|---|
| Maps rank by suburb | Search Console |
| Competitor gap | WordPress internals |
| Website crawl + speed | GBP write access |
| Citations / NAP | Review replies |
| Backlinks | |

### Design rules

- **Every claim verifiable by the recipient in 30 seconds.** They can search their own suburb, count their own reviews, look at their own sitemap.
- **Narrow beats comprehensive.** Maps visibility, competitor gap, missing suburb pages. Not a 40-point audit.
- **No scores out of 100.** Invented precision.
- **No technical SEO findings.** Too easy to get wrong — the 1 Aug review found "52 broken links" that were working navigation menus.

One wrong claim in a cold email destroys credibility permanently. Every number must be one you would defend on a call.

### The hook

> "In 24 of 38 suburbs you serve, customers searching for a plumber don't see you — and in most of those, the business they do see is further away than you are. That's not a distance problem, it's a visibility one."

Cost per report: **~$1.50**.

Legal: Australia's Spam Act permits B2B cold email with accurate sender details and a working unsubscribe. Confirm with someone qualified before running volume.

---

## 5. Cost

Rates from `API_COST_RATES`: maps $0.002, SERP $0.004, backlinks ~$0.13/domain.

Defaults — 41 suburbs, 2 keywords, 3 points, 8 competitors, weekly rank scans:

| Item | Frequency | Monthly |
|---|---|---|
| Suburb rank scan | Weekly | $1.97 |
| Organic rank per keyword | Weekly | $0.06 |
| Search volume refresh | Monthly | $0.01 |
| Competitor positions | — | free (same searches) |
| Competitor profiles | Monthly | $0.02 |
| Competitor citations | Monthly | $0.80 |
| Website gap — all 7 checks | Monthly | free (own crawl) |
| AI gap summary | Weekly | $0.01 |
| **Total per client** | | **~$3.30** |

Optional: competitor backlinks +$1.04/month (needs the DataForSEO Backlinks subscription active).

These are **rate-card estimates, not billed amounts.** Show real spend from `api_costs` alongside them.

Crawling competitor sites costs nothing but can be blocked by Cloudflare or a WAF. Expect a failure rate, and show it as **"couldn't check"**, never as "no page".

---

## 6. Build order

| Phase | What |
|---|---|
| 1 | Suburb measurement + guards + dated snapshots |
| 2 | Top 3 competitors + winnable inference |
| 3 | Website gap (all free crawl checks) |
| 4 | Prospect report |
| 5 | Trends, once ~6 weeks of history exists |

Snapshots ship in phase 1 even though nothing reads them until phase 5. That is the part that cannot be added later.

---

## 7. Before building

| | Why |
|---|---|
| Fresh grid scan on Projection Plumbing | Current data is 17 days old, found at 2–3 points of 25 |
| Re-run Check Competitors | Old counts were measured nationwide, before the coordinate fix |
| Check Local Falcon and BrightLocal's current feature pages | Confirm nobody has shipped the winnable-gap idea. Grid scanning and citation auditing are commodity; the inference layer is what is different |

---

## Open questions

- 3-letter project codes for tickets?
- Should points-per-suburb scale with population — 1 for a 600-person suburb, 9 for North Lakes?
- Top 3 competitors per suburb, or top 3 overall across the area?
- Consolidate the four Maps-position pages later, or leave them?
