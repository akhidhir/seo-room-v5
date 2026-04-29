# Ayad — Working Style

- Keep answers short and specific
- Don't ask multiple questions; pick the best path and propose it
- Skip preamble. No "I'll continue" or "Let me look at..."
- Push the work forward — don't wait for permission on small steps
- File paths: edits to `/sessions/.../mnt/Desktop/...` may not sync to disk; copy files to Desktop and have user cp + git push
- Lock files: `.git/HEAD.lock` and `.git/index.lock` often need user to remove via `rm -f` in their terminal
- User prefers "always accurate data" — no fake/sample data ever
- User wants the BEST option for each feature, not just what works — mix and match APIs if needed
- User values automation — audit → approve → fix automatically

# Active Project: SEO Room v5

SEO automation system for The SEO Room agency. PDCA-cycle local SEO dashboard.

## Architecture

- **Dashboard v5**: `~/Desktop/seo-room-v5/` — Node + Express + PostgreSQL on Railway
- **Single-file React**: `public/index.html` via Babel standalone (~7000+ lines)
- **Server**: `server.js` (~6000+ lines)
- **Live URL**: https://seo-room-v5-production.up.railway.app
- **GitHub**: https://github.com/akhidhir/seo-room-v5.git
- **Auto-deploys** from `main` branch
- **Railway CLI**: `cd ~/Desktop/seo-room-v5 && railway logs --tail 20`

## File Sync Workflow (Critical)

Sandbox can't git push. The workflow is:
1. Edit files in sandbox
2. Copy to Desktop: `cp server.js /sessions/.../mnt/Desktop/server-v5-latest.js`
3. User runs: `cd ~/Desktop/seo-room-v5 && cp ~/Desktop/server-v5-latest.js server.js && rm -f .git/HEAD.lock .git/index.lock && git add server.js && git commit -m "message" && git push && rm ~/Desktop/server-v5-latest.js`
4. For both files: copy both, user runs cp for both then git add both

**IMPORTANT**: Edit tool writes directly to mounted folder (`~/Desktop/seo-room-v5/`), so user can also just `git add -A && git commit && git push` directly without the copy step.

## APIs & Integrations

- **SerpAPI**: SERPAPI_KEY env var — used for rank tracking (SERP + Maps), GBP profile lookup, competitor analysis, **grid scanning** (replaces Local Falcon)
- **Anthropic (Claude Haiku)**: ANTHROPIC_API_KEY — AI analysis for all audits (GBP, GSC, Technical). Model: claude-haiku-4-5-20251001
- **Google OAuth 2.0**: GSC + GBP connections (user-level via `user_integrations` table)
- **Google Search Console API**: searchconsole.googleapis.com — URL Inspection for indexing checks, search analytics for GSC audit
- **PageSpeed Insights API**: PAGESPEED_API_KEY — Core Web Vitals scoring per page (mobile). Batched 5-at-a-time for speed.
- **WordPress REST API**: Read (pages/posts via WP REST) + Write (Yoast meta via Application Passwords)
- **DataForSEO**: DATAFORSEO_LOGIN/PASSWORD — used for keyword search volume estimation in Maps keyword generator. Could be used for richer GBP/backlink data
- **Local Falcon**: ~~Connected~~ **REPLACED by SerpAPI grid scanning**. Can be cancelled ($50/month saved)
- **Ahrefs**: Via Chrome extension scraping (not API) — needs ingestion endpoint ported from v4

## Google Cloud Project

- Project ID: 231264075545 (SEO ROOM Dashboard)
- Enabled APIs: Search Console, My Business Account Management (0 quota), PageSpeed
- GBP Management API has 0 quota (needs partner application) — GBP audit uses SerpAPI instead
- Places API (New) NOT enabled — billing project limit reached. Would be better for GBP data but can't enable.

## Dashboard Pages (Sidebar) — Current State

### AUDIT
- **GBP Audit** ✅ WORKING
  - **Internal Audit**: Database-stored GBP profile data
  - **External Audit**: AI-powered via SerpAPI + Haiku managed agent. Covers 3 pillars (Proximity, Relevance, Prominence), competitor gap analysis (top 5 competitors from maps data), citations/directories (25 Australian directories with metadata: free/paid, price, difficulty), reviews, photos. Sub-sections in sidebar. Category boxes in 2-column grid, collapsible with chevron + CRITICAL badge. Loading spinner overlay.
