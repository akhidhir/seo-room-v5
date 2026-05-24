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
- **Single-file React**: `public/index.html` via Babel standalone (~25000+ lines)
- **Server**: `server.js` (~24500+ lines)
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
- **Anthropic (Claude)**: ANTHROPIC_API_KEY — AI analysis for audits (GBP, GSC). Model: claude-haiku-4-5-20251001. Future: user-selectable model (Sonnet/Opus) per project.
- **Google OAuth 2.0**: GSC + GBP connections (user-level via `user_integrations` table)
- **Google Search Console API**: searchconsole.googleapis.com — URL Inspection for indexing checks, search analytics for GSC audit
- **PageSpeed Insights API**: PAGESPEED_API_KEY — Core Web Vitals scoring per page (mobile). Batched 5-at-a-time for speed.
- **WordPress REST API**: Read (pages/posts via WP REST) + Write (Yoast meta via Application Passwords)
- **DataForSEO**: DATAFORSEO_LOGIN/PASSWORD — used for keyword search volume estimation in Maps keyword generator, **Discover Maps** (ranked_keywords + Maps SERP checks), **Discover SERP** (ranked_keywords for organic discovery). Could be used for richer GBP/backlink data
- **Local Falcon**: ~~Connected~~ **REPLACED by SerpAPI grid scanning**. Can be cancelled ($50/month saved)
- **Originality.ai**: ORIGINALITY_API_KEY — plagiarism detection for copywriter content. Synchronous API (no webhooks). POST to `/api/v2/scan/plag` → instant results. Also returns AI detection score. Results saved to `plagiarism_checks` table.
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

### ACTION PLAN
- **Calendar view** ✅ WORKING — Month/Week/Day views with navigation arrows. Tasks color-coded by pillar. Auto-distribute endpoint assigns tasks across months based on monthly hours budget.
- **List view** — Table with Finding, Severity, Details, Category, Status, Action columns. Filters by severity, status, search.
- **Rankings-driven priority** (architectural decision): Maps Rankings + SERP Rankings are the PRIMARY source of action items for the Action Plan. Rankings determine severity (position-based, not AI-subjective). GBP, GSC, Website audits are read-only diagnostics — they inform but don't auto-push to Action Plan.
- Pillar mapping: `gbp` → `['gbp', 'gbp_external']`, `gsc` → `['gsc', 'gsc_agent']`, `website` → `['website', 'technical']`
- `action_items` table has scheduling columns: `scheduled_date`, `estimated_hours`, `assigned_to`

### COPYWRITER
- Content Queue, Drafts, Approved, Published — ALL FAKE DATA. Needs real implementation.

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

### REPORTS
- **Maps Rankings** ✅ WORKING — Full Local Falcon replacement. AI-powered keyword generator (Haiku suggests service+suburb combos with DataForSEO volume estimation). **SerpAPI Grid Scan**: configurable NxN grid (3×3, 5×5, 7×7) at configurable radius (5-30km). Generates GPS grid around business, calls SerpAPI `google_maps` from each point, calculates ARP/ATRP/SOLV/coverage. **Grid Heatmap**: visual NxN grid with color-coded positions per keyword. **Competitor Gap Analysis**: captures top 3 at each grid point, shows You vs Threats cards with rating/reviews/dominance comparison, review gap bar, and prioritized "What To Do" actions. Bulk select/delete. CSV import/export.
- **SERP Rankings** — SerpAPI-based keyword tracking
- **Monthly Reports** — in progress

### SETTINGS
- **Project Settings** — Basic info (name, domain, business name, industry, location), Project Type (Local Business toggle, Elementor toggle), WordPress URL, **WP Username + Application Password** fields, Google Connections (GSC property dropdown, GBP Place ID text field), Service Areas list, Competitors list
- **Agency Integrations** — OAuth connections (GSC ✅ Connected, GBP ✅ Connected but 0 quota) + API keys (SerpAPI ✅, Local Falcon ✅, WordPress ✅, Ahrefs extension)
- **Projects** — multi-project support

## Database Tables

projects, users, user_integrations, project_integrations, audits, audit_findings, action_items, rank_keywords, rank_tracking, gsc_keywords, monthly_reports, onpage_audit_cache, **wp_change_history**, **grid_scans**, **reviews_cache**, **posts_cache**, **discovery_cache**, **plagiarism_checks**, **seo_migrations**

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

