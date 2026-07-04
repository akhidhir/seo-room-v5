# Ayad — Working Style

- Keep answers short and specific
- Don't ask multiple questions; pick the best path and propose it
- Skip preamble. No "I'll continue" or "Let me look at..."
- Push the work forward — don't wait for permission on small steps
- Do NOT assume or act on your own — take instruction from the user and do only what they say
- No chatty or silly responses — direct and to the point only
- File paths: edits to `/sessions/.../mnt/Desktop/...` may not sync to disk; copy files to Desktop and have user cp + git push
- Lock files: `.git/HEAD.lock` and `.git/index.lock` often need user to remove via `rm -f` in their terminal
- User prefers "always accurate data" — no fake/sample data ever
- User wants the BEST option for each feature, not just what works — mix and match APIs if needed
- User values automation — audit → approve → fix automatically

# Active Project: SEO Room v5

SEO automation system for The SEO Room agency. PDCA-cycle local SEO dashboard.

## Architecture

- **Dashboard v5**: `~/Desktop/seo-room-v5/` — Node + Express + PostgreSQL on Railway
- **Single-file React**: `public/index.html` via Babel standalone (~40,000+ lines)
- **Server**: `server.js` (~52,000+ lines)
- **Live URL**: https://seo-room-v5-production.up.railway.app
- **GitHub**: https://github.com/akhidhir/seo-room-v5.git
- **Auto-deploys** from `main` branch
- **Railway CLI**: `cd ~/Desktop/seo-room-v5 && railway logs` — NOTE: only returns the last ~100 lines; grep immediately after an action or use the Railway web dashboard for history
- **Railway builds with RAILPACK** (not Nixpacks) — apt packages go in `railpack.json` (`deploy.aptPackages`). Chromium is installed this way for headless NAP checks.

## File Sync Workflow (Critical)

Sandbox can't git push. The workflow is:
1. Edit files in sandbox
2. Copy to Desktop: `cp server.js /sessions/.../mnt/Desktop/server-v5-latest.js`
3. User runs: `cd ~/Desktop/seo-room-v5 && cp ~/Desktop/server-v5-latest.js server.js && rm -f .git/HEAD.lock .git/index.lock && git add server.js && git commit -m "message" && git push && rm ~/Desktop/server-v5-latest.js`
4. For both files: copy both, user runs cp for both then git add both

**IMPORTANT**: Edit tool writes directly to mounted folder (`~/Desktop/seo-room-v5/`), so user can also just `git add -A && git commit && git push` directly without the copy step.

## APIs & Integrations

- **SerpAPI**: SERPAPI_KEY env var — grid scanning (replaces Local Falcon), GPS-precision option in rank tracking dropdowns. NO LONGER the default rank provider.
- **Anthropic (Claude)**: ANTHROPIC_API_KEY — AI analysis for audits (GBP, GSC). Model: claude-haiku-4-5-20251001. Future: user-selectable model (Sonnet/Opus) per project.
- **Google OAuth 2.0**: GSC + GBP connections (user-level via `user_integrations` table)
- **Google Search Console API**: searchconsole.googleapis.com — URL Inspection for indexing checks, search analytics for GSC audit
- **PageSpeed Insights API**: PAGESPEED_API_KEY — Core Web Vitals scoring per page (mobile). Batched 5-at-a-time for speed.
- **WordPress REST API**: Read (pages/posts via WP REST) + Write (Yoast meta via Application Passwords)
- **DataForSEO IS THE DEFAULT PROVIDER** for SERP + Maps rank tracking (cheaper). Also: Business Data API (`my_business_info`) enriches GBP audits with real description/photos/claimed status.
- **DataForSEO**: DATAFORSEO_LOGIN/PASSWORD — used for keyword search volume estimation in Maps keyword generator, **Discover Maps** (ranked_keywords + Maps SERP checks), **Discover SERP** (ranked_keywords for organic discovery), **Backlinks API** (requires separate subscription activation at app.dataforseo.com/backlinks-subscription, $100 min prepaid balance shared across all APIs, ~$0.13 per full scan)
- **Local Falcon**: ~~Connected~~ **REPLACED by SerpAPI grid scanning**. Can be cancelled ($50/month saved)
- **Winston AI**: WINSTON_API_KEY — plagiarism detection for copywriter content. Synchronous API (no webhooks). POST to `https://api.gowinston.ai/v2/plagiarism` with Bearer token → instant results. 2 credits per word. Results saved to `plagiarism_checks` table.

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
- **Website Audit** ✅ WORKING — **Dual system**: Rule-based technical audit engine (no AI cost) + AI agent analysis.
  - **Rule-based engine** (`/audits/website/run`): Crawls up to 15 pages from sitemap. Checks: broken pages, HTTPS, redirects, robots.txt, sitemap, noindex, canonicals, meta titles/descriptions, H1s, duplicate titles, thin content, internal linking, Open Graph, schema, viewport. Saves findings to `audit_findings` table.
  - **Fix buttons**: Green "Fix" button on auto-fixable findings (schema, canonical, noindex, mixed content, H1). "Review" button on manual-only issues. Fix detail view has "Fix Now" button with live status feedback.
  - **Technical fix endpoint** (`/projects/:id/technical-fix`): 7 fix types via WordPress REST API:
    1. **Schema** — Deterministic JSON-LD from RC profile data (LocalBusiness) or page content Q&A headings (FAQPage). Writes to `_seoroom_schema` post meta → rendered by SEO Room Schema plugin in `<head>`.
    2. **Canonical** — Self-referencing canonical via Yoast `_yoast_wpseo_canonical`
    3. **Noindex removal** — Clears via `_yoast_wpseo_meta_robots_noindex: '0'`
    4. **Mixed content** — Search-replaces `http://domain` → `https://domain` in post content
    5. **Missing H1** — Injects `<h1>` from page title into post content
    6. **Open Graph** — Manual message (Yoast auto-generates)
    7. **Viewport** — Manual message (theme header.php change)
  - **PageSpeed Scores**: Dedicated sub-section. Runs Google PageSpeed Insights API on all discovered pages (up to 50). Sortable table with Performance Score (circular badge), LCP, FCP, CLS, TBT, Speed Index — color-coded. Parallel batches of 5. Results saved to DB.
  - **Speed fixes**: Handled by BerqWP (automatic on all client sites, no API — fully automatic optimization). Dashboard handles content-level speed fixes only.