- **GSC Audit** ✅ WORKING — AI-powered managed agent via OAuth + Haiku. Checks: Quick Wins (pos 4-20), Low CTR, Zero Clicks, Cannibalization, Underperforming Pages. Sub-sections in sidebar. Category boxes in 2-column grid.
- **Website Audit** ✅ WORKING — AI-powered managed agent. Crawls pages, analyzes with Haiku. Sub-sections: Site Health, Crawlability, On-Page Issues, Content Quality, Core Web Vitals, Schema & Data, **PageSpeed Scores** (dedicated CWV page), Summary. Category boxes in 2-column grid.
  - **PageSpeed Scores**: Dedicated sub-section under Website Audit. Runs Google PageSpeed Insights API on all discovered pages (up to 50 via sitemap index + sub-sitemaps or WP REST API). Shows sortable table with Performance Score (circular badge), LCP, FCP, CLS, TBT, Speed Index — all color-coded against Google's pass/fail thresholds. Parallel batches of 5 for speed. Results saved to DB for persistence.
- **On-Page Audit & Fix** ✅ WORKING — WordPress REST API + Yoast. Fetches all pages/posts, reads yoast_head_json for meta data. Analyzes word count, links, images. Shows table with SEO score dots, focus keyword, word count, links, issues. **AI Fix system**: select pages → AI suggests meta title/desc/focus keyword → preview modal with current (red) vs suggested (green) → apply to WordPress via Application Passwords. **Universal rollback** via `wp_change_history` table. Change History panel with per-change and per-page rollback.
- **Indexing** ✅ WORKING — Dedicated page. Checks home + service + suburb pages via URL Inspection API. Table with status (color-coded badges), last crawl, mobile, robots. Expandable rows for not-indexed pages with "Why not indexed" explanation, fix steps, "Create Fix Action Item" button. **Results persist to DB** — loaded on mount, not lost on navigation.

### ACTION PLAN
- **GBP Actions**, **GSC Actions**, **Website Actions**
- Pillar mapping handles agent vs manual audit pillar names: `gbp` → `['gbp', 'gbp_external']`, `gsc` → `['gsc', 'gsc_agent']`, `website` → `['website', 'technical']`
- Agent audit findings auto-extracted via `extractFindingsFromReport()` → saved to `audit_findings` as approved → auto-creates `action_items`
- "Sync from Audit" button to backfill findings from existing completed audits

### COPYWRITER
- Content Queue, Drafts, Approved, Published — ALL FAKE DATA. Needs real implementation.

### REPORTS
- **Maps Rankings** ✅ WORKING — Full Local Falcon replacement. AI-powered keyword generator (Haiku suggests service+suburb combos with DataForSEO volume estimation). **SerpAPI Grid Scan**: configurable NxN grid (3×3, 5×5, 7×7) at configurable radius (5-30km). Generates GPS grid around business, calls SerpAPI `google_maps` from each point, calculates ARP/ATRP/SOLV/coverage. **Grid Heatmap**: visual NxN grid with color-coded positions per keyword. **Competitor Gap Analysis**: captures top 3 at each grid point, shows You vs Threats cards with rating/reviews/dominance comparison, review gap bar, and prioritized "What To Do" actions. Bulk select/delete. CSV import/export.
- **SERP Rankings** — SerpAPI-based keyword tracking
- **Monthly Reports** — in progress

### SETTINGS
- **Project Settings** — Basic info (name, domain, business name, industry, location), Project Type (Local Business toggle, Elementor toggle), WordPress URL, **WP Username + Application Password** fields, Google Connections (GSC property dropdown, GBP Place ID text field), Service Areas list, Competitors list
- **Agency Integrations** — OAuth connections (GSC ✅ Connected, GBP ✅ Connected but 0 quota) + API keys (SerpAPI ✅, Local Falcon ✅, WordPress ✅, Ahrefs extension)
- **Projects** — multi-project support

## Database Tables

projects, users, user_integrations, project_integrations, audits, audit_findings, action_items, rank_keywords, rank_tracking, gsc_keywords, monthly_reports, onpage_audit_cache, **wp_change_history**, **grid_scans**