1. **Update technical-fix endpoint** — Switch schema injection from post_content to `_seoroom_schema` meta field. Install seoroom-schema plugin on all client sites. Clean up old auto-fix routes (remove seoroom-helper dependency from Route 2/3).
2. **Model selector** — Add AI model dropdown to Project Settings (Sonnet/Opus/Haiku). Currently hardcoded Haiku.
3. **Remove "Sync from Audits" button** — Audits are diagnostic only, don't auto-push to Action Plan.
4. **Monthly hours budget** — Settings field for monthly hours per project. Calendar auto-distributes tasks within budget.
5. **Shared helper refactor** — Extract duplicated logic: `resolvePageId`, `resolvePageUrl`, `getPageContent`, `loadItemIntoEditor`. Do incrementally.
6. **GBP fix automation** — Chrome extension executes approved GBP action items.
7. **Copywriter pages** — replace fake data with real content workflow.
8. **Ahrefs data ingestion** — port from v4.
9. **DataForSEO integration** — richer GBP profile data.
10. **Grid scan history** — track position changes over time.
11. **Scheduled grid scans** — auto-run weekly/monthly, alert on ranking drops.

## Recent Changes (This Session)

- **Originality.ai Plagiarism Check** — Integrated Originality.ai API for plagiarism detection in copywriter + build mode. `plagiarism_checks` DB table, synchronous API (no webhooks — instant results). "Plagiarism Check" button in both Build mode and Copywriter action bars, results panel showing score %, word counts, matched sources with percentages, color-coded badges. Also returns AI detection score. Env var: `ORIGINALITY_API_KEY`.
- **SEO Migration page** — 4-phase wizard (Crawl → Match → Redirects → Monitor) under main sidebar. `seo_migrations` table. Crawl old/new sites via sitemap, AI URL matching via Haiku, push 301 redirects to WP plugin, pre/post migration SEO snapshots, comparison report.
- **License key system** — Plugin license validation, yearly renewal (no stacking), AJAX-based license check, auto-update system.
- **Discover Local Keywords — Dual Tab (SERP + Maps)** — Rewrote `DiscoverLocalPage` component with two tabs: "Discover SERP" (organic keywords via DataForSEO ranked_keywords) and "Discover Maps" (keywords business ranks for on Google Maps via DataForSEO Maps API). Separate state, loading, and polling for each tab. Per-row delete + bulk delete. Re-scan button.
- **Smart Generate competitor filtering** — Added 3-layer brand name filtering: (1) competitor name blacklist from `projects.competitors` + `grid_scans.competitors`, (2) SERVICE_ACTION_WORDS whitelist, (3) TRADE_SUFFIXES pattern filter (e.g., "hilton plumbing" = competitor).
- **SUBURB_GPS expansion** — Expanded from ~50 to 200+ Perth suburbs with GPS coordinates. Used for stripping suburb names from keywords in Smart Generate and Maps grid center lookups.
- **Maps discovery backend** — New endpoints: `GET/POST /api/projects/:id/discovery/maps/run`, `POST .../discovery/maps/update`. Background job builds keyword list from grid scans + rank tracking + industry templates + organic keywords, checks DataForSEO Maps API with GPS coordinates, fuzzy matches business name.
- **discovery_cache table extension** — Added `maps_status`, `maps_keywords`, `maps_count`, `maps_cost` columns for dual discovery.
- **Stale run detection** — Discovery runs stuck at 'running' for >5 minutes auto-reset and allow re-run.
- **UI improvements** — 15px table font, teal (#14b8a6) uppercase headers, white keyword text, color-coded position badges.

### Previous Session
- **Players Handshake redesign (IN PROGRESS)** — Redesigning `PlayersHandshakePage` to match professional dark-mode SaaS mockup.
- **Handshake AI parsing fix** — Increased max_tokens 8000→12000, added JSON extraction.
- **PageSpeed ECONNRESET fix** — Added retries with exponential backoff.
- **Local Intel Reviews & Posts fix** — Bundled seed file (`data/local_intel_seed.json`), DB cache with 30-day TTL.

### Two Sessions Ago
- **Action Plan Calendar** — Month/Week/Day views with navigation. Auto-distribute endpoint.
- **Rule-based Technical Audit Engine** — No AI cost. 15+ technical SEO checks.
- **Fix buttons on Website Audit** — Green "Fix" for auto-fixable, "Review" for manual.
- **Technical fix endpoint** — 7 fix types via WP REST API.
- **SEO Room Schema plugin** — Replaces seoroom-helper.
- **Rankings-first architecture** — Audits diagnostic only, rankings drive Action Plan.

## Google Local Business Ranking — Official Documentation (Last checked: May 2026, check every 3 months)

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
- GBP audit AI sometimes flags "Missing Business Description" even when SerpAPI doesn't return that field.
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

## Chrome Extension

- Path: `~/Desktop/seo-room-extension/`
- Currently scrapes Ahrefs (site-overview, backlink-profile, content-gap, backlink-gap, organic-keywords)
- Future: extend to automate GBP fixes (update description, categories, respond to reviews)
- Future: extend to scrape Google Maps for grid scan (cost optimization — replace SerpAPI for maps)

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