- **On-Page Audit & Fix** ✅ WORKING — WordPress REST API + Yoast. Fetches all pages/posts, reads yoast_head_json for meta data. Analyzes word count, links, images. Shows table with SEO score dots, focus keyword, word count, links, issues. **AI Fix system**: select pages → AI suggests meta title/desc/focus keyword → preview modal with current (red) vs suggested (green) → apply to WordPress via Application Passwords. **Universal rollback** via `wp_change_history` table. Change History panel with per-change and per-page rollback.
- **Indexing** ✅ WORKING — Dedicated page. Checks home + service + suburb pages via URL Inspection API. Table with status (color-coded badges), last crawl, mobile, robots. Expandable rows for not-indexed pages with "Why not indexed" explanation, fix steps, "Create Fix Action Item" button. **Results persist to DB** — loaded on mount, not lost on navigation.

### ACTION PLAN → CONTROL CENTRE (REDESIGN — planned)
**Full spec: `ACTION_PLAN_CONTROL_CENTRE_SPEC.md`** (root of repo). Decision: the old Action Plan was a noisy 300–500-item audit dump (all `pending`, 0 scheduled, mixed-case severity, duplicate categories). Replacing it with a lean **Control Centre** — a team job board layered on top of in-place fixing (audit pages stay the place you diagnose + fix).
- **Three labels per ticket:** `Code` (e.g. `PRJ-INDX-01`, permanent, never changes) · `Fix type` (Copywriting / Technical / GBP / Manual — auto-set from category, decides which tool opens) · `Assignee`.
- **Auto-populated**, **one ticket per ROOT CAUSE not per symptom** (148 CWV warnings = 1 ticket w/ 148 affected pages — kills the noise).
- **Status:** New → Assigned → In Progress → Ready for Review → Done. Auto "In Progress" when assignee opens the ticket; only manual action is the **Finish** button. Reopen loops back.
- **Assignment:** default by PROJECT → member (all its tickets inherit); per-ticket exception; reassign anytime → updates that member's calendar.
- **Daily distribution:** project monthly hours (Project Settings) ÷ working days = daily budget; fill each day in priority order until budget full. **Order = value-per-hour (impact ÷ effort)** → quick wins + high priority first, busywork last. Leftover rolls over; past-due = **Late** flag.
- **Lead Control Centre:** views by member (load/overdue) / project / status / this-week; client export → Monthly Report.
- **Reuse:** existing audits, fix tools, Team Members, `action_items.{assigned_to,scheduled_date,estimated_hours}`. **Build:** code registry, root-cause grouping+dedupe, fix-type routing, normalized status, assignment+reassign, member calendar, lead board.
- **Phase 1 first:** normalize severity/category labels (kill `High`/`high`, `Quick Wins`/`Quick Win` dupes) → add code/fix_type/root_cause grouping → project assignment + lead board. Phase 2: hours field + daily distribution engine + calendar. Phase 3: notifications + client export + change history.
- **Decisions pending:** 3-letter project codes; pillar code list (INDX/CWV/CONT/CITE/LINK/CANB/GBP/TECH…); confirm native-lean build.

#### Old Action Plan (current, being replaced)
- **Calendar view** — Month/Week/Day views. Tasks color-coded by pillar. Auto-distribute endpoint assigns tasks across months based on monthly hours budget.
- **List view** — Table: Finding, Severity, Details, Category, Status, Action. Filters by severity, status, search.
- **Rankings-driven priority** (architectural decision): Maps + SERP Rankings are the PRIMARY source; GBP/GSC/Website audits are read-only diagnostics (but currently STILL auto-push — to be stopped).
- Pillar mapping: `gbp` → `['gbp', 'gbp_external']`, `gsc` → `['gsc', 'gsc_agent']`, `website` → `['website', 'technical']`
- `action_items` table has scheduling columns: `scheduled_date`, `estimated_hours`, `assigned_to`. **Known data rot:** severity stored mixed-case (`high`/`High`); duplicate category labels (`Quick Wins`/`Quick Win`, `Low CTR Pages`/`Low CTR`, etc.).

### COPYWRITER
- ✅ REAL — content_queue table + endpoints (suggest keywords, drafts, publish to WP, rollback, client share links via share_token). No fake data.