### wp_change_history (Universal WordPress Rollback)
```sql
CREATE TABLE IF NOT EXISTS wp_change_history (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  page_id INTEGER NOT NULL,
  page_url TEXT,
  page_title TEXT,
  change_type TEXT NOT NULL,
  field_name TEXT NOT NULL,
  original_value TEXT,
  new_value TEXT,
  applied_at TIMESTAMPTZ DEFAULT NOW(),
  rolled_back_at TIMESTAMPTZ
)
```
Covers ALL WordPress writes (Yoast meta fixes, future copywriter, image compression). Snapshot-before-write pattern.

### grid_scans (SerpAPI Grid Scan — replaces Local Falcon)
```sql
CREATE TABLE IF NOT EXISTS grid_scans (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  keyword_id INTEGER REFERENCES rank_keywords(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  location TEXT DEFAULT '',
  grid_size INTEGER DEFAULT 5,
  center_lat DOUBLE PRECISION,
  center_lng DOUBLE PRECISION,
  radius_km DOUBLE PRECISION DEFAULT 10,
  grid_points JSONB DEFAULT '[]',
  competitors JSONB DEFAULT '[]',
  arp DOUBLE PRECISION,
  atrp DOUBLE PRECISION,
  solv DOUBLE PRECISION,
  found_in INTEGER DEFAULT 0,
  data_points INTEGER DEFAULT 0,
  scanned_at TIMESTAMPTZ DEFAULT NOW()
)
```
- `grid_points`: array of `{row, col, lat, lng, position, found, top3: [{title, rating, reviews, type}]}`
- `competitors`: `{top: [{name, rating, reviews, type, website, appearances, top1, top3, avg_position, dominance}], our_business: {rating, reviews, type, title}}`
- Metrics: ARP (avg rank of found), ATRP (avg true rank, unfound=21), SOLV (% top 3), found_in/data_points

### Projects table extra columns
- `wp_username TEXT` — WordPress Application Password username
- `wp_app_password TEXT` — WordPress Application Password

## Key Code Patterns

- `serpApiSearch(params)` — global helper, filters undefined/null values from params
- `anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', ... })` — AI audit analysis
- `getGscAccessToken(userId)` / `getGbpAccessToken(userId)` — OAuth token helpers with auto-refresh
- `getWpAuthHeaders(project)` — returns Basic auth headers for WordPress Application Passwords
- `readWpYoastMeta(wpUrl, pageId, authHeaders)` — reads current Yoast meta from WP, tries pages then posts
- `FindingCard` component — shared across audit pages with expand/collapse, approve/dismiss
- `extractFindingsFromReport(reportText, pillar, projectId, auditId)` — sends agent report to Haiku for structured extraction, saves to audit_findings + action_items. Auto-approved. Validates categories against PILLAR_CATEGORIES.
- `discoverPages(projectUrl, wpUrl)` — discovers pages via sitemap index (follows sub-sitemaps) or WP REST API, caps at 50
- Loading overlay: `audit-loading-overlay` CSS class with `spinner-large`
- Category boxes: 2-column grid, colored header with icon + chevron, collapsible, CRITICAL badge
- `AUSTRALIAN_DIRECTORIES` — array of 25 directories with name, url, type, free/paid, difficulty, priority
- `generateGrid(centerLat, centerLng, radiusKm, gridSize)` — generates NxN GPS grid around center point using Haversine offsets
- `GridHeatmap` component — visual NxN grid with color-coded cells (green top 3 → red not found), center pin marker, legend
- `getGridData(kw)` — frontend helper to get grid scan data for a keyword (checks gridScans state, falls back to rank_tracking competitors)
- `SUBURB_GPS` — 50+ Perth suburb GPS coordinates for distance calculation and grid center point lookup

### PILLAR_CATEGORIES constant
```javascript
const PILLAR_CATEGORIES = {
  gbp_external: ['Profile Completeness', 'NAP Consistency', 'Reviews & Reputation', 'Competitor Analysis', 'Directory & Citations', 'Photos & Media', 'Suburb Coverage'],
  website: ['Site Health', 'Crawlability', 'On-Page Issues', 'Content Quality', 'Core Web Vitals', 'Schema & Data'],
  gsc_agent: ['Quick Wins', 'Low CTR Pages', 'Cannibalization', 'Zero-Click Pages', 'Underperforming Pages'],
};
```