### PLAYERS HANDSHAKE (Competitive Intelligence)
- **Players Handshake** 🔄 REDESIGNING — Competitive intelligence page. Runs handshake analysis: builds "Our Player" profile (SerpAPI Maps + grid scan data), fetches competitor details (SerpAPI Place Details + homepage crawl + PageSpeed), generates AI strategy (Claude Haiku).
  - **Backend**: `POST /api/projects/:projectId/handshake/run` — background processing, poll via `GET /handshake/latest`. Stores in `audits` table with `pillar='handshake'`.
  - **Data shape**:
    - `data.our_player`: `{name, domain, location, industry, service_areas, gbp: {title, rating, reviews, type, types, address, phone, website, description, hours, photos_count, service_options, categories}, technical: {page_count, has_schema, schema_types, has_faq_schema, meta_title, meta_desc, word_count, internal_links, h1_count}, speed, grid_performance: {keywords_scanned, avg_arp, avg_solv}}`
    - `data.competitors[]`: `{name, rating, reviews, type, website, appearances, dominance, keywords_dominated, gbp: {...same}, technical: {...same minus page_count/internal_links}, speed}`
    - `data.strategy`: `{executive_summary, our_strengths[], our_weaknesses[], competitor_insights: [{name, key_advantage, what_we_can_learn}], gap_matrix: {key: {us, avg_competitor, gap, priority}}, proposed_strategy: [{action, why, expected_impact, effort, timeframe}]}`
  - **Frontend**: `PlayersHandshakePage` component in `public/index.html`. Currently being redesigned to match professional dark-mode SaaS mockup. Target: 4 KPI tiles + Next Best Actions sidebar, comparison table with progress bars, strengths/gaps panels, gap matrix work table. Teal (#14b8a6) accent.
  - **Design principles**: Quiet, professional, dense but clean, strong hierarchy, no card clutter, 8px border-radius max.

### DISCOVER LOCAL KEYWORDS
- **Discover Local Keywords** ✅ WORKING — Two-tab keyword discovery page under Reports section.
  - **Discover SERP tab**: Finds organic keywords the domain ranks for via DataForSEO `ranked_keywords`. Smart Generate filters: strips suburb names from keywords (200+ suburbs in SUBURB_GPS), removes competitor brand names (from `projects.competitors` + `grid_scans.competitors`), TRADE_SUFFIXES pattern filter (e.g., "hilton plumbing" = competitor, not service). Saves to `discovery_cache.keywords`.
  - **Discover Maps tab**: Finds keywords the business ranks for on Google Maps. Builds keyword list from: grid scans, rank tracking, industry templates, website page slugs, AND organic keywords (DataForSEO ranked_keywords with local intent filter). Checks each keyword on DataForSEO Maps API with GPS coordinates. Fuzzy business name matching (with/without spaces, domain base, website URL). Gets search volume for found keywords. Saves to `discovery_cache.maps_keywords`.
  - **UI**: Tab switcher with badge counts, 15px font, teal (#14b8a6) uppercase headers, white keyword text, color-coded position badges, per-row trash icon delete, bulk delete, re-scan button, empty state with discover button.
  - **Backend endpoints**: `GET/POST /api/projects/:id/discovery` (SERP), `GET/POST /api/projects/:id/discovery/maps/run` (Maps), `POST .../discovery/update` (SERP delete), `POST .../discovery/maps/update` (Maps delete).
  - **Stale run detection**: If discovery status='running' for >5 minutes, auto-reset and allow re-run.

### BACKLINKS
- **Backlinks** ✅ WORKING — DataForSEO Backlinks API. 5 tabs: Overview, All Backlinks, Anchors, New, Lost, Toxic Links.
  - **Overview**: Stat cards (Total Backlinks, Referring Domains, Domain Rank, Dofollow, Nofollow, Broken). Cards clickable → navigate to respective tab. Link Types pie breakdown computed from backlinks array.
  - **All Backlinks**: Table with Source URL, Anchor, Target, Rank (DFS 0-1000 scale, NOT Ahrefs DR), Dofollow badge, First Seen, Last Seen.
  - **Anchors**: Grouped by anchor text with backlink count + referring domains count.
  - **New/Lost**: Filtered by `first_seen` (last 30 days) / `is_lost=true`.
  - **Toxic Links**: Filtered by `spam_score > 50` from backlinks array.
  - **Backend**: `POST /api/projects/:id/backlinks/scan` (runs full scan), `GET /api/projects/:id/backlinks` (latest scan), `GET .../backlinks/list` (paginated backlinks), `GET .../backlinks/anchors`, `GET .../backlinks/new`, `GET .../backlinks/lost`, `GET .../backlinks/prospects`.
  - **DataForSEO field mapping**: `backlinks` = total count, `referring_links_attributes.nofollow` = nofollow count, dofollow = total - nofollow, `broken_backlinks` = broken count, `rank` = DFS domain rank (0-1000). `external_links_count` is OUTBOUND links (not backlinks!).
  - **Auto-retry with www prefix**: If domain returns task_status=40204 ("not found"), retries with `www.` prefix automatically.
  - **DB tables**: `backlink_scans` (scan metadata + summary JSONB), `backlink_items` (individual backlinks), `backlink_prospects` (link building prospects).

### REPORTS
- **Maps Rankings** ✅ WORKING — Full Local Falcon replacement. AI-powered keyword generator (Haiku suggests service+suburb combos with DataForSEO volume estimation). **SerpAPI Grid Scan**: configurable NxN grid (3×3, 5×5, 7×7) at configurable radius (5-30km). Generates GPS grid around business, calls SerpAPI `google_maps` from each point, calculates ARP/ATRP/SOLV/coverage. **Grid Heatmap**: visual NxN grid with color-coded positions per keyword. **Competitor Gap Analysis**: captures top 3 at each grid point, shows You vs Threats cards with rating/reviews/dominance comparison, review gap bar, and prioritized "What To Do" actions. Bulk select/delete. CSV import/export.
- **SERP Rankings** — SerpAPI-based keyword tracking
- **Monthly Reports** ✅ WORKING — generate per month (`/reports/generate`), stored in monthly_reports (UNIQUE project+month), stable client share link (`/report/:token`), and branded PDF export (`GET /api/projects/:id/reports/:reportId/pdf`) with MoM deltas + Work Completed (from wp_change_history) + top priorities. AI executive summary via Haiku.

### SETTINGS
- **Project Settings** — Basic info (name, domain, business name, industry, location), Project Type (Local Business toggle, Elementor toggle), WordPress URL, **WP Username + Application Password** fields, Google Connections (GSC property dropdown, GBP Place ID text field), Service Areas list, Competitors list
- **Agency Integrations** — OAuth connections (GSC ✅ Connected, GBP ✅ Connected but 0 quota) + API keys (SerpAPI ✅, Local Falcon ✅, WordPress ✅, Ahrefs extension)
- **Projects** — multi-project support

## Database Tables

projects, users, user_integrations, project_integrations, audits, audit_findings, action_items, rank_keywords, rank_tracking, gsc_keywords, monthly_reports, onpage_audit_cache, **wp_change_history**, **grid_scans**, **reviews_cache**, **posts_cache**, **discovery_cache**, **plagiarism_checks**, **seo_migrations**, **backlink_scans**, **backlink_items**, **backlink_prospects**

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

### reviews_cache (Local Intel review text matching)
```sql
CREATE TABLE IF NOT EXISTS reviews_cache (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  reviews JSONB DEFAULT '[]',
  total_count INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
)
```
Stores review text for service-name matching in Local Intel KPI grid. Populated from `data/local_intel_seed.json` on first load (30-day TTL).

### posts_cache (Local Intel post text matching)
```sql
CREATE TABLE IF NOT EXISTS posts_cache (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  posts JSONB DEFAULT '[]',
  total_count INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
)
```

### discovery_cache (Keyword Discovery — SERP + Maps)
```sql
CREATE TABLE IF NOT EXISTS discovery_cache (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'idle',
  keywords JSONB DEFAULT '[]',
  keyword_count INTEGER DEFAULT 0,
  api_cost NUMERIC(10,4) DEFAULT 0,
  discovered_at TIMESTAMPTZ,
  maps_status TEXT DEFAULT 'idle',
  maps_keywords JSONB DEFAULT '[]',
  maps_count INTEGER DEFAULT 0,
  maps_cost NUMERIC(10,4) DEFAULT 0
)
```
- `keywords`: SERP discovery results array `[{keyword, position, url, volume, traffic, cpc}]`
- `maps_keywords`: Maps discovery results array `[{keyword, position, volume}]`
- Dual status columns allow independent SERP and Maps discovery runs

### backlink_scans (DataForSEO Backlinks)
```sql
CREATE TABLE IF NOT EXISTS backlink_scans (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  total_backlinks INTEGER DEFAULT 0,
  referring_domains INTEGER DEFAULT 0,
  domain_rank INTEGER DEFAULT 0,
  summary JSONB DEFAULT '{}',
  backlinks JSONB DEFAULT '[]',
  anchors JSONB DEFAULT '[]',
  new_backlinks JSONB DEFAULT '[]',
  lost_backlinks JSONB DEFAULT '[]',
  api_cost NUMERIC(10,4) DEFAULT 0,
  scanned_at TIMESTAMPTZ DEFAULT NOW()
)
```
- `summary`: full DataForSEO summary response including `referring_links_attributes`, `referring_links_types`, `broken_backlinks`, etc.
- `backlinks`: array of `{url_from, url_to, anchor, rank, dofollow, first_seen, last_seen, is_lost, spam_score}`
- Toxic links: filtered client-side from backlinks where `spam_score > 50`

### Projects table extra columns
- `wp_username TEXT` — WordPress Application Password username
- `wp_app_password TEXT` — WordPress Application Password

## Key Code Patterns

- `data/local_intel_seed.json` — bundled review + post text for Local Intel fallback. Keyed by GBP location ID. Fetched via RC MCP tools. Refresh by re-fetching via MCP and updating file.
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
- `SUBURB_GPS` — 200+ Australian suburb GPS coordinates (Perth metro focus) for distance calculation, grid center point lookup, and keyword suburb stripping in Smart Generate
- `TRADE_SUFFIXES` — `['plumbing', 'electrical', 'roofing', 'painting', 'landscaping', 'carpentry', 'fencing', 'tiling', 'flooring', 'glazing', 'concreting', 'excavating', 'welding', 'rendering', 'plastering', 'cabinetry', 'joinery', 'gasfitting']` — used in Smart Generate to detect competitor brand names (e.g., "hilton plumbing" → competitor, not service)
- `SERVICE_ACTION_WORDS` — whitelist of action verbs (repair, install, fix, etc.) that indicate real services vs brand names
- `INDUSTRY_SERVICES` — hardcoded service templates per industry (plumbing, electrical, computing, etc.) for Maps keyword discovery
- `dataForSeoRankedKeywords(domain)` — gets organic keywords domain ranks for via DataForSEO labs API
- `dataForSeoMaps(keyword, lat, lng)` — checks Google Maps results for a keyword at specific GPS coordinates via DataForSEO SERP API
- Competitor name filtering in Smart Generate: loads from `projects.competitors` (TEXT[]) + `grid_scans.competitors` (JSONB), builds blacklist set, removes safe trade words from blacklist
- `dataForSeoBacklinks(target, endpoint, filters)` — calls DataForSEO Backlinks API. Endpoints: `/summary/live`, `/backlinks/live`, `/anchors/live`. Auto-retries with `www.` prefix on 40204 (not found). Requires separate backlinks subscription activation.

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

1. **GBP publish automation via RatingCaptain API** — complete the audit → approve → auto-fix loop for GBP (update description, reply to reviews, publish posts) through RC (locations-update-tool applies via Business Profile API). 'GBP Auto-Optimise' draft→review→publish partially exists — verify whats built before adding.
2. **Suburb Template System → Generic Solution** — Currently hardcoded for Sureflow. Needs: per-project theme settings in DB, seoroom-api plugin per client site, dynamic template builder pulling colors/fonts/services from project row. Elementor raw-meta approach proven — just needs parameterization.
3. **Citation building workflow** — the NAP checker now accurately shows which of the 25 AU directories a business is NOT listed on. Turn those into action items with pre-filled listing data per directory (most are free: Bing Places, Apple Business Connect, True Local, Yellow Pages).
4. **Lock automation endpoints** — /api/gbp-sync/targets, rc-sync, rc-grid-sync are auth-exempt (called by scheduled automations without JWT). Locking them requires updating the scheduled tasks to send a key AT THE SAME TIME — coordinated change.
5. **Update technical-fix endpoint** — Switch schema injection from post_content to _seoroom_schema meta field. Clean up old auto-fix routes.
6. **Model selector** — AI model dropdown in Project Settings (Sonnet/Opus/Haiku). Currently hardcoded Haiku.
7. **Monthly hours budget** — Calendar auto-distributes tasks within budget.
8. **Shared helper refactor** — Extract duplicated resolvePageId/resolvePageUrl/getPageContent/loadItemIntoEditor.
9. **Grid scan history + scheduled scans** — track position changes over time, alert on drops.
10. **Own SERP scraping API** — long-term cost play to replace SerpAPI/DataForSEO.

## Recent Changes (July 3 2026 session — full system audit + fixes)

### System-wide audit (4 batches, all deployed)
- **Security**: emergency restore-page now requires JWT and can ONLY use the requested project's own WP creds (old fallback could publish pages on the WRONG client site); hardcoded gsc-debug key removed; /api/elementor/ai-fill rejects hosts that aren't a registered project (was an open door to the Anthropic budget). NOTE: global auth = app.use(optionalAuth) at ~line 2080 — all /api/* routes require JWT except a whitelist inside optionalAuth.
- **Site safety**: meta-fix write verification was ||, now && across title+desc+focuskw (half-failed writes no longer count as success); wp_change_history rows written ONLY after WordPress confirms the write; H1-fix originals stored in FULL (old 5000-char truncation would have destroyed pages on rollback); rollback endpoints refuse 'none'/empty/truncated originals — including bad legacy rows.
- **Data accuracy**: GBP audit (audits/gbp/run) marks itself FAILED when the AI errors instead of saving a clean 0-findings audit.
- **Reliability**: all AI calls now go through the shared resilient anthropic client (retries + 60s timeout + undici keep-alive fix) — raw new Anthropic() instances caused silent failures.

### Mobile rank tracking + DataForSEO default
- rank-tracking/sync checks every keyword on desktop AND mobile (serp_position_mobile column; Mobile column in SERP Rankings UI, sortable). Cost estimator + logApiCost reflect 2 calls/keyword.
- DataForSEO is the DEFAULT provider everywhere (server fallbacks + all frontend dropdowns). SerpAPI remains as GPS-precision option.
- rank-tracking/sync is now a BACKGROUND JOB (rankSyncJobs + GET /sync/status polled every 3s; table refreshes as partial results land). Long desktop+mobile runs killed the old single HTTP request.

### NAP checker (Citations & NAP) — accuracy complete
- Presence-based confirmation: reads JSON-LD/tel:/og from raw HTML; headless Chromium (puppeteer-core + system chromium via railpack.json aptPackages) renders JS-heavy directories (Bing/Apple/Facebook) when static HTML cant confirm — budget 12 renders/run. Degrades gracefully if chromium missing.
- Runs as background job (napCheckJobs + /nap-check/status) with live progress text.
- Service-area businesses (no public GBP address): address columns show N/A instead of false Mismatch/Verify; rows judged on name+phone only.
- Wrong saved listing URLs are detected (page names a different business) and PURGED from citations automatically; unconfirmed rows link to that platforms own search (per-directory search templates on AUSTRALIAN_DIRECTORIES).

### Identity guards — wrong-business data leaks ENDED
- Root causes found: hardcoded Houseworks seed into project 1 on boot (now only if project 1 IS Houseworks); stale rc_location_id values pointing at other clients RC locations.
- Guards added in: local-intel auto-sync, its extended-list fallback, syncRcProfileFromApi, getRcLocationDetails, gbp-internal audit. A fetched profile whose name/domain doesnt match the project is NEVER saved — clear error tells the user which setting to fix.
- getRcLocationDetails SELF-HEALS: wrong/missing rc_location_id is auto-corrected from the projects gbp_location_id via the RC extended list, and written back to the projects table.
- nap-check also guards against a mismatched canonical GBP profile (clears stale reports).

### GBP audit endpoints — know the difference
- audits/gbp-internal/run — THE ONE THE UI USES (Local Intel → Run GBP Audit). RC profile + DataForSEO enrichment (fills missing description/review counts from real Google data) + identity guard. Logs [gbp-internal].
- audits/gbp/run — older AI-audit endpoint (SerpAPI+Haiku 3-pillars), also has DataForSEO fallback/enrichment. Not called by current UI.
- gbp-optimise/audit — GET, grades RC-synced profile, loads on GBP Optimise page open (no Run button).

### Security hardening
- WP app passwords NEVER sent to the browser: maskWpSecrets() masks as ******** in all project/migration responses; update endpoints treat the mask as unchanged (projects PUT via COALESCE, migrations PUT skips). Frontend needed no changes.

### Monthly Reports — DONE
- PDF export added (see REPORTS section). Copy Client Link + Download PDF buttons on each report card.

### Ops notes
- railway logs CLI returns only ~100 lines — grep immediately or use web dashboard.
- Railway migrated to RAILPACK builder: nixpacks.toml is IGNORED. Use railpack.json ({ "deploy": { "aptPackages": [...] } }).
- Desktop file sync from sandbox is flaky: after cp to /sessions/.../mnt/Desktop/, VERIFY with host-side Glob before giving the user the deploy command; use a fresh filename if a copy goes missing.
- package.json: puppeteer-core added (uses system chromium, no bundled download).

## Recent Changes (June 12 2026 session)

- **Client feedback loop**: comments read from page's own Drive doc + linked docs (`doc_id` fallback fixed — was silently never fetching), resolved comments included, fetch errors surfaced. `handled_doc_comments` table = comment memory (only NEW comments fed to AI). "N new client comments" badge with dismiss. Inputs Checked panel = server-verified evidence (per-comment patch verification, keyword presence checks).
- **Drive**: folder picker on Push to Drive (browse My Drive + Shared with me, search, create folders, move existing docs). `driveUpdateDoc` fixed (was malformed multipart — doc updates never worked before).
- **On-page**: live computed SEO score replaces stale Yoast linkdex; keyword-in-content/H1 checks; utility pages excluded (segment-matched regex). Fix Everything pipeline (metas → keyword weaving → orphan links → cache warm). Server-side orphan link job (site fetched once, 5 parallel AI pickers, serialized writes, See-also fallback). `fetchAllWpItems` = reliable WP crawl (retries + X-WP-TotalPages verification, aborts on partial — page counts were swinging 284→100).
- **Speed**: seoroom-speed plugin v1.2.0 (scan slideshow heroes/oversized bgs, optimize-image→WebP, fix-hero swap, replace-image site-wide, restore endpoints; get_home_path fatal fixed — v1.1.0 took HouseWorks down once, recovered via cPanel folder rename). Dashboard: Scan Hero/Image Fixes UI, Optimize & Replace per unique image, Stop button for CWV scans, sequential mobile→desktop (8s gap), adaptive throttle on doc failures. New: `projects.seoroom_speed_key`.
- **Infra**: per-project heavy-job lock (one WP-hammering job at a time). System health monitor (`system_issues` table, 10-min checks, watchdog auto-fails stuck audits, sidebar indicator). DB-backed background jobs (`background_jobs` table, heartbeats, interrupted-on-restart detection, status survives redeploys).
- **ROOT CAUSE of PageSpeed failures (days of symptoms)**: NOT Cloudflare settings, NOT the sites. DreamIT host (web62.hosting-cloud.net) is overloaded (load ~20) AND throttles Cloudflare's edge IPs per-IP → Lighthouse bursts time out; with CF paused, same page scores 96. Ticket open with DreamIT (sysadmin review: CF IP allowlisting + LiteSpeed/CSF limits). seoroom/houseworks/projection = same server + same CF account (gail/wilson NS); goldpc = different account/host, unaffected. CPU faults on all 3 accounts (LVE limits). PHP 7.4→8.2 upgrade advised for seoroom + projection. VPS move under consideration (DreamIT KVM 8GB $39.95 base + cPanel/managed extras).
- **HouseWorks hero**: homepage Elementor background slideshow = 3.8MB of JPGs (1.8MB first slide) = the real 27s LCP. Fix via plugin's fix-hero once host issues resolved.
- **QA gate ✅**: Fix Everything's content changes (keyword weaving) now QUEUE in `pending_changes` table instead of auto-applying. "Review AI Changes (N)" button on On-Page Audit page → diff panel (find=red strikethrough, replace=green) → Approve/Reject per item or Approve All. Approve = safe re-locate in current content (fails cleanly if page changed since queueing) + history snapshot + WP write. Metas still auto-apply (low risk); light-optimise keeps its preview modal.
- **Reliability roadmap agreed**: 1) DB jobs ✅ (resume-after-restart next), 2) QA gate ✅, 3) client-facing before/after reports, 4) finish Copywriter/Control Centre, 5) encrypt API keys at rest.

## Recent Changes (This Session — June 3 2026)

### Design-Safe Preview — FIXED ✅ (Plugin 8.9.16 → 8.9.19, tested on seoroom.com.au)
- **Matcher rewrite (8.9.16)**: pairs each DRAFT paragraph to its most-similar ORIGINAL by **shared-word overlap** (not by position). Fixes off-by-one (heading was being overwritten with body text, trailing paragraphs dropped). Requires ≥2 shared words → protects headings, author bios, forms. `team`/`author` types excluded from promotion.
- **FAQ rendering (8.9.17)**: new sections of type `faq` (or containing `<details>/<summary>`) render as a clean FULL-WIDTH accordion (`buildFaqSection`), not squeezed into the two-column split card.
- **Placement (8.9.18→8.9.19)**: new sections insert at the END of the article — before a "Related Posts"/related section if present, else before the site footer (works even when footer is outside the content wrap).
- **Live-from-dashboard (8.9.19)** ⭐: plugin loads `section-preview.js` from the dashboard (`?dash=` origin, cache-busted per load) instead of the bundled copy. **JS changes deploy via git push — NO plugin reinstall needed.** Falls back to inlined copy if dash unavailable. Console logs `script: dashboard (live)`.
- **Run-once guard**: `window.__seoRoomPreviewRan` prevents double insertion/reflow ("up and down") if a cached inline copy + dashboard copy both load.
- **Files**: edit `wordpress-plugins/seoroom/section-preview.js`, then `cp` to `public/section-preview.js` (dashboard serves the public copy via `express.static`). Plugin loader in `seoroom.php` ~line 943. Only PHP changes need a plugin reinstall now.
- **Verified**: 4/4 sections, FAQ accordion at end of article, author block skipped, matcher pairs correctly.

### Humanize → Preview → Publish (works)
- `/humanize-only` rewrites `<p>` paragraphs (50+ chars) via GPTHuman API + rule-based pass; preserves headings, links, FAQ accordion. `GPTHUMAN_API_KEY` is set. Flow: write → Humanize → Preview (shows humanized copy) → Publish.

### Team Members ✅ NEW (Settings → Agency Integrations → "Team Members")
- Invite by email → Resend email (or copyable link fallback) → invitee sets password → full-access admin (role 'admin', sees ALL projects; per-project "limited" tier is future).
- Backend: `POST /api/team/invite`, `GET /api/team`, `DELETE /api/team/invite/:id`, `DELETE /api/team/member/:id`, `GET/POST /api/team-invite/:token[/register]`. Table `team_invites`. Email via Resend (`RESEND_API_KEY`, `RESEND_FROM` — add to Railway; falls back to link). Frontend route `/team-invite/:token` → `TeamInvitePage`.
- **Open self-registration disabled** — `/api/auth/register` blocks unless zero users (bootstrap). New users only via invite.

### Smart Map Ranking ✅ NEW (Rankings → Smart Map Ranking)
- Surveys all suburbs within a radius of the business, ranks by **proximity + population** (free); optional **competitor check** re-ranks by **opportunity** (close + populous + LOW competition, competition weighted 0.40).
- **Dataset**: ABS 2016 census (michalsn/australian-suburbs, MIT) — suburb/state/postcode/population/GPS. Loaded at RUNTIME by the server (jsDelivr CDN + GitHub fallback), cached in memory + `data/au_suburbs.json`. Robust loader: retries, never caches empty, boot warm-load. Helpers: `loadAuSuburbs`, `geocodeSuburbText`, `resolveSmartCenter`, `haversineKm`, `rankByOpportunity`, `buildSmartPlan`.
- **Controls**: center (suburb+state, geocoded), radius slider (5–50km, default 25), **Min population** (default 200 — excludes 0-pop industrial estates/parks/airports that distort per-capita).
- **Competitor scan**: BACKGROUND job (`/competitors/run` + `/competitors/status`), checks EVERY suburb via DataForSEO Maps `{service} {suburb}`, progress bar, retries. Cached per **project+service+suburb** (`smart_comp_cache`, 30-day reuse) so it persists + isn't re-paid. Service term saved per project (`projects.smart_service`, Save button).
- **Columns** (sortable headers): #, Suburb, State, Population, Distance, Competitors, **Per 10k** (competitors per 10k residents = saturation), Opportunity/Score, Tier, **Done %** (checklist w/ progress bar). "Arrange by plan" button = phase order.
- **Per-suburb checklist** (expand row): suburb landing page / in GBP service areas / review mentions suburb / GBP post mentions suburb — done=green, 100%="Fully covered". Computed server-side from sitemap pages + `reviews_cache` + `posts_cache` + `service_areas`.
- **Rollout plan**: Phase 1/2/3 (shaded purple/blue/grey) with suburbs + actions. **Accept Plan** (auto-saves silently; explicit Accept locks). Persistence: survey auto-saves; scan auto-saves; survey merges cached competitors + falls back to last saved plan so data never disappears on reload.
- Stored in `audits` table `pillar='smart_map'` (uses `audit_data` column, NOT `data`).
- **Competitor count caveat**: it's the # of Maps results for `{service} {suburb}` (depth ~20) = local-pack visibility, NOT a directory count. Use a clean keyword ("plumber", not the business name).

### Maps Rankings fixes
- **Grid-scan cost estimate** fixed: `estimateFeatureCost('grid_scan')` now uses DataForSEO rate ($0.002) + label, not SerpAPI ($0.01). (Grid scan has always run on DataForSEO.)
- **Gap "What To Do" actions verified**: checks live sitemap pages + GBP service areas before recommending a landing page (4 accurate variants). Hardcoded `'Locksmith'` category fallback → `our.type || comps[0]?.type || project.industry`.

### Provider clarity (DataForSEO vs SerpAPI)
- **DataForSEO**: grid scan, all keyword discovery (Generate/Smart/Discover Keywords), handshake maps, Smart Map Ranking.
- **SerpAPI** (default, switchable): rank-tracking Sync, Discover Maps tab; plus competitor-domain discovery, citation `site:` search, AI Overview detection.

### New DB columns/tables this session
- `projects.smart_service TEXT`; `team_invites`; `smart_comp_cache (project_id, service, suburb, competitors, top, checked_at, UNIQUE(project_id,service,suburb))`; `data/au_suburbs.json` (runtime suburb dataset cache).

### Next Session Priorities
1. **Limited team-member tier** — per-project / read-only roles (currently all invited users are full-access admins).
2. **Smart Map Ranking → Action Plan** — push accepted plan suburbs as page/GBP tasks.
3. **AI Replace popup** — port from New Website editor to Copywriter.
4. **Sync Rewrite → page_sections** — top-level Rewrite should update `page_sections[].draft_text` so preview shows all sections (currently must use Section View).
5. **Carry-over**: sidebar scroll not independent; backlinks summary vs list count mismatch; DataForSEO SERP returns 0 for some AU keywords.

### Previous Sessions (Summarized)
- SERP Analysis rule-based engine (17 checks, 90%+ accuracy)
- Fix buttons wiring (26/26 gaps covered)
- SEO validation gate, Humanize, Suggest Keywords, Check Competitors
- Players Handshake redesign
- Action Plan Calendar (Month/Week/Day views)
- Rule-based Technical Audit Engine
- WordPress technical fixes via REST API
- SEO Room Schema plugin (replaces seoroom-helper)

## Google Local Business Ranking — Official Documentation (Last checked: June 2026, check every 3 months)

Sources: https://support.google.com/business/answer/7091 | https://support.google.com/business/answer/3038177 | https://support.google.com/business/answer/2853879

### 3 Core Ranking Factors
1. **Relevance** — how well the profile matches the search query. Complete + detailed info = better matching.
2. **Distance** — how far the business is from the searcher. For service-area businesses, based on the address Google has on file (even if hidden).
3. **Prominence** — how well-known the business is. Based on: links, articles, directories, review count, review score, and organic web ranking (SEO).

### Required GBP Fields (all businesses)
- **Business Address** — REQUIRED even for service-area/mobile businesses. Can hide from public but Google needs it for ranking.
- **Business Name** — real-world name, no keyword stuffing, no taglines.
- **Phone Number** — local number preferred, not call center.
- **Categories** — fewest possible, most specific. Primary category is a ranking factor.
- **Business Hours** — kept up to date, including special hours/holidays.
- **Business Description** — relevant to services, no promos/links/prices.
- **Website URL** — direct URL, no redirects.
- **Photos & Videos** — show what you offer.
- **Service Areas** — up to 20 areas (cities, postcodes, regions).
- **Services List** — complete set of services offered.
- **Reviews** — count + score factor into ranking. Respond to reviews.
- **Products** — for retail businesses in eligible countries.
- **Verified** — verification tells Google you're authorized.

### Service-Area / Mobile Business Specifics
- Must have address set (hide from customers).
- One profile per central office/location.
- If multiple locations with separate staff → each gets own profile.
- Service area boundary: max ~2 hours driving from base.
- No virtual offices (must be staffed during stated hours).
- Businesses requiring age verification (alcohol, cannabis, weapons) can't be service-area without storefront.

### What Improves Ranking (from Google docs)
- Complete and accurate profile information.
- Review count + positive ratings.
- Responding to reviews.
- Web SEO (organic position is a factor).
- Links, articles, directories mentioning the business.
- Photos and videos.
- Keeping hours up to date.
- Consistent name and categories across all locations (chains).

### What Our Dashboard Checks (Local Intel)
- Profile Completeness: 9 fields (name, address, description, phone, website, hours, categories, service areas, services).
- 3 suburb signals: has landing page, in GBP service areas, mentioned in review.
- Citations/directories (25 Australian directories).
- Competitor analysis (grid scan, review gap, dominance).
- Website location pages existence.

## Known Issues

- **RC API direct calls return 405** — Server cannot fetch reviews/posts from `local.ratingcaptain.com/api/reviews` (all HTTP methods return 405). The RC MCP tool (`mcp__rc-local-prod__reviews-list-tool`) uses an internal proxy that works. Current workaround: bundled seed file (`data/local_intel_seed.json`). To refresh: fetch via MCP, update seed file, redeploy.
- **Local Intel seed is partial coverage** — Seed has 74 reviews (of 1,467 total) and 28 posts. Enough for service-name matching but not exhaustive. Future: scheduled Cowork task to refresh all reviews via MCP weekly.
- **Schema fix writes to post_content** — Currently injects into `post_content` which Elementor ignores. NEEDS UPDATE: switch to `_seoroom_schema` meta field (requires seoroom-schema plugin on WP sites). Endpoint code ready, just needs the injection method swap.
- **Old auto-fix endpoint still references seoroom-helper** — Route 2 (schema) and Route 3 (CWV) at `/projects/:id/auto-fix` still try to call seoroom-helper plugin. Should be cleaned up to use standard WP API.
- **Import Current Copy on some sites** — WP REST API returns classic editor content only; Elementor/ACF sites may have content elsewhere. Live HTML fetch works but depends on server-side rendering.
- **Duplicated logic** — URL resolution, content fetching, editor state loading duplicated across endpoints. See "Shared helper refactor" in Pending.
- **Gold PC reviews API returns duplicates** — RC API returns each review 3× for this location. Seed file is deduplicated (8 unique from 25 returned).
- GBP Management API: 0 quota. Using manual Place ID input.
- Places API (New): billing project limit reached, can't enable.
- PageSpeed audit with 50 pages takes ~2 minutes. Railway may timeout on very large sites.
- Grid scan with 25 keywords × 25 points = 625 API calls takes ~4 minutes. Cost: ~$3.12 per full scan.

## v4 Reference

- Path: `~/Desktop/seo-room-v4/`
- Live: https://seo-room-v4-production.up.railway.app
- Had: managed agents via Claude API, WordPress plugin integration, Ahrefs data ingestion (handleAhrefsIngest), page health system, backlink gap analysis
- v5 should match v4 quality with better architecture
- v4 audit pattern: gather data → send to Haiku → parse JSON findings → save to DB (v5 now follows this)

## Suburb Template System (Elementor Page Creation via API)

### Architecture
- **SEO Room API plugin** (`seoroom-api.php`, v5) — Custom WP REST endpoints with hardcoded API key in POST body. Bypasses hosting that strips Authorization headers. Installed per client site.
- **Raw meta approach** — Uses `update_post_meta()` directly instead of Elementor's `document->save()`. Native save BREAKS frontend rendering (strips section styling). Raw meta renders correctly on frontend AND opens in Elementor editor.
- **`tree_json` parameter** — Pre-encoded JSON string sent from server.js to avoid PHP `json_decode()` converting `{}` to `[]`. Plugin applies `str_replace('"settings":[]', '"settings":{}', ...)` as safety net.
- **`_elementor_page_settings`** — MUST be stored as PHP array (`['hide_title'=>'yes']`), NOT JSON string. JSON string crashes Elementor editor with critical PHP error.

### Key Learnings (Hard-Won)
1. WordPress Application Passwords don't work on some hosts (auth headers stripped at server/proxy level) → seoroom-api plugin with API key in POST body
2. Elementor `document->save()` strips section-level styling during creation (backgrounds, padding, column sizes vanish on frontend) → raw `update_post_meta` only
3. PHP `json_decode($body, true)` converts `{}` to `[]` → use `tree_json` (pre-encoded string) + `str_replace` fix
4. `_elementor_page_settings` as JSON string → Elementor editor crash. Must be PHP array (WordPress auto-serializes).
5. `wp_slash()` required on `_elementor_data` before `update_post_meta` because WordPress internally runs `wp_unslash` on meta values

### Current State (Sureflow — Hardcoded)
- Endpoint: `GET /create-suburb-template-now` — one-shot, creates template on sureflow.seoroom.au
- Plugin API key: `sr_2026_kX9mNpQ4wR7vBz`
- Template: 14 Elementor sections (Hero with Elementor Form widget, Service Strip, Top Service, CTA Bars, Service Blocks, Why Choose Us, Differences, Assurance, Service Area List, FAQ)
- Form uses real Elementor Pro Form widget (`widgetType: 'form'`) matching homepage styling exactly
- Theme: teal #006E68, mint #81C2B2, heading #10202E, Familjen Grotesk / Space Grotesk fonts

### Future: Generic Solution
- `POST /api/projects/:id/create-suburb-template` — pulls theme/colors/fonts/services from project settings
- Per-project theme settings in DB: `primary_color`, `accent_color`, `heading_font`, `body_font`, `hero_image`
- seoroom-api plugin installed per client site, API key stored in `project_integrations`
- Template builder parameterized from project row, not hardcoded
- Mass-create 72+ suburb pages from approved template with suburb-specific content substitution

### Plugin Endpoints (seoroom-api v5)
- `GET /seoroom/v1/test` — health check (Elementor version, PHP, WP)
- `POST /seoroom/v1/create-page` — create Elementor page (accepts `tree_json`)
- `POST /seoroom/v1/delete-pages` — trash pages by ID array
- `GET /seoroom/v1/list-pages` — list all pages with status
- `GET /seoroom/v1/read-meta/{id}` — debug: show page meta (ps_type, data validity, section count)
- `GET /seoroom/v1/fix-page/{id}` — fix: page_settings string→array, empty settings []→{}, ensure meta fields

## Chrome Extension — RETIRED (July 2026)

- User no longer uses the extension. Do NOT propose extension-based features.
- Its old roles are replaced by: DataForSEO Backlinks API (Ahrefs scraping) and RatingCaptain API (GBP write automation — see backlog).

## WordPress Plugin: SEO Room Schema (seoroom-schema)

- **Replaces seoroom-helper** — no more custom plugin dependency
- Tiny plugin (~30 lines PHP): registers `_seoroom_schema` post meta for REST API, outputs JSON-LD in `<head>` via `wp_head` action
- Install: WP Admin → Plugins → Add New → Upload `seoroom-schema.zip` → Activate
- Plugin zip at `~/Desktop/seoroom-schema.zip` — install on all client WordPress sites
- All technical fixes (schema, canonical, noindex, etc.) use standard WP REST API + Yoast meta fields
- Schema injection works with ANY page builder (Elementor, Gutenberg, Classic Editor) because it renders in `<head>`, not in post content
- On-Page Audit reads Yoast data via standard `yoast_head_json` field (no plugin needed)

## Architecture Decisions

### Rankings-First Priority Model
- AI (Haiku) should NOT make subjective severity calls
- Rankings pages (Maps + SERP) are the source of truth for what matters
- Position in search results determines priority, not AI opinion
- GBP/GSC/Website audits are diagnostic — they find issues but don't auto-assign severity
- User chooses AI model per project (future: model selector in Project Settings)
- Monthly hours budget controls task distribution on calendar

### Technical Fixes: Rule-Based, Not AI
- Technical issues detected by rule-based engine (no AI cost)
- Fixes executed via WordPress REST API (no custom plugins needed beyond seoroom-schema)
- Schema generated deterministically from RC profile data (not AI-generated)
- Speed handled by BerqWP (automatic, no API)

## Standing Design Rule: Fix at the Point of Discovery (2026-07-04)

Every issue the dashboard finds must be fixable at the closest place it is shown — no "send to X",
no transfers, no navigating to another page to fix it. Applies to all projects, current and future.
- Meta issues → in-place AI fix (`aiFixMetaForPages` / `POST /projects/:id/fix-meta-inplace`, findings
  variant `POST /projects/:id/audit-findings/:fid/fix-meta`). Copywriter queue is ONLY for real
  content rewrites (thin content), never meta.
- Write-verification pattern: verify from the WP write RESPONSE body (immune to stale page caches),
  fall back to read-back with one 2s retry. Never report failure when the write applied.
- Never mark a finding/ticket fixed when nothing changed.
- Homepage guards: never trash/redirect/slug-change the homepage; duplicate title with homepage = retitle homepage brand-first.