### Agent Audit Sections (Sidebar)
- GBP External: `['Profile Completeness', 'NAP Consistency', 'Reviews & Reputation', 'Competitor Analysis', 'Directory & Citations', 'Photos & Media', 'Suburb Coverage', 'Summary']`
- GSC: `['Quick Wins', 'Low CTR Pages', 'Cannibalization', 'Zero-Click Pages', 'Underperforming Pages', 'Summary']`
- Website: `['Site Health', 'Crawlability', 'On-Page Issues', 'Content Quality', 'Core Web Vitals', 'Schema & Data', 'PageSpeed Scores', 'Summary']`
- "Summary" is the last section (renamed from "Action Plan" — it's an agent summary, not an action list)

## UI Patterns

- Stats cards: 3-4 column grid, big numbers (28-36px), colored, uppercase labels
- Category boxes: 2-column grid, colored header with icon + chevron, collapsible, CRITICAL badge if any critical findings
- FindingCard: expandable with description, recommendation (green box with lightbulb), current (red) / target (green) values, Approve/Dismiss buttons
- Loading: centered spinner with title + animated subtitle text
- Tables: header row with uppercase labels, alternating row highlights, sortable columns
- Score circles: PageSpeed scores in circular badges with colored borders (green 90+, amber 50-89, red <50)

## Critical Design Rule

**ANY WordPress change MUST NOT change the website design and/or theme, for desktop or mobile.** This applies universally — Yoast meta fixes, copywriter changes, image compression, everything. All changes must have rollback capability via `wp_change_history`.

## Pending / Next Up (Priority Order)

1. **GBP fix automation** — Chrome extension executes approved GBP action items (update description, add categories, respond to reviews, create posts). Flow: audit → approve → extension executes.
2. **Copywriter pages** — replace fake data with real content workflow connected to action items.
3. **Project switcher** — sidebar dropdown loads real projects from DB (currently hardcoded "Current Project" / "Project 2").
4. **Ahrefs data ingestion** — port from v4 (handleAhrefsIngest + parseAhrefsFindings functions), store backlinks/referring domains for citation analysis in GBP audit.
5. **DataForSEO integration** — for richer GBP profile data (description, hours, full reviews with responses). User has account. Better than SerpAPI for GBP details.
6. **Build own SERP API** — future cost optimization, replace SerpAPI with direct Google scraping via proxies.
7. **Grid scan history** — track position changes over time, show trend arrows in table.
8. **Scheduled grid scans** — auto-run weekly/monthly, alert on ranking drops.

## Known Issues

- GBP audit AI sometimes flags "Missing Business Description" even when SerpAPI doesn't return that field. Prompt updated to say "don't flag null fields" but may still occur.
- GBP Management API: 0 quota, can't list locations in Project Settings dropdown. Using manual Place ID input instead.
- Places API (New): billing project limit reached, can't enable. Would give better GBP profile data than SerpAPI.
- PageSpeed audit with 50 pages takes ~2 minutes (5 parallel batches). Railway may timeout on very large sites.
- Grid scan with 25 keywords × 25 points = 625 API calls takes ~4 minutes. Cost: ~$3.12 per full scan at $0.005/call. Railway timeout risk for 7×7 grids with many keywords.

## v4 Reference

- Path: `~/Desktop/seo-room-v4/`
- Live: https://seo-room-v4-production.up.railway.app
- Had: managed agents via Claude API, WordPress plugin integration, Ahrefs data ingestion (handleAhrefsIngest), page health system, backlink gap analysis
- v5 should match v4 quality with better architecture
- v4 audit pattern: gather data → send to Haiku → parse JSON findings → save to DB (v5 now follows this)

## Chrome Extension

- Path: `~/Desktop/seo-room-extension/`
- Currently scrapes Ahrefs (site-overview, backlink-profile, content-gap, backlink-gap, organic-keywords)
- Future: extend to automate GBP fixes (update description, categories, respond to reviews)
- Future: extend to scrape Google Maps for grid scan (cost optimization — replace SerpAPI for maps)

## WordPress Plugin (seoroom-helper)

- Still needed for SEO score and focus keyword data in On-Page Audit
- Provides Yoast meta data via WP REST API
