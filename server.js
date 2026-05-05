const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');

// ==================== 1. CONFIG ====================

const app = express();
const PORT = process.env.PORT || 3000;

// Core env vars
const JWT_SECRET = process.env.JWT_SECRET || 'seo-room-v5-secret-change-in-production';
const DATABASE_URL = process.env.DATABASE_URL;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// OAuth integrations
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'https://seo-room-v5-production.up.railway.app/api/gsc/callback';
const GSC_SCOPES = 'https://www.googleapis.com/auth/webmasters.readonly';
const GBP_SCOPES = 'https://www.googleapis.com/auth/business.manage';
const GBP_REDIRECT_URI = process.env.GBP_REDIRECT_URI || 'https://seo-room-v5-production.up.railway.app/api/gbp/callback';

// External APIs
const DATAFORSEO_LOGIN = process.env.DATAFORSEO_LOGIN;
const DATAFORSEO_PASSWORD = process.env.DATAFORSEO_PASSWORD;
const DATAFORSEO_AUTH = DATAFORSEO_LOGIN && DATAFORSEO_PASSWORD ? 'Basic ' + Buffer.from(`${DATAFORSEO_LOGIN}:${DATAFORSEO_PASSWORD}`).toString('base64') : null;
const LOCAL_FALCON_KEY = process.env.LOCAL_FALCON_KEY;
const SERPAPI_KEY = process.env.SERPAPI_KEY;
const LATE_API_KEY = process.env.LATE_API_KEY;

// Managed Agents (Claude API)
const AGENT_IDS = {
  website: process.env.WEBSITE_AUDIT_AGENT,
  gbp: process.env.GBP_AUDIT_AGENT,
  gsc: process.env.GSC_AUDIT_AGENT
};

// Validate required config
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL required');
  process.exit(1);
}

// Warn on missing optional integrations
if (!GOOGLE_CLIENT_ID) console.warn('[boot] GOOGLE_CLIENT_ID not set — GSC OAuth disabled');
if (!SERPAPI_KEY) console.warn('[boot] SERPAPI_KEY not set — SERP + Maps rank tracking disabled');
if (!LOCAL_FALCON_KEY) console.warn('[boot] LOCAL_FALCON_KEY not set — Local Falcon grid scanning disabled');
if (!ANTHROPIC_API_KEY) console.warn('[boot] ANTHROPIC_API_KEY not set — AI audits disabled');

// Database pool
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Anthropic client
const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

// Express config
app.use(cors());
app.use(express.json({ limit: '30mb' }));

// Load index.html once on startup
let INDEX_HTML = '';
const indexPath = path.join(__dirname, 'public', 'index.html');
if (fs.existsSync(indexPath)) {
  INDEX_HTML = fs.readFileSync(indexPath, 'utf8');
  console.log(`[boot] index.html loaded: ${INDEX_HTML.length} bytes`);
} else {
  console.warn('[boot] index.html not found, serving placeholder');
  INDEX_HTML = '<html><body><h1>SEO Room v5 - index.html missing</h1></body></html>';
}

// ==================== 2. SCHEMA ====================

async function initDb() {
  const client = await pool.connect();
  try {
    // Users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        name TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Projects table
    await client.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        domain TEXT NOT NULL,
        business_name TEXT,
        industry TEXT,
        location TEXT,
        competitors TEXT[],
        service_areas JSONB DEFAULT '[]',
        is_local_business BOOLEAN DEFAULT true,
        is_elementor_site BOOLEAN DEFAULT true,
        wordpress_url TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Project integrations (DataForSEO, Local Falcon, WordPress, Ahrefs — per-project credentials)
    await client.query(`
      CREATE TABLE IF NOT EXISTS project_integrations (
        id SERIAL PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        config JSONB,
        status TEXT DEFAULT 'not_connected',
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(project_id, kind)
      )
    `);

    // User-level integrations (GSC, GBP — OAuth tokens shared across all projects)
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_integrations (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        config JSONB,
        status TEXT DEFAULT 'not_connected',
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, kind)
      )
    `);

    // Audits (GBP, GSC, Website)
    await client.query(`
      CREATE TABLE IF NOT EXISTS audits (
        id SERIAL PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        pillar TEXT NOT NULL,
        status TEXT DEFAULT 'queued',
        audit_data JSONB,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        error_message TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Audit findings (linked to audits)
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_findings (
        id SERIAL PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        audit_id INTEGER REFERENCES audits(id) ON DELETE SET NULL,
        pillar TEXT NOT NULL,
        category TEXT,
        title TEXT NOT NULL,
        description TEXT,
        recommendation TEXT,
        severity TEXT DEFAULT 'medium',
        current_value TEXT,
        recommended_value TEXT,
        status TEXT DEFAULT 'new',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Action items (from findings)
    await client.query(`
      CREATE TABLE IF NOT EXISTS action_items (
        id SERIAL PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        finding_id INTEGER REFERENCES audit_findings(id) ON DELETE SET NULL,
        pillar TEXT NOT NULL,
        type TEXT,
        title TEXT NOT NULL,
        description TEXT,
        current_value TEXT,
        new_value TEXT,
        severity TEXT,
        status TEXT DEFAULT 'pending',
        execution_type TEXT DEFAULT 'manual',
        execution_log JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        approved_at TIMESTAMPTZ,
        executed_at TIMESTAMPTZ
      )
    `);

    // SERP rank tracking
    await client.query(`
      CREATE TABLE IF NOT EXISTS rank_keywords (
        id SERIAL PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        keyword TEXT NOT NULL,
        location TEXT DEFAULT '',
        location_code INTEGER DEFAULT 2036,
        language_code TEXT DEFAULT 'en',
        search_volume INTEGER,
        cpc DOUBLE PRECISION,
        competition TEXT,
        added_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(project_id, keyword, location)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS rank_tracking (
        id SERIAL PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        keyword TEXT NOT NULL,
        location TEXT DEFAULT '',
        location_code INTEGER DEFAULT 2036,
        language_code TEXT DEFAULT 'en',
        serp_position INTEGER,
        serp_url TEXT,
        serp_title TEXT,
        serp_snippet TEXT,
        maps_position INTEGER,
        maps_title TEXT,
        maps_rating DOUBLE PRECISION,
        maps_reviews INTEGER,
        maps_address TEXT,
        competitors JSONB DEFAULT '[]',
        checked_at TIMESTAMPTZ,
        UNIQUE(project_id, keyword, location, checked_at)
      )
    `);

    // Grid scan results (SerpAPI Maps grid scanning — replaces Local Falcon)
    await client.query(`
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
    `);

    // GSC keywords (position data from Google Search Console)
    await client.query(`
      CREATE TABLE IF NOT EXISTS gsc_keywords (
        id SERIAL PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        keyword TEXT NOT NULL,
        clicks INTEGER DEFAULT 0,
        impressions INTEGER DEFAULT 0,
        ctr DOUBLE PRECISION DEFAULT 0,
        position DOUBLE PRECISION DEFAULT 0,
        prev_position DOUBLE PRECISION,
        fetched_at TIMESTAMPTZ,
        UNIQUE(project_id, keyword)
      )
    `);

    // Monthly reports
    await client.query(`
      CREATE TABLE IF NOT EXISTS monthly_reports (
        id SERIAL PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        month TEXT NOT NULL,
        report_data JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(project_id, month)
      )
    `);

    // On-page audit cache
    await client.query(`
      CREATE TABLE IF NOT EXISTS onpage_audit_cache (
        project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        results JSONB,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Citation tracking (per-project directory listing status)
    await client.query(`
      CREATE TABLE IF NOT EXISTS citations (
        id SERIAL PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        directory_name TEXT NOT NULL,
        status TEXT DEFAULT 'not_listed',
        listing_url TEXT,
        notes TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(project_id, directory_name)
      )
    `);

    // WordPress change history — universal rollback for ALL WP writes
    await client.query(`
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
    `);

    // Add columns for existing databases
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS competitors TEXT[]`);
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS is_elementor_site BOOLEAN DEFAULT true`);
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS wordpress_url TEXT`);
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS gsc_property TEXT`);
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS gbp_location_id TEXT`);
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS gbp_location_name TEXT`);
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS wp_username TEXT`).catch(() => {});
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS wp_app_password TEXT`).catch(() => {});
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS map_services TEXT`).catch(() => {});
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS map_custom_suburbs TEXT`).catch(() => {});
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS nw_name TEXT`).catch(() => {});
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS nw_domain TEXT`).catch(() => {});
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS nw_industry TEXT`).catch(() => {});
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS nw_location TEXT`).catch(() => {});
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS nw_business_type TEXT`).catch(() => {});
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS nw_notes TEXT`).catch(() => {});
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS nw_page_labels JSONB DEFAULT '{}'`).catch(() => {});
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS tone_of_voice TEXT`).catch(() => {});
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS page_wireframe TEXT`).catch(() => {});
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS customer_persona TEXT`).catch(() => {});
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS writer_voice TEXT`).catch(() => {});
    await client.query(`ALTER TABLE action_items ADD COLUMN IF NOT EXISTS category TEXT`).catch(() => {});
    await client.query(`UPDATE action_items SET category = type WHERE category IS NULL AND type IS NOT NULL`).catch(() => {});
    await client.query(`ALTER TABLE action_items ADD COLUMN IF NOT EXISTS pages_affected TEXT DEFAULT ''`).catch(() => {});
    await client.query(`ALTER TABLE action_items ADD COLUMN IF NOT EXISTS effort TEXT DEFAULT ''`).catch(() => {});
    await client.query(`ALTER TABLE action_items ADD COLUMN IF NOT EXISTS expected_impact TEXT DEFAULT ''`).catch(() => {});
    await client.query(`ALTER TABLE action_items ADD COLUMN IF NOT EXISTS assignee_label TEXT`).catch(() => {});
    await client.query(`ALTER TABLE action_items ADD COLUMN IF NOT EXISTS how_to_steps TEXT`).catch(() => {});
    await client.query(`ALTER TABLE gsc_keywords ADD COLUMN IF NOT EXISTS prev_position DOUBLE PRECISION`).catch(() => {});
    await client.query(`ALTER TABLE grid_scans ADD COLUMN IF NOT EXISTS competitors JSONB DEFAULT '[]'`).catch(() => {});

    // Content queue for Copywriter pipeline
    await client.query(`
      CREATE TABLE IF NOT EXISTS content_queue (
        id SERIAL PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        page_id INTEGER,
        page_url TEXT,
        page_title TEXT,
        content_type TEXT NOT NULL DEFAULT 'rewrite',
        source TEXT DEFAULT 'onpage-audit',
        priority TEXT DEFAULT 'medium',
        brief TEXT,
        current_content TEXT,
        current_word_count INTEGER DEFAULT 0,
        current_meta_title TEXT,
        current_meta_desc TEXT,
        current_focus_keyword TEXT,
        draft_content TEXT,
        draft_meta_title TEXT,
        draft_meta_desc TEXT,
        draft_focus_keyword TEXT,
        draft_word_count INTEGER DEFAULT 0,
        stage TEXT NOT NULL DEFAULT 'queue',
        approved_by TEXT,
        approved_at TIMESTAMPTZ,
        published_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});

    // Add missing columns for v5 copywriter features
    await client.query(`ALTER TABLE content_queue ADD COLUMN IF NOT EXISTS target_keywords JSONB DEFAULT '[]'`).catch(() => {});
    await client.query(`ALTER TABLE content_queue ADD COLUMN IF NOT EXISTS ai_notes TEXT`).catch(() => {});
    await client.query(`ALTER TABLE content_queue ADD COLUMN IF NOT EXISTS comments JSONB DEFAULT '[]'`).catch(() => {});
    await client.query(`ALTER TABLE content_queue ADD COLUMN IF NOT EXISTS schema_markup JSONB`).catch(() => {});
    await client.query(`ALTER TABLE content_queue ADD COLUMN IF NOT EXISTS page_wireframe TEXT`).catch(() => {});
    await client.query(`ALTER TABLE content_queue ADD COLUMN IF NOT EXISTS wireframe_image TEXT`).catch(() => {});
    await client.query(`ALTER TABLE content_queue ADD COLUMN IF NOT EXISTS wireframe_mime TEXT`).catch(() => {});
    await client.query(`ALTER TABLE content_queue ADD COLUMN IF NOT EXISTS wp_previous_status TEXT`).catch(() => {});
    await client.query(`ALTER TABLE content_queue ADD COLUMN IF NOT EXISTS wp_previous_content TEXT`).catch(() => {});

    // Content keywords — for new project keyword workflow
    await client.query(`
      CREATE TABLE IF NOT EXISTS content_keywords (
        id SERIAL PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        keyword TEXT NOT NULL,
        page_type TEXT DEFAULT 'unassigned',
        page_name TEXT,
        page_id INTEGER REFERENCES content_queue(id) ON DELETE SET NULL,
        search_volume INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});

    // Page templates — reusable content skeletons
    await client.query(`
      CREATE TABLE IF NOT EXISTS page_templates (
        id SERIAL PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        page_type TEXT NOT NULL DEFAULT 'service',
        source_url TEXT,
        skeleton_html TEXT NOT NULL DEFAULT '',
        section_count INTEGER DEFAULT 0,
        is_default BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});

    // Site pages — staging zone for new website content
    await client.query(`
      CREATE TABLE IF NOT EXISTS site_pages (
        id SERIAL PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        page_type TEXT NOT NULL,
        page_name TEXT NOT NULL,
        slug TEXT,
        is_cornerstone BOOLEAN DEFAULT FALSE,
        cluster_id TEXT,
        keywords JSONB DEFAULT '[]',
        internal_links JSONB DEFAULT '[]',
        inbound_links JSONB DEFAULT '[]',
        meta_title TEXT,
        meta_description TEXT,
        focus_keyword TEXT,
        draft_content TEXT,
        word_count INTEGER DEFAULT 0,
        stage TEXT NOT NULL DEFAULT 'draft',
        published_url TEXT,
        published_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});

    // Content settings — tone, style, word count per project
    await client.query(`
      CREATE TABLE IF NOT EXISTS content_settings (
        id SERIAL PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        page_type TEXT NOT NULL,
        target_word_count INTEGER DEFAULT 1500,
        tone TEXT DEFAULT 'professional',
        style TEXT DEFAULT 'informative',
        tone_of_voice TEXT,
        wireframe_url TEXT,
        factor_3 TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(project_id, page_type)
      )
    `).catch(() => {});

    // GBP Posts — calendar system for managing GBP posts
    await client.query(`
      CREATE TABLE IF NOT EXISTS gbp_posts (
        id SERIAL PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT,
        body TEXT NOT NULL,
        post_type TEXT DEFAULT 'update',
        cta_type TEXT,
        cta_url TEXT,
        offer_code TEXT,
        event_title TEXT,
        event_start TIMESTAMPTZ,
        event_end TIMESTAMPTZ,
        image_url TEXT,
        scheduled_date DATE NOT NULL,
        scheduled_time TIME DEFAULT '09:00',
        status TEXT DEFAULT 'draft',
        published_at TIMESTAMPTZ,
        late_post_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});

    // Blog content system columns
    await client.query(`ALTER TABLE content_queue ADD COLUMN IF NOT EXISTS content_type TEXT DEFAULT 'page'`).catch(() => {});
    await client.query(`ALTER TABLE content_queue ADD COLUMN IF NOT EXISTS share_token TEXT`).catch(() => {});
    await client.query(`ALTER TABLE content_queue ADD COLUMN IF NOT EXISTS client_status TEXT DEFAULT 'not_sent'`).catch(() => {});
    await client.query(`ALTER TABLE content_queue ADD COLUMN IF NOT EXISTS client_name TEXT`).catch(() => {});
    await client.query(`ALTER TABLE content_queue ADD COLUMN IF NOT EXISTS client_email TEXT`).catch(() => {});
    await client.query(`ALTER TABLE content_queue ADD COLUMN IF NOT EXISTS client_comments JSONB DEFAULT '[]'`).catch(() => {});
    await client.query(`ALTER TABLE content_queue ADD COLUMN IF NOT EXISTS client_reviewed_at TIMESTAMPTZ`).catch(() => {});
    await client.query(`ALTER TABLE content_queue ADD COLUMN IF NOT EXISTS target_publish_date DATE`).catch(() => {});
    await client.query(`ALTER TABLE content_queue ADD COLUMN IF NOT EXISTS blog_category TEXT`).catch(() => {});
    await client.query(`ALTER TABLE content_queue ADD COLUMN IF NOT EXISTS blog_tags TEXT[]`).catch(() => {});

    // GBP tasks are manual — no extension automation
    await client.query(`
      UPDATE action_items SET execution_type = 'manual'
      WHERE pillar IN ('gbp_external', 'gbp') AND execution_type = 'extension'
    `).catch(() => {});

    // Clean up stale "running" audits from previous server instance
    await client.query(`UPDATE audits SET status='failed', completed_at=NOW(), audit_data='{"error":"Server restarted during audit"}'::jsonb WHERE status='running'`).catch(() => {});

    console.log('[boot] Database schema initialized');
  } catch (e) {
    console.error('[boot] Schema init error:', e.message);
    throw e;
  } finally {
    client.release();
  }
}

// ==================== 3. AUTH ====================

// Generate JWT token
function generateToken(userId, email) {
  return jwt.sign({ userId, email }, JWT_SECRET, { expiresIn: '30d' });
}

// Auth middleware
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1] || req.query.token;
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    req.auth = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// Whitelist certain paths from auth requirement
function optionalAuth(req, res, next) {
  const whitelistPaths = ['/api/auth/register', '/api/auth/login', '/api/health', '/api/gsc/callback', '/api/gbp/callback'];
  // Allow emergency restore without auth
  if (req.path.match(/\/api\/projects\/\d+\/content-queue\/restore-page\/\d+/)) return next();
  if (whitelistPaths.includes(req.path)) return next();
  // Skip auth for non-API routes (static files, index.html)
  if (!req.path.startsWith('/api/')) return next();
  authMiddleware(req, res, next);
}

// Register
app.post('/api/auth/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, email',
      [email, hash, name || '']
    );
    const user = result.rows[0];
    const token = generateToken(user.id, user.email);
    res.json({ ok: true, user, token });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Email already registered' });
    res.status(500).json({ error: e.message });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const result = await pool.query('SELECT id, email, password_hash, name FROM users WHERE email=$1', [email]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });
    const token = generateToken(user.id, user.email);
    res.json({ ok: true, user: { id: user.id, email: user.email, name: user.name }, token });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Me (get current user)
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, email, name FROM users WHERE id=$1', [req.auth.userId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ user: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Apply optional auth to all routes
app.use(optionalAuth);

// ==================== 4. PROJECTS ====================

// List projects for current user
app.get('/api/projects', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM projects WHERE user_id=$1 ORDER BY created_at DESC',
      [req.auth.userId]
    );
    res.json({ projects: result.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create project
app.post('/api/projects', async (req, res) => {
  const { name, domain, business_name, industry, location, competitors, is_local_business, is_elementor_site, wordpress_url } = req.body;
  if (!name || !domain) return res.status(400).json({ error: 'Name and domain required' });
  try {
    const result = await pool.query(
      `INSERT INTO projects (user_id, name, domain, business_name, industry, location, competitors, is_local_business, is_elementor_site, wordpress_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [req.auth.userId, name, domain, business_name || null, industry || null, location || null, competitors || [], is_local_business !== false, is_elementor_site !== false, wordpress_url || null]
    );
    res.status(201).json({ project: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get project
app.get('/api/projects/:id', async (req, res) => {
  try {
    const userId = req.auth?.userId;
    const query = userId
      ? 'SELECT * FROM projects WHERE id=$1 AND user_id=$2'
      : 'SELECT * FROM projects WHERE id=$1';
    const params = userId ? [req.params.id, userId] : [req.params.id];
    const result = await pool.query(query, params);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    res.json({ project: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update project (accepts both camelCase and snake_case)
app.put('/api/projects/:id', async (req, res) => {
  console.log(`[project-update] PUT /projects/${req.params.id} body keys:`, Object.keys(req.body || {}), 'competitors:', JSON.stringify(req.body?.competitors));
  const b = req.body;
  const name = b.name;
  const domain = b.domain;
  const business_name = b.business_name || b.businessName;
  const industry = b.industry;
  const location = b.location;
  const competitors = b.competitors;
  const service_areas = b.service_areas || b.serviceAreas;
  const is_local_business = b.is_local_business ?? b.isLocalBusiness;
  const is_elementor_site = b.is_elementor_site ?? b.isElementorSite;
  const wordpress_url = b.wordpress_url || b.wordpressUrl;
  const gsc_property = b.gsc_property || b.gscProperty;
  const gbp_location_id = b.gbp_location_id || b.gbpLocationId;
  const gbp_location_name = b.gbp_location_name || b.gbpLocationName;
  const wp_username = b.wp_username || b.wpUsername;
  const wp_app_password = b.wp_app_password || b.wpAppPassword;
  const map_services = b.map_services;
  const map_custom_suburbs = b.map_custom_suburbs;
  const nw_name = b.nw_name;
  const nw_domain = b.nw_domain;
  const nw_industry = b.nw_industry;
  const nw_location = b.nw_location;
  const nw_business_type = b.nw_business_type;
  const nw_notes = b.nw_notes;
  const nw_page_labels = b.nw_page_labels;
  const tone_of_voice = b.tone_of_voice ?? b.toneOfVoice;
  const page_wireframe = b.page_wireframe ?? b.pageWireframe;
  const customer_persona = b.customer_persona ?? b.customerPersona;
  const writer_voice = b.writer_voice ?? b.writerVoice;
  try {
    const result = await pool.query(
      `UPDATE projects
       SET name=COALESCE($2, name), domain=COALESCE($3, domain), business_name=COALESCE($4, business_name),
           industry=COALESCE($5, industry), location=COALESCE($6, location),
           competitors=COALESCE($7::text[], competitors),
           is_local_business=COALESCE($8, is_local_business), is_elementor_site=COALESCE($9, is_elementor_site),
           wordpress_url=COALESCE($10, wordpress_url),
           service_areas=COALESCE($11::jsonb, service_areas),
           gsc_property=COALESCE($12, gsc_property),
           gbp_location_id=COALESCE($13, gbp_location_id),
           gbp_location_name=COALESCE($14, gbp_location_name),
           wp_username=COALESCE($15, wp_username),
           wp_app_password=COALESCE($16, wp_app_password),
           map_services=COALESCE($17, map_services),
           map_custom_suburbs=COALESCE($18, map_custom_suburbs),
           nw_name=COALESCE($19, nw_name),
           nw_domain=COALESCE($20, nw_domain),
           nw_industry=COALESCE($21, nw_industry),
           nw_location=COALESCE($22, nw_location),
           nw_business_type=COALESCE($23, nw_business_type),
           nw_notes=COALESCE($24, nw_notes),
           nw_page_labels=COALESCE($25::jsonb, nw_page_labels),
           tone_of_voice=$26,
           page_wireframe=$27,
           customer_persona=$28,
           writer_voice=$29
       WHERE id=$1
       RETURNING *`,
      [req.params.id, name, domain, business_name, industry, location,
       competitors && Array.isArray(competitors) ? competitors : null,
       is_local_business, is_elementor_site, wordpress_url,
       service_areas ? JSON.stringify(service_areas) : null,
       gsc_property || null, gbp_location_id || null, gbp_location_name || null,
       wp_username || null, wp_app_password || null,
       map_services !== undefined ? map_services : null, map_custom_suburbs !== undefined ? map_custom_suburbs : null,
       nw_name || null, nw_domain || null, nw_industry || null, nw_location || null, nw_business_type || null, nw_notes || null,
       nw_page_labels ? JSON.stringify(nw_page_labels) : null,
       tone_of_voice !== undefined ? tone_of_voice : null,
       page_wireframe !== undefined ? page_wireframe : null,
       customer_persona !== undefined ? customer_persona : null,
       writer_voice !== undefined ? writer_voice : null]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    console.log(`[project-update] Saved project ${req.params.id}, competitors:`, result.rows[0].competitors);
    res.json({ project: result.rows[0] });
  } catch (e) {
    console.error('[project-update] Error:', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

// Delete project
app.delete('/api/projects/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM projects WHERE id=$1 AND user_id=$2 RETURNING id',
      [req.params.id, req.auth.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Haversine distance in km
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Perth suburb GPS coordinates for distance calculation
const SUBURB_GPS = {
  'leeming': { lat: -32.0728, lng: 115.8640 }, 'cannington': { lat: -32.0170, lng: 115.9340 },
  'east cannington': { lat: -32.0100, lng: 115.9500 }, 'ferndale': { lat: -32.0300, lng: 115.9500 },
  'lynwood': { lat: -32.0400, lng: 115.9300 }, 'parkwood': { lat: -32.0450, lng: 115.9150 },
  'queens park': { lat: -32.0050, lng: 115.9400 }, 'riverton': { lat: -32.0350, lng: 115.8940 },
  'rossmoyne': { lat: -32.0380, lng: 115.8700 }, 'shelley': { lat: -32.0280, lng: 115.8800 },
  'willetton': { lat: -32.0530, lng: 115.8890 }, 'wilson': { lat: -32.0230, lng: 115.9100 },
  'canning vale': { lat: -32.0580, lng: 115.9180 }, 'bentley': { lat: -32.0000, lng: 115.9200 },
  'welshpool': { lat: -31.9930, lng: 115.9450 }, 'atwell': { lat: -32.1440, lng: 115.8640 },
  'aubin grove': { lat: -32.1640, lng: 115.8660 }, 'banjup': { lat: -32.1290, lng: 115.8580 },
  'beeliar': { lat: -32.1350, lng: 115.8150 }, 'bibra lake': { lat: -32.0930, lng: 115.8200 },
  'cockburn': { lat: -32.1300, lng: 115.8500 }, 'coogee': { lat: -32.1190, lng: 115.7650 },
  'coolbellup': { lat: -32.0830, lng: 115.8030 }, 'hamilton hill': { lat: -32.0820, lng: 115.7770 },
  'hammond park': { lat: -32.1620, lng: 115.8470 }, 'henderson': { lat: -32.1490, lng: 115.7730 },
  'jandakot': { lat: -32.1050, lng: 115.8700 }, 'lake coogee': { lat: -32.1280, lng: 115.7800 },
  'munster': { lat: -32.1310, lng: 115.7870 }, 'north coogee': { lat: -32.1100, lng: 115.7640 },
  'north lake': { lat: -32.0770, lng: 115.8330 }, 'south lake': { lat: -32.0870, lng: 115.8350 },
  'spearwood': { lat: -32.1050, lng: 115.7830 }, 'success': { lat: -32.1440, lng: 115.8490 },
  'treeby': { lat: -32.1500, lng: 115.8630 }, 'wattleup': { lat: -32.1470, lng: 115.7990 },
  'yangebup': { lat: -32.1220, lng: 115.8140 }, 'murdoch': { lat: -32.0660, lng: 115.8430 },
  'perth': { lat: -31.9505, lng: 115.8605 }, 'fremantle': { lat: -32.0569, lng: 115.7439 },
  'joondalup': { lat: -31.7467, lng: 115.7672 }, 'midland': { lat: -31.8893, lng: 116.0108 },
  'armadale': { lat: -32.1531, lng: 116.0107 }, 'rockingham': { lat: -32.2833, lng: 115.7333 },
  'mandurah': { lat: -32.5269, lng: 115.7217 }, 'stirling': { lat: -31.8833, lng: 115.8333 },
  'claremont': { lat: -31.9803, lng: 115.7814 }, 'subiaco': { lat: -31.9490, lng: 115.8270 },
  'nedlands': { lat: -31.9800, lng: 115.8060 }, 'cottesloe': { lat: -31.9930, lng: 115.7640 },
  'mosman park': { lat: -32.0070, lng: 115.7630 }, 'peppermint grove': { lat: -31.9990, lng: 115.7690 },
  'cambridge': { lat: -31.9370, lng: 115.7930 }, 'victoria park': { lat: -31.9760, lng: 115.8990 },
  'south perth': { lat: -31.9720, lng: 115.8640 }, 'como': { lat: -31.9910, lng: 115.8610 },
  'bayswater': { lat: -31.9160, lng: 115.9150 }, 'bassendean': { lat: -31.9030, lng: 115.9470 },
  'belmont': { lat: -31.9530, lng: 115.9360 }, 'kalamunda': { lat: -31.9750, lng: 116.0580 },
  'mundaring': { lat: -31.9020, lng: 116.1690 }, 'swan': { lat: -31.7930, lng: 116.0260 },
  'gosnells': { lat: -32.0810, lng: 115.9810 }, 'serpentine': { lat: -32.3580, lng: 115.9810 },
  'jarrahdale': { lat: -32.3380, lng: 116.0570 }, 'byford': { lat: -32.2240, lng: 116.0040 },
  'wanneroo': { lat: -31.7500, lng: 115.8000 }, 'alkimos': { lat: -31.6280, lng: 115.7250 },
  'beaconsfield': { lat: -32.0560, lng: 115.7640 }, 'melville': { lat: -32.0440, lng: 115.7860 },
  'kwinana': { lat: -32.2400, lng: 115.7700 }, 'vincent': { lat: -31.9330, lng: 115.8500 },
};

// Get/set service areas for a project
app.get('/api/projects/:id/service-areas', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT service_areas, location FROM projects WHERE id=$1 AND user_id=$2',
      [req.params.id, req.auth.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const areas = result.rows[0].service_areas || [];
    const rawLocation = (result.rows[0].location || '').trim();
    // Try to match project location to SUBURB_GPS — handle "Cannington, WA", "Cannington Perth" etc.
    const locParts = rawLocation.toLowerCase().replace(/[,]/g, ' ').split(/\s+/).filter(Boolean);
    let hqGps = null;
    // Try full string first, then first word, then first two words
    const candidates = [
      rawLocation.toLowerCase().trim(),
      locParts[0],
      locParts.slice(0, 2).join(' '),
      locParts.slice(0, 3).join(' '),
    ].filter(Boolean);
    for (const candidate of candidates) {
      if (SUBURB_GPS[candidate]) { hqGps = SUBURB_GPS[candidate]; break; }
    }
    if (hqGps) {
      for (const area of areas) {
        const subGps = SUBURB_GPS[area.name.toLowerCase().trim()];
        if (subGps) {
          area.distance = Math.round(haversineKm(hqGps.lat, hqGps.lng, subGps.lat, subGps.lng) * 10) / 10;
        }
      }
    }
    console.log(`[service-areas] project location="${rawLocation}", hq matched=${!!hqGps}, areas=${areas.length}`);
    res.json({ service_areas: areas, hq_location: rawLocation, hq_found: !!hqGps });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects/:id/service-areas', async (req, res) => {
  const { service_areas } = req.body;
  if (!Array.isArray(service_areas)) return res.status(400).json({ error: 'service_areas must be array' });
  try {
    const result = await pool.query(
      'UPDATE projects SET service_areas=$1 WHERE id=$2 AND user_id=$3 RETURNING service_areas',
      [JSON.stringify(service_areas), req.params.id, req.auth.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    res.json({ service_areas: result.rows[0].service_areas });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== 5. INTEGRATIONS ====================

// Get all integrations for a project
app.get('/api/projects/:id/integrations', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT kind, config, status FROM project_integrations WHERE project_id=$1',
      [req.params.id]
    );
    const integrations = {};
    result.rows.forEach(row => {
      integrations[row.kind] = { config: row.config || {}, status: row.status };
    });
    res.json({ integrations });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update integration for a project
app.put('/api/projects/:id/integrations/:kind', async (req, res) => {
  const { config, status } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO project_integrations (project_id, kind, config, status, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (project_id, kind) DO UPDATE SET config=$3, status=$4, updated_at=NOW()
       RETURNING kind, config, status`,
      [req.params.id, req.params.kind, JSON.stringify(config || {}), status || 'connected']
    );
    res.json({ integration: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Test integration connection
app.post('/api/projects/:id/integrations/:kind/test', async (req, res) => {
  try {
    const r = await pool.query('SELECT config, status FROM project_integrations WHERE project_id=$1 AND kind=$2', [req.params.id, req.params.kind]);
    if (r.rows.length === 0) return res.status(400).json({ error: 'Not configured — save credentials first' });
    const { config, status } = r.rows[0];
    const cfg = typeof config === 'string' ? JSON.parse(config) : (config || {});

    if (req.params.kind === 'serpapi') {
      if (!cfg.apiKey) return res.status(400).json({ error: 'API key required' });
      const resp = await fetch(`https://serpapi.com/search.json?engine=google&q=test&api_key=${cfg.apiKey}&num=1`);
      if (resp.ok) {
        const data = await resp.json();
        return res.json({ ok: true, message: `SerpAPI connected — ${data.search_metadata?.status || 'OK'}` });
      }
      const text = await resp.text();
      return res.status(400).json({ error: text.substring(0, 200) || 'Invalid API key' });
    }

    if (req.params.kind === 'localfalcon') {
      if (!cfg.apiKey) return res.status(400).json({ error: 'API key required' });
      const resp = await fetch(`https://api.localfalcon.com/v1/reports?api_key=${cfg.apiKey}`);
      const data = await resp.json();
      if (data.success || resp.ok) return res.json({ ok: true, message: `Local Falcon connected — ${(data.data || []).length} reports found` });
      return res.status(400).json({ error: data.message || 'Invalid API key' });
    }

    if (req.params.kind === 'wordpress') {
      if (!cfg.url || !cfg.username || !cfg.appPassword) return res.status(400).json({ error: 'URL, username, and app password required' });
      const wpUrl = cfg.url.replace(/\/wp-admin\/?$/, '').replace(/\/$/, '');
      const authHeader = 'Basic ' + Buffer.from(`${cfg.username}:${cfg.appPassword}`).toString('base64');
      const resp = await fetch(`${wpUrl}/wp-json/wp/v2/users/me`, {
        headers: { Authorization: authHeader }
      });
      if (resp.ok) {
        const user = await resp.json();
        return res.json({ ok: true, message: `WordPress connected as ${user.name || user.slug}` });
      }
      return res.status(400).json({ error: `WordPress auth failed (${resp.status})` });
    }

    res.json({ ok: true, message: 'Connection stored' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== 6. AUDITS ====================

// Trigger an audit (GBP, GSC, or Website)
app.post('/api/projects/:id/audit/:pillar', async (req, res) => {
  const { pillar } = req.params;
  if (!['gbp', 'gsc', 'website'].includes(pillar)) {
    return res.status(400).json({ error: 'pillar must be gbp, gsc, or website' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO audits (project_id, pillar, status) VALUES ($1, $2, 'queued') RETURNING *`,
      [req.params.id, pillar]
    );
    // TODO: Enqueue agent job to execute audit asynchronously
    res.status(202).json({ audit: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List audits for a project
app.get('/api/projects/:id/audits', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM audits WHERE project_id=$1 ORDER BY created_at DESC',
      [req.params.id]
    );
    res.json({ audits: result.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List findings for a project — with category + pillar normalization
app.get('/api/projects/:id/audit-findings', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM audit_findings WHERE project_id=$1 ORDER BY created_at DESC',
      [req.params.id]
    );

    const PILLAR_MAP = {
      gbp_external: 'gbp_external', gbp: 'gbp_external',
      gsc_agent: 'gsc_agent', gsc: 'gsc_agent',
      website: 'website', technical: 'website',
    };
    const PILLAR_DISPLAY = { gbp_external: 'GBP', gsc_agent: 'GSC', website: 'Website' };
    const VALID_CATS = {
      GBP: ['Profile Completeness', 'NAP Consistency', 'Reviews & Reputation', 'Competitor Analysis', 'Directory & Citations', 'Photos & Media', 'Suburb Coverage'],
      GSC: ['Quick Wins', 'Low CTR Pages', 'Cannibalization', 'Zero-Click Pages', 'Underperforming Pages'],
      Website: ['Site Health', 'Crawlability', 'On-Page Issues', 'Content Quality', 'Core Web Vitals', 'Schema & Data'],
    };
    const ALIASES = {
      'quick win': 'Quick Wins', 'quick wins': 'Quick Wins',
      'low ctr': 'Low CTR Pages', 'low ctr page': 'Low CTR Pages', 'low ctr pages': 'Low CTR Pages',
      'zero click': 'Zero-Click Pages', 'zero clicks': 'Zero-Click Pages', 'zero-click page': 'Zero-Click Pages', 'zero-click pages': 'Zero-Click Pages',
      'underperforming page': 'Underperforming Pages', 'underperforming pages': 'Underperforming Pages', 'underperforming': 'Underperforming Pages',
      'cannibalization': 'Cannibalization', 'keyword cannibalization': 'Cannibalization',
      'nap': 'NAP Consistency', 'nap consistency': 'NAP Consistency',
      'profile': 'Profile Completeness', 'profile completeness': 'Profile Completeness',
      'reviews': 'Reviews & Reputation', 'reputation': 'Reviews & Reputation', 'reviews & reputation': 'Reviews & Reputation',
      'competitor': 'Competitor Analysis', 'competitors': 'Competitor Analysis', 'competitor analysis': 'Competitor Analysis',
      'directory': 'Directory & Citations', 'directories': 'Directory & Citations', 'citations': 'Directory & Citations', 'directory & citations': 'Directory & Citations',
      'photos': 'Photos & Media', 'media': 'Photos & Media', 'photos & media': 'Photos & Media',
      'suburb': 'Suburb Coverage', 'suburbs': 'Suburb Coverage', 'suburb coverage': 'Suburb Coverage', 'service area': 'Suburb Coverage', 'service areas': 'Suburb Coverage',
      'schema': 'Schema & Data', 'structured data': 'Schema & Data', 'schema & data': 'Schema & Data',
      'on-page': 'On-Page Issues', 'on page': 'On-Page Issues', 'on-page issues': 'On-Page Issues', 'on_page': 'On-Page Issues', 'meta': 'On-Page Issues',
      'content': 'Content Quality', 'content quality': 'Content Quality', 'thin content': 'Content Quality',
      'cwv': 'Core Web Vitals', 'core web vitals': 'Core Web Vitals', 'performance': 'Core Web Vitals', 'speed': 'Core Web Vitals',
      'crawl': 'Crawlability', 'crawlability': 'Crawlability', 'robots': 'Crawlability', 'sitemap': 'Crawlability',
      'site health': 'Site Health', 'broken links': 'Site Health', '404': 'Site Health', 'security': 'Site Health', 'mobile': 'Site Health', 'structure': 'Site Health', 'links': 'Crawlability',
      'indexing': 'Crawlability', 'indexing issues': 'Crawlability',
      'brand dependency': 'Quick Wins', 'manual': null,
      // GBP internal "Pillar > Sub" mappings
      'proximity > maps ranking': 'Suburb Coverage', 'proximity > geo-targeting': 'Suburb Coverage', 'proximity > service areas': 'Suburb Coverage',
      'prominence > social profiles': 'Profile Completeness', 'prominence > reviews': 'Reviews & Reputation',
      'prominence > citations': 'Directory & Citations', 'prominence > photos': 'Photos & Media',
      'relevance > description': 'Profile Completeness', 'relevance > profile completeness': 'Profile Completeness',
      'relevance > posts & updates': 'Profile Completeness', 'relevance > categories & services': 'Profile Completeness',
    };

    function normCat(rawCat, pillarDisplay) {
      const cat = (rawCat || '').toLowerCase().trim();
      const validCats = VALID_CATS[pillarDisplay] || [];
      if (validCats.find(c => c.toLowerCase() === cat)) return validCats.find(c => c.toLowerCase() === cat);
      if (ALIASES[cat] !== undefined) {
        if (ALIASES[cat] === null) return null; // drop "manual" etc
        if (validCats.includes(ALIASES[cat])) return ALIASES[cat];
        // alias exists but wrong pillar — still return it
        return ALIASES[cat];
      }
      const wordMatch = validCats.find(c => {
        const words = c.toLowerCase().split(/[\s&-]+/).filter(w => w.length > 3);
        return words.some(w => cat.includes(w));
      });
      if (wordMatch) return wordMatch;
      return validCats[0] || rawCat || 'General';
    }

    const findings = result.rows.map(f => {
      const normPillar = PILLAR_MAP[(f.pillar || '').toLowerCase()] || f.pillar;
      const display = PILLAR_DISPLAY[normPillar] || 'Website';
      const normCategory = normCat(f.category, display);
      if (normCategory === null) return null; // drop junk
      return { ...f, pillar: normPillar, category: normCategory };
    }).filter(Boolean);

    res.json({ findings });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update finding status (approve/reject) — auto-creates action item on approve
app.put('/api/audit-findings/:id', async (req, res) => {
  const { status } = req.body;
  try {
    const result = await pool.query(
      'UPDATE audit_findings SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING *',
      [status, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Finding not found' });
    const finding = result.rows[0];

    let actionItem = null;
    if (status === 'approved') {
      // Auto-create action item from this finding
      const existing = await pool.query('SELECT id FROM action_items WHERE finding_id=$1', [finding.id]);
      if (existing.rows.length === 0) {
        const aiRes = await pool.query(
          `INSERT INTO action_items (project_id, finding_id, pillar, type, title, description, current_value, new_value, severity, status, execution_type)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10) RETURNING *`,
          [finding.project_id, finding.id, finding.pillar, finding.category || 'general',
           finding.title, finding.recommendation || finding.description,
           finding.current_value, finding.recommended_value, finding.severity,
           // Auto-detect execution type based on category
           ['Quick Win', 'Low CTR', 'Underperforming Page'].includes(finding.category) ? 'semi_auto' : 'manual']
        );
        actionItem = aiRes.rows[0];
        console.log(`[action] Created action item #${actionItem.id} from finding #${finding.id} (${finding.pillar}/${finding.category})`);
      }
    }

    res.json({ finding, actionItem });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== 7. ACTION PLAN ====================

// Get action items for a project (optional ?pillar= filter)
app.get('/api/projects/:id/action-items', async (req, res) => {
  try {
    const { pillar } = req.query;
    let query = 'SELECT * FROM action_items WHERE project_id=$1';
    const params = [req.params.id];
    if (pillar) {
      query += ' AND pillar=$2';
      params.push(pillar);
    }
    query += ' ORDER BY created_at DESC';
    const result = await pool.query(query, params);
    res.json({ action_items: result.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create action item directly (from external audit)
app.post('/api/projects/:id/action-items', async (req, res) => {
  const { pillar, type, title, description, severity, current_value, new_value, category, execution_type } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO action_items (project_id, pillar, type, title, description, severity, current_value, new_value, category, status, execution_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10) RETURNING *`,
      [req.params.id, pillar || 'gbp_external', type || 'external_audit', title, description, severity || 'medium', current_value || null, new_value || null, category || type || 'general', execution_type || 'manual']
    );
    res.json({ action_item: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update action item (status, execution_type) — cascades to duplicates
app.put('/api/action-items/:id', async (req, res) => {
  const { status, approved_at, execution_type, assignee_label, duplicate_ids } = req.body;
  try {
    const result = await pool.query(
      `UPDATE action_items
       SET status=COALESCE($1, status), approved_at=COALESCE($2, approved_at), execution_type=COALESCE($3, execution_type), assignee_label=COALESCE($4, assignee_label)
       WHERE id=$5 RETURNING *`,
      [status || null, approved_at || null, execution_type || null, assignee_label || null, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Action item not found' });

    // When done → mark linked finding as resolved
    if ((status === 'done' || status === 'completed') && result.rows[0].finding_id) {
      await pool.query(`UPDATE audit_findings SET status='resolved' WHERE id=$1`, [result.rows[0].finding_id]);
      console.log(`[action-items] Marked finding ${result.rows[0].finding_id} as resolved`);
    }

    // Cascade status to duplicate action items
    let cascaded = 0;
    if (status && duplicate_ids && Array.isArray(duplicate_ids) && duplicate_ids.length > 0) {
      const cascadeResult = await pool.query(
        `UPDATE action_items SET status=$1 WHERE id = ANY($2::int[]) RETURNING id`,
        [status, duplicate_ids]
      );
      cascaded = cascadeResult.rowCount;
      if (status === 'done' || status === 'completed') {
        await pool.query(
          `UPDATE audit_findings SET status='resolved' WHERE id IN (
            SELECT finding_id FROM action_items WHERE id = ANY($1::int[]) AND finding_id IS NOT NULL
          )`, [duplicate_ids]
        );
      }
      console.log(`[action-items] Cascaded status '${status}' to ${cascaded} duplicate items`);
    }

    res.json({ action_item: result.rows[0], cascaded });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Split a multi-location action item into individual items
app.post('/api/action-items/:id/split', async (req, res) => {
  try {
    const original = (await pool.query('SELECT * FROM action_items WHERE id=$1', [req.params.id])).rows[0];
    if (!original) return res.status(404).json({ error: 'Not found' });

    const title = original.title || '';
    const multiMatch = title.match(/^(.+?)\s+(?:for|:)\s+(.+)$/i);
    if (!multiMatch) return res.status(400).json({ error: 'Cannot detect multiple locations in title' });

    const baseTitle = multiMatch[1].trim();
    const locations = multiMatch[2].split(/\s*[+&,]\s*|\s+and\s+/i).map(s => s.trim()).filter(Boolean);
    if (locations.length < 2) return res.status(400).json({ error: 'Only one location detected' });

    const created = [];
    for (const loc of locations) {
      const newTitle = `${baseTitle} for ${loc}`;
      const newDesc = (original.description || '').replace(multiMatch[2], loc);
      const r = await pool.query(
        `INSERT INTO action_items (project_id, finding_id, pillar, type, category, title, description, current_value, new_value, severity, status, execution_type, assignee_label)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [original.project_id, original.finding_id, original.pillar, original.type, original.category,
         newTitle, newDesc, original.current_value, original.new_value, original.severity,
         'pending', original.execution_type, original.assignee_label]
      );
      created.push(r.rows[0]);
    }

    // Delete the original combined item + its content_queue entry
    await pool.query('DELETE FROM content_queue WHERE page_title=$1 AND project_id=$2', [original.title, original.project_id]);
    await pool.query('DELETE FROM action_items WHERE id=$1', [original.id]);

    res.json({ split: locations.length, created });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Generate how-to instructions for a manual action item
app.get('/api/action-items/:id/how-to', async (req, res) => {
  try {
    const item = (await pool.query(
      `SELECT ai.*, p.business_name, p.domain, p.location FROM action_items ai JOIN projects p ON ai.project_id = p.id WHERE ai.id=$1`, [req.params.id]
    )).rows[0];
    if (!item) return res.status(404).json({ error: 'Action item not found' });

    // Check if we already have cached instructions
    if (item.how_to_steps) return res.json({ steps: item.how_to_steps });

    const aiResp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 800,
      messages: [{ role: 'user', content: `You are an SEO expert assistant. Generate clear, actionable step-by-step instructions for this task.

Task: ${item.title}
Details: ${item.description || ''}
Category: ${item.category || ''}
Business: ${item.business_name || ''} (${item.domain || ''}) in ${item.location || 'Australia'}

Return 3-7 numbered steps. Be specific — include exact URLs (always with https://) to visit, buttons to click, fields to fill. Keep each step to 1-2 sentences. If there's a direct link, include it. Format as plain numbered list, no markdown headers.` }]
    });

    const steps = aiResp.content[0].text.trim();
    // Cache it
    await pool.query('UPDATE action_items SET how_to_steps=$1 WHERE id=$2', [steps, req.params.id]);
    res.json({ steps });
  } catch (e) {
    console.error('[how-to]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Execute action item
app.post('/api/action-items/:id/execute', async (req, res) => {
  const { id } = req.params;
  try {
    const itemResult = await pool.query('SELECT * FROM action_items WHERE id=$1', [id]);
    if (itemResult.rows.length === 0) return res.status(404).json({ error: 'Action item not found' });
    const item = itemResult.rows[0];

    // TODO: Execute based on item.execution_type (api, semi_auto, manual)
    // Update execution_log with results
    const result = await pool.query(
      `UPDATE action_items
       SET status='in_progress', executed_at=NOW(), execution_log=jsonb_build_object('attempted_at', NOW())
       WHERE id=$1 RETURNING *`,
      [id]
    );
    res.json({ action_item: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ==================== EXTENSION TASK QUEUE ====================

// Get pending extension tasks (polled by Chrome extension every 30s)
app.get('/api/extension/tasks', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ai.*, p.domain, p.business_name, p.gbp_location_id, p.gbp_location_name
       FROM action_items ai
       JOIN projects p ON p.id = ai.project_id
       WHERE ai.execution_type = 'extension' AND ai.status = 'in_progress'
       ORDER BY ai.created_at ASC LIMIT 5`
    );
    res.json({ tasks: result.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Claim a task (extension marks it as being worked on)
app.post('/api/extension/tasks/:id/claim', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE action_items
       SET execution_log = COALESCE(execution_log, '{}'::jsonb) || jsonb_build_object('claimed_at', to_char(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'claimed_by', 'chrome_extension')
       WHERE id = $1 AND execution_type = 'extension' AND status = 'in_progress'
       RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Task not found or not claimable' });
    res.json({ task: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Report task result (extension reports success/failure)
app.post('/api/extension/tasks/:id/result', async (req, res) => {
  const { success, before_state, after_state, error: taskError } = req.body;
  try {
    const newStatus = success ? 'done' : 'failed';
    const logEntry = {
      completed_at: new Date().toISOString(),
      success,
      before_state: before_state || null,
      after_state: after_state || null,
      error: taskError || null
    };
    const result = await pool.query(
      `UPDATE action_items
       SET status = $1,
           execution_log = COALESCE(execution_log, '{}'::jsonb) || $2::jsonb
       WHERE id = $3 RETURNING *`,
      [newStatus, JSON.stringify(logEntry), req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Task not found' });
    res.json({ task: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Report task progress (extension sends step updates)
app.post('/api/extension/tasks/:id/progress', async (req, res) => {
  const { step, total, description } = req.body;
  try {
    const logEntry = { progress: { step, total, description, updated_at: new Date().toISOString() } };
    const result = await pool.query(
      `UPDATE action_items
       SET execution_log = COALESCE(execution_log, '{}'::jsonb) || $1::jsonb
       WHERE id = $2 RETURNING *`,
      [JSON.stringify(logEntry), req.params.id]
    );
    res.json({ task: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== ORCHESTRATOR ====================

// Get all action items grouped by pillar + category, with deduplication
app.get('/api/projects/:id/orchestrator', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ai.*, af.recommendation as finding_recommendation, af.audit_id
       FROM action_items ai
       LEFT JOIN audit_findings af ON ai.finding_id = af.id
       WHERE ai.project_id = $1
       ORDER BY
         CASE ai.severity WHEN 'Critical' THEN 1 WHEN 'High' THEN 2 WHEN 'Medium' THEN 3 WHEN 'Low' THEN 4 ELSE 5 END,
         ai.created_at DESC`,
      [req.params.id]
    );

    const items = result.rows;

    // Count how many times each title appears (source count for trust scoring)
    const titleCounts = {};
    for (const item of items) {
      const key = (item.title || '').toLowerCase().trim();
      titleCounts[key] = (titleCounts[key] || 0) + 1;
    }

    // No dedup — frontend sync is the source of truth and produces clean, non-duplicate data.
    // Sort so orchestrator items (have assignee_label) come first
    const deduped = [...items].sort((a, b) => {
      if (a.assignee_label && !b.assignee_label) return -1;
      if (!a.assignee_label && b.assignee_label) return 1;
      return new Date(b.created_at) - new Date(a.created_at);
    });
    deduped.forEach(item => { item.duplicate_ids = []; item.is_duplicate = false; });

    // Trust scoring
    const HIGH_IMPACT_KEYWORDS = /ranking|position|index|crawl|canonical|redirect|404|broken|duplicate|title|meta|h1|schema|speed|lcp|cls|conversion|ctr|traffic/i;
    function computeTrustScore(item) {
      let score = 0;
      // Severity weight
      const sev = (item.severity || '').toLowerCase();
      if (sev === 'critical') score += 10;
      else if (sev === 'medium') score += 5;
      else if (sev === 'low') score += 2;
      else score += 3;
      // Source count: flagged by multiple audits = higher trust
      const sources = titleCounts[(item.title || '').toLowerCase().trim()] || 1;
      score += Math.min(sources - 1, 3) * 2; // +2 per extra source, max +6
      // Impact keywords in title or description
      const text = `${item.title || ''} ${item.description || ''}`;
      if (HIGH_IMPACT_KEYWORDS.test(text)) score += 3;
      // Quick win bonus: has both current and target values (actionable)
      if (item.current_value && item.new_value) score += 2;
      // Has a linked finding (agent-sourced = more trustworthy)
      if (item.finding_id) score += 1;
      return score;
    }

    // Score all items and sort within groups
    for (const item of deduped) {
      item.trust_score = computeTrustScore(item);
    }

    // Normalize pillar names for grouping display
    const pillarDisplayMap = {
      gbp: 'GBP', gbp_external: 'GBP',
      gsc: 'GSC', gsc_agent: 'GSC',
      website: 'Website', technical: 'Website',
    };

    // Category normalization for display
    const DISPLAY_PILLAR_CATS = {
      GBP: ['Profile Completeness', 'NAP Consistency', 'Reviews & Reputation', 'Competitor Analysis', 'Directory & Citations', 'Photos & Media', 'Suburb Coverage'],
      GSC: ['Quick Wins', 'Low CTR Pages', 'Cannibalization', 'Zero-Click Pages', 'Underperforming Pages'],
      Website: ['Site Health', 'Crawlability', 'On-Page Issues', 'Content Quality', 'Core Web Vitals', 'Schema & Data'],
    };
    const CAT_ALIASES = {
      'quick win': 'Quick Wins', 'quick wins': 'Quick Wins',
      'low ctr': 'Low CTR Pages', 'low ctr page': 'Low CTR Pages', 'low ctr pages': 'Low CTR Pages',
      'zero click': 'Zero-Click Pages', 'zero clicks': 'Zero-Click Pages', 'zero-click page': 'Zero-Click Pages', 'zero-click pages': 'Zero-Click Pages',
      'underperforming page': 'Underperforming Pages', 'underperforming pages': 'Underperforming Pages', 'underperforming': 'Underperforming Pages',
      'cannibalization': 'Cannibalization', 'keyword cannibalization': 'Cannibalization',
      'nap': 'NAP Consistency', 'nap consistency': 'NAP Consistency',
      'profile': 'Profile Completeness', 'profile completeness': 'Profile Completeness',
      'reviews': 'Reviews & Reputation', 'reputation': 'Reviews & Reputation', 'reviews & reputation': 'Reviews & Reputation',
      'competitor': 'Competitor Analysis', 'competitors': 'Competitor Analysis', 'competitor analysis': 'Competitor Analysis',
      'directory': 'Directory & Citations', 'directories': 'Directory & Citations', 'citations': 'Directory & Citations', 'directory & citations': 'Directory & Citations',
      'photos': 'Photos & Media', 'media': 'Photos & Media', 'photos & media': 'Photos & Media',
      'suburb': 'Suburb Coverage', 'suburbs': 'Suburb Coverage', 'suburb coverage': 'Suburb Coverage', 'service area': 'Suburb Coverage',
      'schema': 'Schema & Data', 'structured data': 'Schema & Data', 'schema & data': 'Schema & Data',
      'on-page': 'On-Page Issues', 'on page': 'On-Page Issues', 'on-page issues': 'On-Page Issues', 'meta': 'On-Page Issues',
      'content': 'Content Quality', 'content quality': 'Content Quality', 'thin content': 'Content Quality',
      'cwv': 'Core Web Vitals', 'core web vitals': 'Core Web Vitals', 'performance': 'Core Web Vitals', 'speed': 'Core Web Vitals',
      'crawl': 'Crawlability', 'crawlability': 'Crawlability', 'robots': 'Crawlability', 'sitemap': 'Crawlability',
      'site health': 'Site Health', 'broken links': 'Site Health', '404': 'Site Health',
      'indexing': 'Crawlability', 'indexing issues': 'Crawlability',
      'brand dependency': 'Quick Wins',
    };
    function normalizeCategory(rawCat, displayPillar) {
      const cat = (rawCat || '').toLowerCase().trim();
      const validCats = DISPLAY_PILLAR_CATS[displayPillar] || [];
      // Exact match
      if (validCats.find(c => c.toLowerCase() === cat)) return validCats.find(c => c.toLowerCase() === cat);
      // Alias
      if (CAT_ALIASES[cat] && validCats.includes(CAT_ALIASES[cat])) return CAT_ALIASES[cat];
      // Partial word match
      const wordMatch = validCats.find(c => {
        const words = c.toLowerCase().split(/[\s&-]+/).filter(w => w.length > 3);
        return words.some(w => cat.includes(w));
      });
      if (wordMatch) return wordMatch;
      // Default to first valid category
      return validCats[0] || rawCat || 'General';
    }

    // Group by display pillar → category, sorted by trust score desc
    const grouped = {};
    for (const item of deduped) {
      const displayPillar = pillarDisplayMap[item.pillar] || item.pillar;
      const rawCategory = item.category || item.type || 'General';
      const category = normalizeCategory(rawCategory, displayPillar);
      if (!grouped[displayPillar]) grouped[displayPillar] = {};
      if (!grouped[displayPillar][category]) grouped[displayPillar][category] = [];
      grouped[displayPillar][category].push(item);
    }
    // Sort each category by trust_score descending
    for (const pillar of Object.values(grouped)) {
      for (const cat of Object.keys(pillar)) {
        pillar[cat].sort((a, b) => (b.trust_score || 0) - (a.trust_score || 0));
      }
    }

    // Stats
    const allScores = deduped.map(i => i.trust_score || 0);
    const stats = {
      total: deduped.length,
      pending: deduped.filter(i => i.status === 'pending').length,
      in_progress: deduped.filter(i => i.status === 'in-progress' || i.status === 'in_progress' || i.status === 'approved').length,
      done: deduped.filter(i => i.status === 'done' || i.status === 'completed').length,
      critical: deduped.filter(i => (i.severity || '').toLowerCase() === 'critical').length,
      medium: deduped.filter(i => (i.severity || '').toLowerCase() === 'medium').length,
      low: deduped.filter(i => (i.severity || '').toLowerCase() === 'low').length,
      duplicates_removed: items.length - deduped.length,
      avg_score: allScores.length ? Math.round(allScores.reduce((a, b) => a + b, 0) / allScores.length) : 0,
      max_score: allScores.length ? Math.max(...allScores) : 0,
    };

    res.json({ grouped, stats, total_raw: items.length, total_deduped: deduped.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Sync all pillars at once (for orchestrator)
// ==================== AI ORCHESTRATOR — intelligent cross-audit action plan ====================
app.post('/api/projects/:projectId/orchestrator/run', async (req, res) => {
  const { projectId } = req.params;

  try {
    const proj = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    if (proj.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = proj.rows[0];

    // Gather all completed audit reports
    const auditPillars = ['gbp_external', 'gsc_agent', 'website'];
    const reports = {};
    for (const pillar of auditPillars) {
      const auditRes = await pool.query(
        `SELECT id, audit_data, completed_at FROM audits WHERE project_id=$1 AND pillar=$2 AND status='completed' ORDER BY completed_at DESC LIMIT 1`,
        [projectId, pillar]
      );
      if (auditRes.rows.length > 0) {
        const data = typeof auditRes.rows[0].audit_data === 'string' ? JSON.parse(auditRes.rows[0].audit_data) : auditRes.rows[0].audit_data;
        const reportText = data?.report || data?.final_report || '';
        if (reportText) {
          reports[pillar] = { text: reportText, auditId: auditRes.rows[0].id, completedAt: auditRes.rows[0].completed_at };
        }
      }
    }

    if (Object.keys(reports).length === 0) {
      return res.status(400).json({ error: 'No completed audits found. Run at least one audit first.' });
    }

    console.log(`[orchestrator] Running AI orchestrator for project ${projectId} with ${Object.keys(reports).length} audit reports`);
    // Track orchestrator status in-memory
    if (!global._orchestratorStatus) global._orchestratorStatus = {};
    global._orchestratorStatus[projectId] = { status: 'running', startedAt: Date.now(), error: null, itemCount: 0 };
    res.json({ status: 'running', pillars: Object.keys(reports) });

    // Run async — deterministic orchestrator
    (async () => {
      try {
        // ========== DETERMINISTIC ORCHESTRATOR — findings → action items (no AI, no truncation) ==========
        console.log(`[orchestrator] Creating action items from audit findings (deterministic)...`);

        // Re-extract findings only for pillars with 0 findings in DB (new audits auto-extract at completion)
        for (const pillar of auditPillars) {
          const reportText = reports[pillar]?.text;
          const auditId = reports[pillar]?.auditId;
          if (!reportText || !auditId) continue;
          const existingCount = await pool.query('SELECT COUNT(*) FROM audit_findings WHERE project_id=$1 AND pillar=$2', [projectId, pillar]);
          const count = parseInt(existingCount.rows[0].count);
          if (count > 0) {
            console.log(`[orchestrator] ${pillar} already has ${count} findings in DB, skipping re-extraction`);
            continue;
          }
          try {
            console.log(`[orchestrator] Extracting findings from ${pillar} report (audit ${auditId}, ${reportText.length} chars)...`);
            const extracted = await extractFindingsFromReport(reportText, pillar, projectId, auditId);
            console.log(`[orchestrator] Extracted ${extracted.length} findings from ${pillar}`);
          } catch (e) {
            console.error(`[orchestrator] Failed to extract ${pillar} findings:`, e.message);
          }
        }
        // Reload ALL findings after re-extraction
        const refreshedResult = await pool.query('SELECT * FROM audit_findings WHERE project_id=$1 ORDER BY created_at DESC', [projectId]);
        const allFindings = refreshedResult.rows;
        console.log(`[orchestrator] Total findings after re-extraction: ${allFindings.length}`);

        // Classification: Automated, Copywriter, or Manual
        // AUTOMATED = system can actually execute it (Yoast meta, schema, redirects, compression, robots, sitemap)
        // COPYWRITER = website content tasks only (writing, rewriting, meta, headings, alt text)
        // MANUAL = everything else (GBP, directories, physical actions, external sites)
        function assignItem(finding) {
          const t = ((finding.title || '') + ' ' + (finding.description || '') + ' ' + (finding.category || '')).toLowerCase();
          const cat = (finding.category || '').toLowerCase();
          const pillar = (finding.pillar || '').toLowerCase();

          // --- GBP: Copywriter for content tasks, Manual for everything else ---
          if (pillar.includes('gbp')) {
            if (/\b(description|write|post|respond.*review|reply.*review|review.*response|create.*post|weekly.*post|content|caption|update.*description|expand.*description|business.*description)\b/.test(t)) return { assignee: 'Copywriter', execType: 'copywriter' };
            if (/\b(photo.*caption|add.*photo.*desc|service.*desc|product.*desc)\b/.test(t)) return { assignee: 'Copywriter', execType: 'copywriter' };
            if (/\b(create.*page|add.*page|suburb.*page|service.*area.*page|landing.*page|keyword)\b/.test(t)) return { assignee: 'Copywriter', execType: 'copywriter' };
            return { assignee: 'Manual', execType: 'manual' };
          }

          // --- AUTOMATED: only things seoroom-helper plugin or WP REST API can execute ---
          // Core Web Vitals — all can be attempted via seoroom-helper (preconnect, defer, preload, etc.)
          if (cat === 'core web vitals') return { assignee: 'Automated', execType: 'automated' };
          // Schema/structured data — inject JSON-LD via seoroom-helper custom_snippet
          // Match category OR specific schema type names in title/description
          if (cat === 'schema & data' || cat === 'schema') return { assignee: 'Automated', execType: 'automated' };
          if (/\b(schema|structured.?data|json.?ld|rich.?snippet|faqpage|localbusiness|aggregaterating|itemlist|howto|searchaction|breadcrumb|service.?schema|review.?schema)\b/.test(t)) return { assignee: 'Automated', execType: 'automated' };
          // Image lazy loading / format hints
          if (/\b(lazy.?load|image.?dimension|fetchpriority)\b/.test(t)) return { assignee: 'Automated', execType: 'automated' };
          // Font loading optimizations
          if (/\b(font.?display|font.?swap|preconnect.*font|font.*preconnect)\b/.test(t)) return { assignee: 'Automated', execType: 'automated' };
          // Script defer/delay (third-party, render-blocking)
          if (/\b(defer.?script|delay.?script|render.?block|third.?party.*script)\b/.test(t)) return { assignee: 'Automated', execType: 'automated' };
          // Preconnect/preload hints
          if (/\b(preconnect|preload|dns.?prefetch)\b/.test(t) && /\b(add|missing|implement)\b/.test(t)) return { assignee: 'Automated', execType: 'automated' };

          // --- COPYWRITER: content creation, writing, rewriting tasks ---
          if (/\b(write|rewrite|craft|draft|create.*content|add.*content|expand.*content|improve.*content|update.*content)\b/.test(t)) return { assignee: 'Copywriter', execType: 'copywriter' };
          if (/\b(meta.?description|meta.?title|title.?tag|page.?title)\b/.test(t) && /\b(write|add|create|improve|optimis|missing|empty|duplicate|too short|too long)\b/.test(t)) return { assignee: 'Copywriter', execType: 'copywriter' };
          if (/\b(thin.?content|low.?word.?count|short.?content|content.?quality|content.?length|word.?count)\b/.test(t)) return { assignee: 'Copywriter', execType: 'copywriter' };
          if (/\b(blog.?post|article|landing.?page.?copy|page.?copy|service.?page|suburb.?page)\b/.test(t) && /\b(create|write|add|missing|need)\b/.test(t)) return { assignee: 'Copywriter', execType: 'copywriter' };
          if (/\b(gbp.?post|google.?post|business.?description|business.?profile.?description)\b/.test(t) && /\b(write|create|add|update|improve|missing)\b/.test(t)) return { assignee: 'Copywriter', execType: 'copywriter' };
          if (/\b(respond.*review|reply.*review|review.*response)\b/.test(t)) return { assignee: 'Copywriter', execType: 'copywriter' };
          if (/\b(faq|frequently.?asked|q\s*&\s*a)\b/.test(t) && /\b(add|create|write|missing)\b/.test(t)) return { assignee: 'Copywriter', execType: 'copywriter' };
          if (/\b(heading|h1|h2)\b/.test(t) && /\b(missing|add|rewrite|improve|duplicate|optimis)\b/.test(t)) return { assignee: 'Copywriter', execType: 'copywriter' };
          if (/\b(alt.?text|image.?alt|alt.?tag|alt.?attribute)\b/.test(t) && /\b(missing|add|write|empty)\b/.test(t)) return { assignee: 'Copywriter', execType: 'copywriter' };
          if (/\b(keyword|cannibali[sz]|cannibal)\b/.test(t) && /\b(target|optimis|differentiat|refocus|consolidat)\b/.test(t)) return { assignee: 'Copywriter', execType: 'copywriter' };
          if (/\b(anchor.?text|internal.?link)\b/.test(t) && /\b(descriptive|improve|keyword|optimis)\b/.test(t)) return { assignee: 'Copywriter', execType: 'copywriter' };
          if (/\b(ctr|click.?through)\b/.test(t) && /\b(improve|low|optimis|rewrite|title|description)\b/.test(t)) return { assignee: 'Copywriter', execType: 'copywriter' };
          // On-page content issues are copywriter work
          if (cat === 'on-page issues' || cat === 'content quality') return { assignee: 'Copywriter', execType: 'copywriter' };

          // --- MANUAL: everything else (physical, external sites, monitoring, GBP, directories) ---
          return { assignee: 'Manual', execType: 'manual' };
        }

        // Filter out informational/passing findings — these aren't actionable
        function isInformational(finding) {
          const title = (finding.title || '').trim();
          const titleLower = title.toLowerCase();
          const desc = (finding.description || '').toLowerCase();

          // --- ALWAYS filter: these titles are status checks, never actionable ---
          if (/^pages?\s+(successfully\s+)?crawled/i.test(title)) return true;
          if (/^total\s+pages?\s+in/i.test(title)) return true;
          if (/^sitemap\s+present/i.test(title) && !/missing|not found|error/i.test(desc)) return true;
          if (/^https?\s*[\/ ]\s*ssl/i.test(title) && !/mixed|insecure|expired|error|not /i.test(desc)) return true;
          if (/^(robots\.?txt|viewport\s+meta|mobile.?friendly|server\s+response|page\s+load|dns\s+resolution|ssl\s+cert)/i.test(title) && !/missing|error|slow|block|fail|not /i.test(desc)) return true;

          // --- ✅ emoji means passing — always filter unless "partial" or "but" in desc ---
          if (/✅/.test(title + ' ' + (finding.description || '')) && !/\b(but|however|partial|issue|need|missing|fix|improve)\b/i.test(desc)) return true;

          // --- Monitoring-only (no fix action) ---
          if (/\bmonitor\b/i.test(titleLower) && !/\b(fix|add|create|implement|update|change|improve)\b/i.test(desc)) return true;

          return false;
        }

        const actionableFindings = allFindings.filter(f => !isInformational(f) && f.status !== 'resolved');
        const resolvedCount = allFindings.filter(f => f.status === 'resolved').length;
        console.log(`[orchestrator] Filtered ${allFindings.length - actionableFindings.length - resolvedCount} informational, ${resolvedCount} resolved, ${actionableFindings.length} actionable`);

        // Build action items from findings — 1:1 mapping
        const uniqueItems = actionableFindings.map(f => {
          const { assignee, execType } = assignItem(f);
          return {
            pillar: f.pillar,
            category: f.category,
            title: f.title,
            description: f.recommendation || f.description,
            severity: f.severity || 'Medium',
            execution_type: execType,
            assignee_label: assignee,
            current_value: f.current_value || '',
            new_value: f.recommended_value || '',
            _finding_id: f.id,
          };
        });
        console.log(`[orchestrator] Step 2: ${uniqueItems.length} action items from ${allFindings.length} findings (1:1)`);

        // Transaction: delete old action_items → insert new from findings (findings stay intact)
        const client = await pool.connect();
        let savedCount = 0;
        try {
          await client.query('BEGIN');
          // Preserve done/in-progress items — only replace pending ones
          // 1. Get existing done/in-progress items by finding_id or title+pillar
          const existingDone = await client.query(
            `SELECT id, finding_id, title, pillar, status FROM action_items WHERE project_id=$1 AND status IN ('done', 'completed', 'in-progress', 'ignored')`,
            [projectId]
          );
          const doneKeys = new Set();
          for (const d of existingDone.rows) {
            if (d.finding_id) doneKeys.add(`fid:${d.finding_id}`);
            doneKeys.add(`tp:${(d.title || '').toLowerCase().trim()}|${(d.pillar || '').toLowerCase()}`);
          }

          // 2. Delete only pending action_items (done ones stay)
          await client.query(`DELETE FROM action_items WHERE project_id=$1 AND status NOT IN ('done', 'completed', 'in-progress', 'ignored')`, [projectId]);

          // 3. Insert new items only if not already done
          for (const item of uniqueItems) {
            if (!item.title) continue;
            const fidKey = item._finding_id ? `fid:${item._finding_id}` : null;
            const tpKey = `tp:${(item.title || '').toLowerCase().trim()}|${(item.pillar || '').toLowerCase()}`;
            if ((fidKey && doneKeys.has(fidKey)) || doneKeys.has(tpKey)) {
              console.log(`[orchestrator] Skipping already-done item: ${item.title}`);
              continue;
            }
            await client.query(
              `INSERT INTO action_items (project_id, finding_id, pillar, type, category, title, description, current_value, new_value, severity, status, execution_type, assignee_label)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11, $12)`,
              [projectId, item._finding_id || null, item.pillar, item.category, item.category,
               (item.title || '').slice(0, 200), (item.description || '').slice(0, 1000),
               (item.current_value || '').slice(0, 500), (item.new_value || '').slice(0, 500),
               item.severity || 'Medium', item.execution_type, item.assignee_label]
            );
            savedCount++;
          }
          await client.query('COMMIT');
        } catch (txErr) {
          await client.query('ROLLBACK');
          throw txErr;
        } finally {
          client.release();
        }

        console.log(`[orchestrator] Saved ${savedCount} action items from ${allFindings.length} findings for project ${projectId}`);
        if (global._orchestratorStatus) global._orchestratorStatus[projectId] = { status: 'completed', itemCount: savedCount, error: null };
      } catch (e) {
        console.error('[orchestrator] Error:', e.message, e.stack);
        if (global._orchestratorStatus) global._orchestratorStatus[projectId] = { status: 'failed', error: e.message, itemCount: 0 };
      }
    })();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Orchestrator status endpoint
app.get('/api/projects/:projectId/orchestrator/status', (req, res) => {
  const status = (global._orchestratorStatus || {})[req.params.projectId];
  if (!status) return res.json({ status: 'idle' });
  res.json(status);
});

// Legacy sync-all removed — orchestrator is the sole source of truth for action items

// ==================== SERPAPI HELPER ====================

async function serpApiSearch(params) {
  if (!SERPAPI_KEY) throw new Error('SERPAPI_KEY not configured');
  // Filter out undefined/null/empty values to avoid sending them as strings
  const cleanParams = Object.fromEntries(Object.entries({ ...params, api_key: SERPAPI_KEY }).filter(([_, v]) => v != null && v !== ''));
  const searchParams = new URLSearchParams(cleanParams);
  const resp = await fetch(`https://serpapi.com/search.json?${searchParams}`);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`SerpAPI error ${resp.status}: ${text.substring(0, 200)}`);
  }
  return resp.json();
}

// ==================== 11b. SPEED AUDIT (via Google PageSpeed Insights API) ====================

// Helper: get WordPress URL for a project
async function getProjectWpUrl(projectId, userId) {
  const result = await pool.query('SELECT wordpress_url FROM projects WHERE id=$1 AND user_id=$2', [projectId, userId]);
  if (result.rows.length === 0) return null;
  return result.rows[0].wordpress_url;
}

// Helper: fetch from WP REST API
async function wpFetch(wpUrl, endpoint) {
  const url = `${wpUrl.replace(/\/$/, '')}/wp-json/${endpoint}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`WP API error: ${resp.status} ${resp.statusText}`);
  return resp.json();
}

// Helper: run Google PageSpeed Insights on a URL and extract image issues
async function runPageSpeedAudit(url, strategy = 'mobile') {
  const PAGESPEED_KEY = process.env.PAGESPEED_API_KEY;
  const keyParam = PAGESPEED_KEY ? `&key=${PAGESPEED_KEY}` : '';
  const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=${strategy}&category=performance${keyParam}`;
  const resp = await fetch(apiUrl);
  if (!resp.ok) {
    const text = await resp.text();
    let msg = `HTTP ${resp.status}`;
    try { const j = JSON.parse(text); msg = j.error?.message || j.error?.errors?.[0]?.message || msg; } catch {}
    throw new Error(`PageSpeed error: ${msg}`);
  }
  return resp.json();
}

// Helper: extract image data from Lighthouse results
function extractImageIssues(lighthouseData) {
  const audits = lighthouseData?.lighthouseResult?.audits || {};
  const images = [];
  const seenSrcs = new Set();

  const imageAudits = [
    { key: 'uses-optimized-images', issue: 'too_large' },
    { key: 'modern-image-formats', issue: 'no_webp' },
    { key: 'unsized-images', issue: 'missing_width' },
    { key: 'offscreen-images', issue: 'no_lazy_load' },
    { key: 'uses-responsive-images', issue: 'oversized' },
  ];

  for (const { key, issue } of imageAudits) {
    const audit = audits[key];
    if (!audit?.details?.items) continue;
    for (const item of audit.details.items) {
      const src = item.url || item.node?.snippet || '';
      if (!src || src.startsWith('data:')) continue;
      const shortSrc = src.split('?')[0];
      if (seenSrcs.has(shortSrc)) {
        const existing = images.find(i => i.src.split('?')[0] === shortSrc);
        if (existing && !existing.issues.includes(issue)) existing.issues.push(issue);
      } else {
        seenSrcs.add(shortSrc);
        images.push({
          src,
          file_size_kb: item.totalBytes ? Math.round(item.totalBytes / 1024) : null,
          width: item.node?.boundingRect?.width || null,
          height: item.node?.boundingRect?.height || null,
          has_webp: issue !== 'no_webp',
          issues: [issue],
          wastedBytes: item.wastedBytes || 0,
        });
      }
    }
  }

  // Check for missing alt text
  const altAudit = audits['image-alt'];
  if (altAudit?.details?.items) {
    for (const item of altAudit.details.items) {
      const src = item.node?.snippet?.match(/src="([^"]+)"/)?.[1] || '';
      if (!src) continue;
      const shortSrc = src.split('?')[0];
      if (seenSrcs.has(shortSrc)) {
        const existing = images.find(i => i.src.split('?')[0] === shortSrc);
        if (existing && !existing.issues.includes('missing_alt')) existing.issues.push('missing_alt');
      } else {
        seenSrcs.add(shortSrc);
        images.push({ src, file_size_kb: null, width: null, height: null, has_webp: true, issues: ['missing_alt'], wastedBytes: 0 });
      }
    }
  }

  return images;
}

// Helper: discover pages from sitemap or WP REST API
async function discoverPages(projectUrl, wpUrl, authHeaders = null) {
  const pages = [];
  const baseUrl = projectUrl.replace(/\/$/, '');
  const seenUrls = new Set();

  // Helper: extract page URLs from a single sitemap XML
  function extractPagesFromSitemap(xml) {
    const urlMatches = xml.match(/<loc>([^<]+)<\/loc>/g) || [];
    for (const match of urlMatches) {
      const url = match.replace(/<\/?loc>/g, '');
      if (url.endsWith('.pdf') || url.match(/\.(jpg|png|gif|svg)$/i)) continue;
      if (url.endsWith('.xml')) continue; // skip sub-sitemap refs (handled separately)
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      const slug = url.replace(baseUrl, '').replace(/^\/|\/$/g, '') || 'home';
      pages.push({ page_id: slug, title: slug === 'home' ? 'Homepage' : slug.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()), slug, url });
    }
  }

  // Try sitemap.xml first
  try {
    const sitemapResp = await fetch(`${baseUrl}/sitemap.xml`, { headers: { 'User-Agent': 'SEORoomBot/1.0' } });
    if (sitemapResp.ok) {
      const xml = await sitemapResp.text();

      // Check if this is a sitemap index (contains sub-sitemaps like post-sitemap.xml)
      const subSitemapMatches = xml.match(/<loc>([^<]+\.xml)<\/loc>/g) || [];
      if (subSitemapMatches.length > 0) {
        // It's a sitemap index — fetch each sub-sitemap
        for (const subMatch of subSitemapMatches) {
          const subUrl = subMatch.replace(/<\/?loc>/g, '');
          try {
            const subResp = await fetch(subUrl, { headers: { 'User-Agent': 'SEORoomBot/1.0' } });
            if (subResp.ok) {
              const subXml = await subResp.text();
              extractPagesFromSitemap(subXml);
            }
          } catch (e) { /* skip failed sub-sitemap */ }
          if (pages.length >= 100) break;
        }
      } else {
        // It's a regular sitemap — extract pages directly
        extractPagesFromSitemap(xml);
      }

      // Cap at 50
      if (pages.length > 100) pages.length = 100;
    }
  } catch (e) { /* sitemap not available */ }

  // Try WP REST API if available and no sitemap pages (or to supplement sitemap)
  if (wpUrl) {
    try {
      const wpBase = wpUrl.replace(/\/$/, '');
      const fetchOpts = { signal: AbortSignal.timeout(30000), ...(authHeaders ? { headers: authHeaders } : {}) };
      const resp = await fetch(`${wpBase}/wp-json/wp/v2/pages?per_page=50&status=publish&_fields=id,title,slug,link`, fetchOpts);
      if (resp.ok) {
        const wpPages = await resp.json();
        for (const p of (Array.isArray(wpPages) ? wpPages : [])) {
          const url = p.link || '';
          if (!seenUrls.has(url)) {
            seenUrls.add(url);
            pages.push({ page_id: String(p.id), title: p.title?.rendered || p.slug, slug: p.slug, url });
          }
        }
      }
    } catch (e) { console.log('[discoverPages] WP REST API failed:', e.message); }
  }

  // Fallback: just test the homepage
  if (pages.length === 0) {
    pages.push({ page_id: 'home', title: 'Homepage', slug: '', url: baseUrl });
  }

  return pages;
}

// Run speed audit on ALL pages (via Google PageSpeed Insights) — async background job
app.post('/api/speed-audit/:projectId/run', async (req, res) => {
  try {
    const projRes = await pool.query('SELECT * FROM projects WHERE id=$1', [req.params.projectId]);
    if (projRes.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = projRes.rows[0];
    const siteUrl = project.wordpress_url || (project.domain ? `https://${project.domain.replace(/^https?:\/\//, '')}` : null);
    if (!siteUrl) return res.status(400).json({ error: 'Website URL or domain not configured. Set it in Project Settings.' });

    // Cancel any running speed audits
    await pool.query(`UPDATE audits SET status='failed', completed_at=NOW() WHERE project_id=$1 AND pillar='speed' AND status='running'`, [req.params.projectId]);

    // Create audit record
    const auditRes = await pool.query(
      `INSERT INTO audits (project_id, pillar, status, started_at) VALUES ($1, 'speed', 'running', NOW()) RETURNING id`,
      [req.params.projectId]
    );
    const auditId = auditRes.rows[0].id;

    // Return immediately
    res.json({ auditId, status: 'running' });

    // Run in background
    (async () => {
      try {
        const pages = await discoverPages(siteUrl, project.wordpress_url, getWpAuthHeaders(project));
        console.log(`[speed-audit] Discovered ${pages.length} pages for project ${req.params.projectId}`);

        // Save total immediately so frontend can show counter
        await pool.query(`UPDATE audits SET audit_data=$1 WHERE id=$2`,
          [JSON.stringify({ progress: 0, total: pages.length }), auditId]);

        const BATCH_SIZE = 5;
        const results = [];

        async function processPage(page) {
          try {
            const psData = await runPageSpeedAudit(page.url, 'mobile');
            const metrics = psData.lighthouseResult?.audits || {};
            const score = Math.round((psData.lighthouseResult?.categories?.performance?.score || 0) * 100);

            // Extract actionable Lighthouse opportunities & diagnostics
            const opportunities = [];
            const fixableAudits = [
              'unsized-images', 'render-blocking-resources', 'unused-css', 'unused-javascript',
              'uses-responsive-images', 'offscreen-images', 'uses-optimized-images', 'modern-image-formats',
              'uses-text-compression', 'uses-rel-preconnect', 'uses-rel-preload', 'font-display',
              'third-party-summary', 'dom-size', 'critical-request-chains', 'largest-contentful-paint-element',
              'layout-shift-elements', 'long-tasks', 'efficient-animated-content', 'duplicated-javascript',
              'legacy-javascript', 'total-byte-weight', 'mainthread-work-breakdown',
            ];
            for (const key of fixableAudits) {
              const audit = metrics[key];
              if (audit && audit.score !== null && audit.score < 1) {
                const opp = { id: key, title: audit.title, score: audit.score, displayValue: audit.displayValue || '' };
                // Include items (e.g. which images are unsized, which scripts are render-blocking)
                if (audit.details?.items?.length) {
                  opp.items = audit.details.items.slice(0, 10).map(item => {
                    const cleaned = {};
                    if (item.url) cleaned.url = item.url;
                    if (item.node?.snippet) cleaned.snippet = item.node.snippet.slice(0, 200);
                    if (item.wastedBytes) cleaned.wastedBytes = item.wastedBytes;
                    if (item.wastedMs) cleaned.wastedMs = item.wastedMs;
                    if (item.totalBytes) cleaned.totalBytes = item.totalBytes;
                    if (item.source) cleaned.source = typeof item.source === 'object' ? item.source.url : item.source;
                    return Object.keys(cleaned).length > 0 ? cleaned : { raw: JSON.stringify(item).slice(0, 150) };
                  });
                }
                opportunities.push(opp);
              }
            }

            return {
              page_id: page.page_id, title: page.title, slug: page.slug, url: page.url,
              performance_score: score,
              cwv: {
                lcp: metrics['largest-contentful-paint']?.displayValue || 'N/A',
                fid: metrics['max-potential-fid']?.displayValue || 'N/A',
                cls: metrics['cumulative-layout-shift']?.displayValue || 'N/A',
                fcp: metrics['first-contentful-paint']?.displayValue || 'N/A',
                si: metrics['speed-index']?.displayValue || 'N/A',
                tbt: metrics['total-blocking-time']?.displayValue || 'N/A',
                score,
              },
              opportunities,
            };
          } catch (err) {
            console.warn(`[speed-audit] Failed for ${page.url}: ${err.message}`);
            return { page_id: page.page_id, title: page.title, slug: page.slug, url: page.url, error: err.message };
          }
        }

        for (let i = 0; i < pages.length; i += BATCH_SIZE) {
          const batch = pages.slice(i, i + BATCH_SIZE);
          const batchResults = await Promise.all(batch.map(processPage));
          results.push(...batchResults);
          console.log(`[speed-audit] Progress: ${results.length}/${pages.length} pages`);
          // Save progress so frontend can show counter
          await pool.query(`UPDATE audits SET audit_data=$1 WHERE id=$2`,
            [JSON.stringify({ progress: results.length, total: pages.length }), auditId]);
        }

        await pool.query(
          `UPDATE audits SET status='completed', completed_at=NOW(), audit_data=$1 WHERE id=$2`,
          [JSON.stringify({ results, ran_at: new Date().toISOString() }), auditId]
        );
        console.log(`[speed-audit] Completed: ${results.length} pages for project ${req.params.projectId}`);

        // Generate audit_findings + action_items for pages with issues
        try {
          // Clear previous speed findings
          await pool.query(`DELETE FROM audit_findings WHERE project_id=$1 AND pillar='website' AND category='Core Web Vitals'`, [req.params.projectId]);

          const cwvResults = results.filter(r => r.cwv && !r.error);
          let findingsCount = 0;

          for (const page of cwvResults) {
            const score = page.cwv.score || 0;
            if (score >= 90) continue; // Good — no action needed

            const severity = score < 50 ? 'critical' : 'high';
            const issues = [];
            const lcp = parseFloat(page.cwv.lcp);
            const cls = parseFloat(page.cwv.cls);
            const tbt = parseFloat(page.cwv.tbt);
            const fcp = parseFloat(page.cwv.fcp);
            if (!isNaN(lcp) && lcp > 2.5) issues.push(`LCP ${page.cwv.lcp} (target: ≤2.5s)`);
            if (!isNaN(cls) && cls > 0.1) issues.push(`CLS ${page.cwv.cls} (target: ≤0.1)`);
            if (!isNaN(tbt) && tbt > 200) issues.push(`TBT ${page.cwv.tbt} (target: ≤200ms)`);
            if (!isNaN(fcp) && fcp > 1.8) issues.push(`FCP ${page.cwv.fcp} (target: ≤1.8s)`);

            const title = page.title || page.slug || page.url;
            const description = `Performance score: ${score}/100. ${issues.length > 0 ? 'Issues: ' + issues.join(', ') : 'Below target performance.'}`;
            const recommendation = score < 50
              ? 'Optimize images (WebP, lazy loading), minimize render-blocking CSS/JS, reduce server response time, implement caching. Consider deferring non-critical scripts.'
              : 'Review largest contentful paint element, optimize images, reduce unused CSS/JS. Minor optimizations can push this page into the green zone.';

            const fRes = await pool.query(
              `INSERT INTO audit_findings (project_id, audit_id, pillar, category, title, description, recommendation, severity, current_value, recommended_value, status)
               VALUES ($1, $2, 'website', 'Core Web Vitals', $3, $4, $5, $6, $7, $8, 'approved') RETURNING id`,
              [req.params.projectId, auditId, title, description, recommendation, severity, `Score: ${score}`, 'Score: 90+']
            );
            await pool.query(
              `INSERT INTO action_items (project_id, finding_id, pillar, type, category, title, description, current_value, new_value, severity, status, execution_type, assignee_label)
               VALUES ($1, $2, 'website', 'Core Web Vitals', 'Core Web Vitals', $3, $4, $5, $6, $7, 'pending', 'automated', 'Automated')`,
              [req.params.projectId, fRes.rows[0].id, title, description, `Score: ${score}`, 'Score: 90+', severity]
            );
            findingsCount++;
          }
          console.log(`[speed-audit] Created ${findingsCount} CWV findings for project ${req.params.projectId}`);
        } catch (findErr) {
          console.error('[speed-audit] Error creating findings:', findErr.message);
        }
      } catch (bgErr) {
        console.error('[speed-audit] Background error:', bgErr.message);
        try { await pool.query(`UPDATE audits SET status='failed', completed_at=NOW(), audit_data=$1 WHERE id=$2`,
          [JSON.stringify({ error: bgErr.message }), auditId]); } catch (e2) {}
      }
    })();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Poll speed audit status
app.get('/api/speed-audit/:projectId/status', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, status, audit_data, started_at, completed_at FROM audits WHERE project_id=$1 AND pillar='speed' ORDER BY started_at DESC LIMIT 1`,
      [req.params.projectId]
    );
    if (result.rows.length === 0) return res.json({ status: 'none' });
    const audit = result.rows[0];
    // Auto-fail audits stuck running for more than 10 minutes (e.g. server restarted)
    if (audit.status === 'running' && audit.started_at) {
      const elapsed = Date.now() - new Date(audit.started_at).getTime();
      if (elapsed > 10 * 60 * 1000) {
        await pool.query(`UPDATE audits SET status='failed', completed_at=NOW(), audit_data='{"error":"Audit timed out"}'::jsonb WHERE id=$1`, [audit.id]);
        return res.json({ status: 'failed', error: 'Audit timed out (server may have restarted). Please run again.' });
      }
    }
    const data = typeof audit.audit_data === 'string' ? JSON.parse(audit.audit_data) : (audit.audit_data || {});
    res.json({
      status: audit.status,
      auditId: audit.id,
      results: data.results || null,
      total_pages: (data.results || []).length,
      progress: data.progress || null,
      total: data.total || null,
      error: data.error || null,
      startedAt: audit.started_at,
      completedAt: audit.completed_at,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PageSpeed Insights for individual page (used by "Run PageSpeed" button per page)
app.get('/api/speed-audit/:projectId/pagespeed', async (req, res) => {
  const { url, strategy = 'mobile' } = req.query;
  if (!url) return res.status(400).json({ error: 'url parameter required' });

  try {
    const data = await runPageSpeedAudit(url, strategy);
    const metrics = data.lighthouseResult?.audits;
    const cwv = {
      lcp: metrics?.['largest-contentful-paint']?.displayValue || 'N/A',
      fid: metrics?.['max-potential-fid']?.displayValue || 'N/A',
      cls: metrics?.['cumulative-layout-shift']?.displayValue || 'N/A',
      fcp: metrics?.['first-contentful-paint']?.displayValue || 'N/A',
      si: metrics?.['speed-index']?.displayValue || 'N/A',
      tbt: metrics?.['total-blocking-time']?.displayValue || 'N/A',
      score: Math.round((data.lighthouseResult?.categories?.performance?.score || 0) * 100),
    };
    res.json({ url, strategy, cwv });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get latest speed audit results (for persistence across navigation)
app.get('/api/projects/:projectId/audits/speed/latest', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT audit_data FROM audits WHERE project_id=$1 AND pillar='speed' ORDER BY completed_at DESC LIMIT 1`,
      [req.params.projectId]
    );
    if (result.rows.length === 0) return res.json({ results: [] });
    const data = typeof result.rows[0].audit_data === 'string' ? JSON.parse(result.rows[0].audit_data) : result.rows[0].audit_data;
    res.json({ results: data.results || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ CWV AUTO-FIX: AI analyzes opportunities → generates fix → sends to seoroom-helper plugin ============
app.post('/api/projects/:projectId/cwv-fix', async (req, res) => {
  try {
    const project = (await pool.query('SELECT * FROM projects WHERE id=$1', [req.params.projectId])).rows[0];
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const wpUrl = project.wordpress_url;
    const authHeaders = getWpAuthHeaders(project);
    if (!wpUrl || !authHeaders.Authorization) return res.status(400).json({ error: 'WordPress URL and Application Password required in Project Settings' });

    const { page_url, opportunities } = req.body;
    if (!page_url || !opportunities?.length) return res.status(400).json({ error: 'page_url and opportunities required' });

    // Use Haiku to analyze opportunities and generate fix instructions
    const fixPrompt = `You are a WordPress Core Web Vitals expert. Analyze these Lighthouse audit failures for the page "${page_url}" and generate fix instructions that can be applied via a WordPress helper plugin (no theme file changes).

AVAILABLE FIX TYPES (choose from these ONLY):
- preconnect: {domain, crossorigin?} — add <link rel="preconnect"> for third-party domains
- dns_prefetch: {domain} — add <link rel="dns-prefetch">
- preload_resource: {url, as, type?, crossorigin?} — preload critical font/image/CSS. "as" must be: font, image, style, script
- fetchpriority: {image_src?} — add fetchpriority="high" to LCP image. If no image_src, applies to first image
- font_display_swap: {} — add font-display:swap globally
- defer_script: {handle?, url_pattern?} — defer a render-blocking script. Use url_pattern to match by partial URL
- delay_script: {handle?, url_pattern?} — delay script until user interaction (for analytics, chat, etc.)
- image_dimensions: {image_src, width, height} — add missing width/height to a specific image
- lazy_load: {} — add loading="lazy" to below-fold images (skips first 2)

IMPORTANT RULES:
- Only suggest fixes that the plugin can safely apply via WordPress hooks
- Do NOT suggest fixes that BerqWP already handles (general image compression, WebP conversion, CSS/JS minification, page caching, CDN)
- Focus on: preconnect hints, LCP preloading, fetchpriority, font-display, deferring specific third-party scripts, image dimensions
- Each fix must be specific — include actual URLs, domains, or patterns from the opportunity data
- MAX 5 fixes per page

LIGHTHOUSE OPPORTUNITIES:
${JSON.stringify(opportunities, null, 2)}

Return ONLY a JSON array of fixes:
[{"fix_type": "...", "params": {...}, "reason": "short explanation"}]`;

    const aiResp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{ role: 'user', content: fixPrompt }],
    });

    let fixes = [];
    try {
      const text = aiResp.content[0].text;
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) fixes = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      return res.status(500).json({ error: 'AI failed to generate valid fix instructions' });
    }

    if (!fixes.length) return res.json({ success: true, fixes_applied: 0, message: 'No applicable fixes found — BerqWP likely handles the remaining issues' });

    // Apply each fix via seoroom-helper plugin API
    const applied = [];
    const failed = [];

    for (const fix of fixes) {
      try {
        const wpResp = await fetch(`${wpUrl}/wp-json/seoroom/v1/cwv-fix`, {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fix_type: fix.fix_type,
            params: fix.params,
            page_url: page_url,
          }),
          signal: AbortSignal.timeout(10000),
        });

        if (!wpResp.ok) {
          const errText = await wpResp.text();
          failed.push({ fix_type: fix.fix_type, error: `WP returned ${wpResp.status}: ${errText.slice(0, 100)}` });
          continue;
        }

        const wpResult = await wpResp.json();
        applied.push({ fix_type: fix.fix_type, fix_id: wpResult.fix_id, reason: fix.reason });

        // Log to wp_change_history for dashboard rollback tracking
        await pool.query(
          `INSERT INTO wp_change_history (project_id, page_id, page_url, page_title, change_type, field_name, original_value, new_value) VALUES ($1, 0, $2, $3, 'cwv_fix', $4, 'none', $5)`,
          [req.params.projectId, page_url, page_url, fix.fix_type, JSON.stringify({ fix_id: wpResult.fix_id, params: fix.params, reason: fix.reason })]
        );
      } catch (fixErr) {
        failed.push({ fix_type: fix.fix_type, error: fixErr.message });
      }
    }

    console.log(`[cwv-fix] Applied ${applied.length} fixes, ${failed.length} failed for ${page_url}`);
    res.json({ success: true, fixes_applied: applied.length, applied, failed });
  } catch (e) {
    console.error('[cwv-fix] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============ UNIFIED AUTO-FIX ============
// Routes action items to the appropriate fix handler
app.post('/api/projects/:projectId/auto-fix', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { action_item_id } = req.body;
    if (!action_item_id) return res.status(400).json({ error: 'action_item_id required' });

    const project = (await pool.query('SELECT * FROM projects WHERE id=$1', [projectId])).rows[0];
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const item = (await pool.query(
      `SELECT ai.*, af.recommendation as finding_recommendation, af.current_value as finding_current, af.recommended_value as finding_recommended
       FROM action_items ai LEFT JOIN audit_findings af ON ai.finding_id = af.id
       WHERE ai.id = $1 AND ai.project_id = $2`, [action_item_id, projectId]
    )).rows[0];
    if (!item) return res.status(404).json({ error: 'Action item not found' });

    const cat = (item.category || '').toLowerCase();
    const title = (item.title || '').toLowerCase();
    const desc = (item.description || '').toLowerCase();
    const allText = title + ' ' + desc;
    const wpUrl = (project.wordpress_url || '').replace(/\/$/, '');
    const authHeaders = getWpAuthHeaders(project);

    // Preflight: check WP + plugin reachable for routes that need it
    if (wpUrl && authHeaders) {
      try {
        const ping = await fetch(`${wpUrl}/wp-json/seoroom/v1/cwv-fixes`, {
          headers: authHeaders, signal: AbortSignal.timeout(8000)
        });
        if (!ping.ok && ping.status === 404) {
          console.error(`[auto-fix] seoroom-helper plugin not found at ${wpUrl}`);
          return res.json({ success: true, fix_type: 'preflight', applied: false,
            message: 'seoroom-helper plugin not found on WordPress site. Install & activate it first.' });
        }
      } catch (pingErr) {
        console.error(`[auto-fix] WP unreachable: ${pingErr.message}`);
        return res.json({ success: true, fix_type: 'preflight', applied: false,
          message: `WordPress site unreachable: ${pingErr.message}` });
      }
    }

    // ---- ROUTE 1: On-page meta fixes (titles, descriptions, focus keywords) ----
    // Skip if this is a schema item (Route 2 handles those)
    const isSchemaItem = /\b(schema|structured.?data|json.?ld)\b/.test(allText) && cat !== 'core web vitals';
    if (!isSchemaItem && (/\b(meta.?title|meta.?desc|title.?tag|page.?title|focus.?keyword|yoast)\b/.test(allText) ||
        (cat === 'on-page issues' && /\b(title|description|keyword|duplicate|missing|empty|too short|too long)\b/.test(allText)))) {
      if (!wpUrl || !authHeaders) return res.status(400).json({ error: 'WordPress URL and Application Password required' });

      // Find the page this item refers to — try to extract URL or page name from title/desc
      const urlMatch = (item.title + ' ' + item.description).match(/https?:\/\/[^\s"]+/);
      const pageSlug = (item.title || '').replace(/^(Fix|Update|Add|Missing|Duplicate|Improve)\s+/i, '')
        .replace(/\s+(meta title|meta description|title tag|focus keyword).*$/i, '').trim();

      let pageData = null;
      if (urlMatch) {
        const slug = urlMatch[0].replace(wpUrl, '').replace(/^\/|\/$/g, '').split('/').pop();
        pageData = await readWpYoastMeta(wpUrl, slug, authHeaders);
      }
      if (!pageData && pageSlug) {
        const slug = pageSlug.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        pageData = await readWpYoastMeta(wpUrl, slug, authHeaders);
      }

      if (!pageData) {
        // Can't identify the page — keep pending
        return res.json({ success: true, fix_type: 'meta', applied: false, message: 'Could not identify specific page. Use On-Page Audit to fix manually.' });
      }

      // AI-generate fix
      const aiResp = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        messages: [{ role: 'user', content: `You are an SEO expert. Fix the meta for this WordPress page.

Issue: ${item.title}
Details: ${item.description}
Page: ${pageData.title} (${pageData.type}/${pageData.wpId})
Current meta title: ${pageData.yoast_wpseo_title || '(empty)'}
Current meta desc: ${pageData.yoast_wpseo_metadesc || '(empty)'}
Current focus keyword: ${pageData.yoast_wpseo_focuskw || '(empty)'}
Business: ${project.business_name || project.name} — ${project.industry || 'services'} in ${project.location || 'Australia'}

Return ONLY JSON: {"new_meta_title": "...", "new_meta_desc": "...", "new_focus_keyword": "..."}
- Title: 50-60 chars, include primary keyword
- Desc: 120-155 chars, compelling with CTA
- Keyword: 2-4 word focus keyword
- Only include fields that need changing (omit if current is already good)` }]
      });

      let fix = {};
      try {
        const jsonMatch = aiResp.content[0].text.match(/\{[\s\S]*\}/);
        if (jsonMatch) fix = JSON.parse(jsonMatch[0]);
      } catch (e) { return res.status(500).json({ error: 'AI failed to generate meta fix' }); }

      // Apply changes via Yoast REST API
      const changes = [];
      const meta = {};
      if (fix.new_meta_title && fix.new_meta_title !== pageData.yoast_wpseo_title) {
        changes.push({ field: 'yoast_wpseo_title', old: pageData.yoast_wpseo_title, new: fix.new_meta_title });
        meta._yoast_wpseo_title = fix.new_meta_title;
      }
      if (fix.new_meta_desc && fix.new_meta_desc !== pageData.yoast_wpseo_metadesc) {
        changes.push({ field: 'yoast_wpseo_metadesc', old: pageData.yoast_wpseo_metadesc, new: fix.new_meta_desc });
        meta._yoast_wpseo_metadesc = fix.new_meta_desc;
      }
      if (fix.new_focus_keyword && fix.new_focus_keyword !== pageData.yoast_wpseo_focuskw) {
        changes.push({ field: 'yoast_wpseo_focuskw', old: pageData.yoast_wpseo_focuskw, new: fix.new_focus_keyword });
        meta._yoast_wpseo_focuskw = fix.new_focus_keyword;
      }

      if (changes.length === 0) {
        return res.json({ success: true, fix_type: 'meta', applied: false, message: 'AI found no meta changes needed — review manually in On-Page Audit.' });
      }

      const writeResp = await fetch(`${wpUrl}/wp-json/wp/v2/${pageData.type}/${pageData.wpId}`, {
        method: 'POST', headers: authHeaders, body: JSON.stringify({ meta }), signal: AbortSignal.timeout(15000)
      });

      if (!writeResp.ok) {
        const errText = await writeResp.text();
        return res.status(500).json({ error: `WP write failed: ${writeResp.status} — ${errText.slice(0, 200)}` });
      }

      // Log to wp_change_history for rollback
      for (const change of changes) {
        await pool.query(
          `INSERT INTO wp_change_history (project_id, page_id, page_url, page_title, change_type, field_name, original_value, new_value) VALUES ($1, $2, $3, $4, 'auto_fix_meta', $5, $6, $7)`,
          [projectId, pageData.wpId, '', pageData.title, change.field, change.old || '', change.new]
        );
      }

      await pool.query('UPDATE action_items SET status=$1 WHERE id=$2', ['done', action_item_id]);
      if (item.finding_id) await pool.query(`UPDATE audit_findings SET status='resolved' WHERE id=$1`, [item.finding_id]);
      console.log(`[auto-fix] Meta fix applied: ${changes.length} changes on ${pageData.title}`);
      return res.json({ success: true, fix_type: 'meta', applied: true, changes: changes.length, page: pageData.title });
    }

    // ---- ROUTE 2: Schema/Structured Data injection ----
    if (cat === 'schema & data' || cat === 'schema' || (/\b(schema|structured.?data|json.?ld|rich.?snippet|local.?business|faqpage|itemlist|aggregaterating|breadcrumb|service|review)\b/.test(allText) && cat !== 'core web vitals')) {
      if (!wpUrl || !authHeaders) return res.status(400).json({ error: 'WordPress URL and Application Password required' });

      // AI-generate the schema markup
      const aiResp = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        messages: [{ role: 'user', content: `You are a Schema.org structured data expert. Generate JSON-LD markup for this fix.

Issue: ${item.title}
Details: ${item.description}
Business: ${project.business_name || project.name}
Industry: ${project.industry || 'services'}
Location: ${project.location || 'Australia'}
Website: ${project.domain || wpUrl}

RULES:
- Return ONLY the JSON-LD script tag content (the JSON object, no <script> tags)
- Use schema.org vocabulary
- Include all relevant properties
- For LocalBusiness: include name, url, telephone (if known), address, geo, openingHours
- For FAQ: include mainEntity with Question/Answer pairs based on common questions for this industry
- For BreadcrumbList: include itemListElement
- Be specific and complete

Return ONLY valid JSON-LD (the object, no wrapping).` }]
      });

      let schemaJson = '';
      try {
        const text = aiResp.content[0].text;
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          JSON.parse(jsonMatch[0]); // validate
          schemaJson = jsonMatch[0];
        }
      } catch (e) { return res.status(500).json({ error: 'AI failed to generate valid schema' }); }

      if (!schemaJson) return res.status(500).json({ error: 'No schema generated' });

      // Inject via seoroom-helper custom_snippet
      const snippetHtml = `<script type="application/ld+json">\n${schemaJson}\n</script>`;
      const wpResp = await fetch(`${wpUrl}/wp-json/seoroom/v1/cwv-fix`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fix_type: 'custom_snippet',
          params: { html: snippetHtml, location: 'head' },
          page_url: '', // site-wide
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!wpResp.ok) {
        const errText = await wpResp.text();
        return res.status(500).json({ error: `WP plugin returned ${wpResp.status}: ${errText.slice(0, 200)}` });
      }

      const wpResult = await wpResp.json();

      await pool.query(
        `INSERT INTO wp_change_history (project_id, page_id, page_url, page_title, change_type, field_name, original_value, new_value) VALUES ($1, 0, '', $2, 'auto_fix_schema', 'json_ld', 'none', $3)`,
        [projectId, item.title, JSON.stringify({ fix_id: wpResult.fix_id, schema: schemaJson.slice(0, 500) })]
      );

      await pool.query('UPDATE action_items SET status=$1 WHERE id=$2', ['done', action_item_id]);
      if (item.finding_id) await pool.query(`UPDATE audit_findings SET status='resolved' WHERE id=$1`, [item.finding_id]);
      console.log(`[auto-fix] Schema injected: ${item.title}`);
      return res.json({ success: true, fix_type: 'schema', applied: true, fix_id: wpResult.fix_id });
    }

    // ---- ROUTE 3: CWV / Performance fixes ----
    // Parse the action item description directly into seoroom-helper fix instructions
    if (cat === 'core web vitals' || /\b(lcp|cls|fcp|tbt|ttfb|inp|speed|performance|render|blocking|font.?loading|third.?party|lazy)\b/.test(allText)) {
      if (!wpUrl || !authHeaders) return res.status(400).json({ error: 'WordPress URL and Application Password required' });

      const fullDesc = `${item.title}\n${item.description || ''}\n${item.finding_recommendation || ''}`;

      const fixPrompt = `You are a WordPress CWV fix expert. Parse this audit finding and generate seoroom-helper plugin fix instructions.

FINDING:
${fullDesc}

AVAILABLE FIX TYPES (use ONLY these):
- preconnect: {domain, crossorigin?} — add <link rel="preconnect">
- dns_prefetch: {domain} — add <link rel="dns-prefetch">
- preload_resource: {url, as, type?, crossorigin?} — preload resource. "as" = font|image|style|script
- fetchpriority: {image_src?} — add fetchpriority="high" to LCP image
- font_display_swap: {} — add font-display:swap globally
- defer_script: {url_pattern?} — defer a render-blocking script
- delay_script: {url_pattern?} — delay script until user interaction (analytics, chat widgets, maps)
- image_dimensions: {image_src, width, height} — add missing width/height
- lazy_load: {} — add loading="lazy" to below-fold images
- custom_snippet: {html, location} — inject HTML into head or footer. location = "head" or "footer"

RULES:
- Extract specific URLs, domains, file paths from the finding text
- Do NOT suggest image compression, WebP, CSS/JS minification, or page caching (handled by BerqWP)
- If the finding mentions a specific resource URL, use it in params
- For font-display issues → use font_display_swap + preconnect to fonts.googleapis.com and fonts.gstatic.com
- For LCP image → use fetchpriority + preload_resource with the image URL
- For third-party scripts → use delay_script with the domain pattern
- For render-blocking CSS/JS → use defer_script or custom_snippet for critical CSS
- For CLS / image dimensions → use image_dimensions if specific images mentioned, otherwise lazy_load
- page_url: "" means site-wide, or use specific page path if mentioned
- MAX 5 fixes

Return ONLY a JSON array: [{"fix_type": "...", "params": {...}, "page_url": "", "reason": "short why"}]
If NOTHING can be fixed by the plugin (e.g. server config, hosting changes), return: []`;

      const aiResp = await anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 1500, messages: [{ role: 'user', content: fixPrompt }] });
      let fixes = [];
      try { const m = aiResp.content[0].text.match(/\[[\s\S]*\]/); if (m) fixes = JSON.parse(m[0]); } catch (e) {}

      if (!fixes.length) {
        return res.json({ success: true, fix_type: 'cwv', applied: false, message: `${item.title}: requires server/hosting config — can't be applied via WordPress plugin.` });
      }

      let appliedCount = 0;
      const appliedFixes = [];
      const failedFixes = [];
      for (const fix of fixes) {
        try {
          const wr = await fetch(`${wpUrl}/wp-json/seoroom/v1/cwv-fix`, {
            method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fix_type: fix.fix_type, params: fix.params, page_url: fix.page_url || '' }),
            signal: AbortSignal.timeout(10000),
          });
          if (wr.ok) {
            const r = await wr.json();
            await pool.query(
              `INSERT INTO wp_change_history (project_id, page_id, page_url, page_title, change_type, field_name, original_value, new_value) VALUES ($1, 0, $2, $3, 'cwv_fix', $4, 'none', $5)`,
              [projectId, fix.page_url || '', item.title, fix.fix_type, JSON.stringify({ fix_id: r.fix_id, params: fix.params, reason: fix.reason })]
            );
            appliedCount++;
            appliedFixes.push(fix.fix_type);
          } else {
            const errText = await wr.text();
            failedFixes.push(`${fix.fix_type}: ${wr.status} ${errText.slice(0, 80)}`);
            console.error(`[auto-fix] CWV fix ${fix.fix_type} failed: ${wr.status} ${errText.slice(0, 100)}`);
          }
        } catch (e) {
          failedFixes.push(`${fix.fix_type}: ${e.message}`);
          console.error('[auto-fix] CWV fix error:', e.message);
        }
      }

      if (appliedCount > 0) {
        await pool.query('UPDATE action_items SET status=$1 WHERE id=$2', ['done', action_item_id]);
        if (item.finding_id) await pool.query(`UPDATE audit_findings SET status='resolved' WHERE id=$1`, [item.finding_id]);
        console.log(`[auto-fix] CWV: ${appliedCount}/${fixes.length} fixes applied for "${item.title}": ${appliedFixes.join(', ')}`);
        return res.json({ success: true, fix_type: 'cwv', applied: true, fixes_applied: appliedCount, fixes: appliedFixes, failed: failedFixes });
      }
      return res.json({ success: true, fix_type: 'cwv', applied: false,
        message: `All ${fixes.length} fixes failed. Errors: ${failedFixes.join('; ').slice(0, 200)}` });
    }

    // ---- ROUTE 5: Everything else — keep pending, explain why ----
    console.log(`[auto-fix] No auto-handler for: ${item.title} [${cat}]`);
    return res.json({ success: true, fix_type: 'manual_review', applied: false, message: `"${(item.title || '').slice(0, 80)}" can't be auto-fixed — needs manual action. Check audit for steps.` });

  } catch (e) {
    console.error('[auto-fix] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Rollback a CWV fix via seoroom-helper plugin
app.post('/api/projects/:projectId/cwv-fix/rollback', async (req, res) => {
  try {
    const project = (await pool.query('SELECT * FROM projects WHERE id=$1', [req.params.projectId])).rows[0];
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const wpUrl = project.wordpress_url;
    const authHeaders = getWpAuthHeaders(project);
    const { fix_id } = req.body;

    const wpResp = await fetch(`${wpUrl}/wp-json/seoroom/v1/cwv-fix/rollback`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fix_id }),
      signal: AbortSignal.timeout(10000),
    });

    if (!wpResp.ok) return res.status(wpResp.status).json({ error: 'Rollback failed' });

    // Mark in history
    await pool.query(
      `UPDATE wp_change_history SET rolled_back_at=NOW() WHERE project_id=$1 AND field_name='cwv_fix' AND new_value LIKE $2`,
      [req.params.projectId, `%${fix_id}%`]
    );

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List active CWV fixes from seoroom-helper plugin
app.get('/api/projects/:projectId/cwv-fixes', async (req, res) => {
  try {
    const project = (await pool.query('SELECT * FROM projects WHERE id=$1', [req.params.projectId])).rows[0];
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const wpUrl = project.wordpress_url;
    const authHeaders = getWpAuthHeaders(project);

    const wpResp = await fetch(`${wpUrl}/wp-json/seoroom/v1/cwv-fixes`, {
      headers: authHeaders,
      signal: AbortSignal.timeout(10000),
    });

    if (!wpResp.ok) return res.status(wpResp.status).json({ error: 'Failed to fetch fixes' });
    const fixes = await wpResp.json();
    res.json({ fixes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== INDEXING STATUS CHECK ====================

// Discover all important pages and check indexing status
app.post('/api/projects/:projectId/indexing/check', async (req, res) => {
  const { projectId } = req.params;
  try {
    const proj = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    if (proj.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = proj.rows[0];
    const domain = (project.domain || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    const gscProperty = project.gsc_property;

    const accessToken = await getGscAccessToken(req.auth?.userId);
    if (!accessToken) return res.status(400).json({ error: 'GSC not connected. Connect in Agency Integrations.' });

    // Find matching GSC site
    let matchedSite = gscProperty;
    if (!matchedSite) {
      const sites = await fetch('https://www.googleapis.com/webmasters/v3/sites', {
        headers: { Authorization: `Bearer ${accessToken}` }
      }).then(r => r.json());
      matchedSite = (sites.siteEntry || []).map(s => s.siteUrl).find(s => s.includes(domain.replace(/^www\./, '')));
    }
    if (!matchedSite) return res.status(400).json({ error: 'GSC property not found. Set it in Project Settings.' });

    const baseUrl = `https://${domain}`;

    // Discover all pages via sitemap + WP REST API (same as PageSpeed/On-Page)
    const authHeaders = getWpAuthHeaders(project);
    const discovered = await discoverPages(baseUrl, project.wordpress_url, authHeaders);
    const allPages = discovered.map(p => p.url).filter(Boolean);
    // Ensure homepage is included
    if (!allPages.some(u => u.replace(/\/$/, '') === baseUrl)) allPages.unshift(baseUrl + '/');
    console.log(`[indexing] Checking ${allPages.length} pages for project ${projectId}`);

    // Cancel any running indexing audits
    await pool.query(`UPDATE audits SET status='failed', completed_at=NOW() WHERE project_id=$1 AND pillar='indexing' AND status='running'`, [projectId]);

    // Create audit record
    const auditRes2 = await pool.query(
      `INSERT INTO audits (project_id, pillar, status, audit_data, started_at) VALUES ($1::int, 'indexing', 'running', $2::jsonb, NOW()) RETURNING id`,
      [parseInt(projectId), JSON.stringify({ progress: 0, total: allPages.length })]
    );
    const auditId = auditRes2.rows[0].id;

    // Return immediately
    res.json({ auditId, status: 'running', total: allPages.length });

    // Run in background
    (async () => {
      try {
        const results = [];
        for (const pageUrl of allPages) {
          try {
            const inspRes = await fetch('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', {
              method: 'POST',
              headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ inspectionUrl: pageUrl, siteUrl: matchedSite })
            });
            if (inspRes.ok) {
              const inspData = await inspRes.json();
              const idx = inspData.inspectionResult?.indexStatusResult || {};
              const mobile = inspData.inspectionResult?.mobileUsabilityResult || {};
              const rich = inspData.inspectionResult?.richResultsResult || {};
              let path;
              try { path = new URL(pageUrl).pathname; } catch { path = pageUrl; }

              results.push({
                url: pageUrl, path,
                verdict: idx.verdict || 'UNKNOWN',
                coverageState: idx.coverageState || 'Unknown',
                robotsTxtState: idx.robotsTxtState || null,
                indexingState: idx.indexingState || null,
                pageFetchState: idx.pageFetchState || null,
                lastCrawlTime: idx.lastCrawlTime || null,
                crawledAs: idx.crawledAs || null,
                googleCanonical: idx.googleCanonical || null,
                userCanonical: idx.userCanonical || null,
                referringUrls: idx.referringUrls || [],
                mobileVerdict: mobile.verdict || null,
                mobileIssues: (mobile.issues || []).map(i => i.issueType),
                richVerdict: rich.verdict || null,
              });
            } else {
              let path;
              try { path = new URL(pageUrl).pathname; } catch { path = pageUrl; }
              const errText = await inspRes.text();
              results.push({ url: pageUrl, path, verdict: 'ERROR', coverageState: `API error: ${inspRes.status}`, error: errText.substring(0, 100) });
            }
          } catch (e) {
            let path;
            try { path = new URL(pageUrl).pathname; } catch { path = pageUrl; }
            results.push({ url: pageUrl, path, verdict: 'ERROR', coverageState: e.message });
          }

          // Update progress every 5 pages
          if (results.length % 5 === 0 || results.length === allPages.length) {
            await pool.query(`UPDATE audits SET audit_data=$1 WHERE id=$2`,
              [JSON.stringify({ progress: results.length, total: allPages.length }), auditId]);
            console.log(`[indexing] Progress: ${results.length}/${allPages.length} pages`);
          }
        }

        const indexed = results.filter(r => r.verdict === 'PASS').length;
        const notIndexed = results.filter(r => r.verdict === 'FAIL' || r.verdict === 'NEUTRAL').length;
        const errors = results.filter(r => r.verdict === 'ERROR').length;

        const sortedResults = results.sort((a, b) => {
          const order = { FAIL: 0, NEUTRAL: 1, ERROR: 2, UNKNOWN: 3, PASS: 4 };
          return (order[a.verdict] || 3) - (order[b.verdict] || 3);
        });

        const auditData = { total: sortedResults.length, indexed, notIndexed, errors, results: sortedResults, ran_at: new Date().toISOString() };
        await pool.query(`UPDATE audits SET status='completed', completed_at=NOW(), audit_data=$1 WHERE id=$2`,
          [JSON.stringify(auditData), auditId]);
        console.log(`[indexing] Done: ${indexed} indexed, ${notIndexed} not indexed, ${errors} errors out of ${results.length}`);
      } catch (bgErr) {
        console.error('[indexing] Background error:', bgErr.message);
        try { await pool.query(`UPDATE audits SET status='failed', completed_at=NOW(), audit_data=$1 WHERE id=$2`,
          [JSON.stringify({ error: bgErr.message }), auditId]); } catch (e2) {}
      }
    })();
  } catch (e) {
    console.error('[indexing] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get latest indexing results (persistence across navigation + polling)
app.get('/api/projects/:projectId/audits/indexing/latest', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, status, audit_data, started_at, completed_at FROM audits WHERE project_id=$1 AND pillar='indexing' ORDER BY started_at DESC LIMIT 1`,
      [req.params.projectId]
    );
    if (result.rows.length === 0) return res.json({ status: 'none', results: [] });
    const audit = result.rows[0];
    // Auto-fail stuck running audits
    if (audit.status === 'running' && audit.started_at) {
      const elapsed = Date.now() - new Date(audit.started_at).getTime();
      if (elapsed > 10 * 60 * 1000) {
        await pool.query(`UPDATE audits SET status='failed', completed_at=NOW(), audit_data='{"error":"Audit timed out"}'::jsonb WHERE id=$1`, [audit.id]);
        // Fall through to find last completed audit below
      } else {
        // Still running — return progress
        const data = typeof audit.audit_data === 'string' ? JSON.parse(audit.audit_data) : (audit.audit_data || {});
        return res.json({ status: 'running', ...data, completed_at: audit.completed_at });
      }
    }
    if (audit.status === 'completed') {
      const data = typeof audit.audit_data === 'string' ? JSON.parse(audit.audit_data) : (audit.audit_data || {});
      return res.json({ status: audit.status, ...data, completed_at: audit.completed_at });
    }
    // Latest audit is failed/timed-out — find last completed one instead
    const completedResult = await pool.query(
      `SELECT id, status, audit_data, started_at, completed_at FROM audits WHERE project_id=$1 AND pillar='indexing' AND status='completed' ORDER BY started_at DESC LIMIT 1`,
      [req.params.projectId]
    );
    if (completedResult.rows.length > 0) {
      const completed = completedResult.rows[0];
      const data = typeof completed.audit_data === 'string' ? JSON.parse(completed.audit_data) : (completed.audit_data || {});
      return res.json({ status: 'completed', ...data, completed_at: completed.completed_at, note: 'Last run failed; showing previous results.' });
    }
    // No completed audits at all
    res.json({ status: 'none', results: [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== GBP PROFILE (from Chrome Extension) ====================

// Store GBP profile data scraped by the extension
app.post('/api/projects/:projectId/gbp-profile', async (req, res) => {
  const { projectId } = req.params;
  const profileData = req.body;
  try {
    // Store in project_integrations as kind='gbp_profile'
    await pool.query(
      `INSERT INTO project_integrations (project_id, kind, config, status, updated_at)
       VALUES ($1, 'gbp_profile', $2, 'connected', NOW())
       ON CONFLICT (project_id, kind)
       DO UPDATE SET config=$2, status='connected', updated_at=NOW()`,
      [projectId, JSON.stringify(profileData)]
    );
    console.log(`[gbp-profile] Stored GBP profile for project ${projectId}: ${profileData.business?.name || 'unknown'}`);
    res.json({ ok: true, message: 'GBP profile data saved' });
  } catch (e) {
    console.error('[gbp-profile] Save error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get stored GBP profile data
app.get('/api/projects/:projectId/gbp-profile', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT config, updated_at FROM project_integrations WHERE project_id=$1 AND kind='gbp_profile'`,
      [req.params.projectId]
    );
    if (result.rows.length === 0) return res.json({ profile: null });
    const config = typeof result.rows[0].config === 'string' ? JSON.parse(result.rows[0].config) : result.rows[0].config;
    res.json({ profile: config, updated_at: result.rows[0].updated_at });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== CITATIONS & DIRECTORIES ====================

// Get all directories with project-specific status
app.get('/api/projects/:projectId/citations', async (req, res) => {
  try {
    const saved = await pool.query(
      'SELECT directory_name, status, listing_url, notes, updated_at FROM citations WHERE project_id=$1',
      [req.params.projectId]
    );
    const statusMap = {};
    for (const row of saved.rows) {
      statusMap[row.directory_name] = { status: row.status, listing_url: row.listing_url, notes: row.notes, updated_at: row.updated_at };
    }
    const directories = AUSTRALIAN_DIRECTORIES.map(d => ({
      ...d,
      status: statusMap[d.name]?.status || 'not_listed',
      listing_url: statusMap[d.name]?.listing_url || '',
      notes: statusMap[d.name]?.notes || '',
      updated_at: statusMap[d.name]?.updated_at || null,
    }));
    const listed = directories.filter(d => d.status === 'listed').length;
    const pending = directories.filter(d => d.status === 'pending').length;
    res.json({ directories, stats: { total: directories.length, listed, pending, not_listed: directories.length - listed - pending } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Scan all directories to check if business is listed
app.post('/api/projects/:projectId/citations/scan', async (req, res) => {
  const { projectId } = req.params;
  try {
    const proj = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    if (proj.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = proj.rows[0];
    const businessName = project.business_name || project.name || '';
    const domain = (project.domain || '').replace(/^https?:\/\//, '').replace(/\/$/, '');

    if (!SERPAPI_KEY) return res.status(400).json({ error: 'SerpAPI key not configured' });
    if (!businessName) return res.status(400).json({ error: 'Business name required in Project Settings' });

    const location = project.location || '';
    const gbpPlaceId = project.gbp_location_id || '';

    console.log(`[citations] Scanning ${AUSTRALIAN_DIRECTORIES.length} directories for "${businessName}" (${domain})`);

    // Platforms that can't be checked via site: search — detect differently
    const specialPlatforms = {
      'Google Business Profile': async () => {
        // If GBP is connected or Place ID is set, it's listed
        if (gbpPlaceId) return { status: 'listed', listing_url: `https://www.google.com/maps/place/?q=place_id:${gbpPlaceId}`, notes: 'Verified: GBP Place ID connected in Project Settings' };
        // Otherwise search Google Maps
        try {
          const mapsData = await serpApiSearch({ engine: 'google_maps', q: `${businessName} ${location}`, api_key: SERPAPI_KEY });
          const match = (mapsData.local_results || []).find(r => r.title?.toLowerCase().includes(businessName.toLowerCase().split(' ')[0]) || (r.website && r.website.includes(domain)));
          if (match) return { status: 'listed', listing_url: match.place_id ? `https://www.google.com/maps/place/?q=place_id:${match.place_id}` : match.link, notes: `Found on Google Maps: ${match.title}, ${match.rating || '?'} stars, ${match.reviews || 0} reviews` };
        } catch (e) {}
        return null;
      },
      'Apple Maps (Apple Business Connect)': async () => {
        // Can't check programmatically — search Google for apple maps listing
        try {
          const data = await serpApiSearch({ engine: 'google', q: `site:maps.apple.com "${businessName}"`, num: 3, api_key: SERPAPI_KEY });
          if ((data.organic_results || []).length > 0) return { status: 'listed', listing_url: data.organic_results[0].link, notes: `Found on Apple Maps` };
        } catch (e) {}
        return null;
      },
      'Bing Places': async () => {
        try {
          const data = await serpApiSearch({ engine: 'google', q: `site:bing.com/maps "${businessName}" ${location.split(',')[0] || ''}`, num: 3, api_key: SERPAPI_KEY });
          if ((data.organic_results || []).length > 0) return { status: 'listed', listing_url: data.organic_results[0].link, notes: `Found on Bing Maps` };
        } catch (e) {}
        return null;
      },
      'Facebook Business': async () => {
        try {
          const data = await serpApiSearch({ engine: 'google', q: `site:facebook.com "${businessName}" ${location.split(',')[0] || ''}`, num: 5, api_key: SERPAPI_KEY });
          const match = (data.organic_results || []).find(r => r.link?.includes('facebook.com/') && !r.link?.includes('/posts/') && !r.link?.includes('/photos/'));
          if (match) return { status: 'listed', listing_url: match.link, notes: `Found: ${match.title || ''}`.trim() };
        } catch (e) {}
        return null;
      },
      'LinkedIn Company': async () => {
        try {
          const data = await serpApiSearch({ engine: 'google', q: `site:linkedin.com/company "${businessName}"`, num: 3, api_key: SERPAPI_KEY });
          const match = (data.organic_results || []).find(r => r.link?.includes('linkedin.com/company/'));
          if (match) return { status: 'listed', listing_url: match.link, notes: `Found: ${match.title || ''}`.trim() };
        } catch (e) {}
        return null;
      },
    };

    const results = [];
    for (const dir of AUSTRALIAN_DIRECTORIES) {
      try {
        // Use special detection for platforms that don't work with site: search
        if (specialPlatforms[dir.name]) {
          const specialResult = await specialPlatforms[dir.name]();
          if (specialResult) {
            results.push({ name: dir.name, ...specialResult });
            console.log(`[citations] ${dir.name}: FOUND (special)`);
            continue;
          }
          // If special check found nothing, mark as not listed
          results.push({ name: dir.name, status: 'not_listed', listing_url: null, notes: 'Not found via automated scan' });
          console.log(`[citations] ${dir.name}: NOT FOUND (special)`);
          continue;
        }

        // Standard site: search for regular directories
        const searchData = await serpApiSearch({
          engine: 'google',
          q: `site:${dir.url} "${businessName}"`,
          num: 3,
          api_key: SERPAPI_KEY,
        });

        const organicResults = searchData.organic_results || [];
        let found = organicResults.length > 0;
        let listingUrl = found ? organicResults[0].link : null;
        let snippet = found ? (organicResults[0].snippet || '') : '';

        // Backup: search by domain
        if (!found && domain) {
          const domainSearch = await serpApiSearch({
            engine: 'google',
            q: `site:${dir.url} "${domain}"`,
            num: 3,
            api_key: SERPAPI_KEY,
          });
          const domainResults = domainSearch.organic_results || [];
          if (domainResults.length > 0) {
            found = true;
            listingUrl = domainResults[0].link;
            snippet = `Found via domain. ${domainResults[0].snippet || ''}`.trim();
          }
        }

        results.push({
          name: dir.name,
          status: found ? 'listed' : 'not_listed',
          listing_url: listingUrl,
          notes: found ? `Auto-detected: ${snippet}`.substring(0, 200) : '',
        });

        console.log(`[citations] ${dir.name}: ${found ? 'FOUND' : 'NOT FOUND'}`);
      } catch (e) {
        console.log(`[citations] Error checking ${dir.name}:`, e.message);
        results.push({ name: dir.name, status: 'not_listed', listing_url: null, notes: `Scan error: ${e.message}` });
      }
    }

    // Save all results to DB
    for (const r of results) {
      await pool.query(
        `INSERT INTO citations (project_id, directory_name, status, listing_url, notes, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (project_id, directory_name)
         DO UPDATE SET status=$3, listing_url=COALESCE($4, citations.listing_url), notes=$5, updated_at=NOW()`,
        [projectId, r.name, r.status, r.listing_url, r.notes]
      );
    }

    const listed = results.filter(r => r.status === 'listed').length;
    console.log(`[citations] Scan complete: ${listed}/${results.length} listed`);
    res.json({ results, stats: { total: results.length, listed, not_listed: results.length - listed } });
  } catch (e) {
    console.error('[citations] Scan error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Update citation status for a directory
app.put('/api/projects/:projectId/citations/:directoryName', async (req, res) => {
  const { projectId, directoryName } = req.params;
  const { status, listing_url, notes } = req.body;
  try {
    await pool.query(
      `INSERT INTO citations (project_id, directory_name, status, listing_url, notes, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (project_id, directory_name)
       DO UPDATE SET status=COALESCE($3, citations.status), listing_url=COALESCE($4, citations.listing_url), notes=COALESCE($5, citations.notes), updated_at=NOW()`,
      [projectId, decodeURIComponent(directoryName), status || 'not_listed', listing_url || null, notes || null]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== ON-PAGE AUDIT (Yoast + Content Analysis) ====================

// Run on-page audit — fetches Yoast scores + WP pages, analyzes content
app.post('/api/projects/:projectId/onpage-audit/run', async (req, res) => {
  const { projectId } = req.params;
  try {
    // Get WP URL from project
    const projRes = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    if (projRes.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = projRes.rows[0];
    const wpUrl = project.wordpress_url;
    if (!wpUrl) return res.status(400).json({ error: 'WordPress URL not configured. Set it in Project Settings.' });

    const wpBase = wpUrl.replace(/\/$/, '');
    const domain = wpBase.replace(/^https?:\/\//, '').replace(/\/$/, '');

    // 1. Try to get Yoast scores from seoroom-helper plugin
    let yoastMap = {};
    try {
      const yoastResp = await fetch(`${wpBase}/wp-json/seoroom/v1/yoast-scores`, {
        signal: AbortSignal.timeout(30000),
        ...(getWpAuthHeaders(project) ? { headers: getWpAuthHeaders(project) } : {}),
      });
      if (yoastResp.ok) {
        const scores = await yoastResp.json();
        for (const s of scores) { yoastMap[s.id] = s; }
        console.log(`[onpage-audit] Got Yoast scores for ${scores.length} pages via plugin`);
      }
    } catch (e) {
      console.log(`[onpage-audit] seoroom plugin not available: ${e.message}`);
    }

    // 2. Fetch all published pages from WP REST API (with auth if available)
    const wpAuth = getWpAuthHeaders(project);
    const wpFetchOpts = { signal: AbortSignal.timeout(30000), ...(wpAuth ? { headers: wpAuth } : {}) };
    let allPages = [];
    let page = 1;
    while (true) {
      try {
        const resp = await fetch(`${wpBase}/wp-json/wp/v2/pages?per_page=50&page=${page}&status=publish`, wpFetchOpts);
        if (!resp.ok) break;
        const pages = await resp.json();
        if (!Array.isArray(pages) || pages.length === 0) break;
        allPages = allPages.concat(pages);
        if (pages.length < 50) break;
        page++;
      } catch { break; }
    }
    // Also fetch posts
    page = 1;
    while (true) {
      try {
        const resp = await fetch(`${wpBase}/wp-json/wp/v2/posts?per_page=50&page=${page}&status=publish`, wpFetchOpts);
        if (!resp.ok) break;
        const posts = await resp.json();
        if (!Array.isArray(posts) || posts.length === 0) break;
        allPages = allPages.concat(posts);
        if (posts.length < 50) break;
        page++;
      } catch { break; }
    }

    console.log(`[onpage-audit] Fetched ${allPages.length} pages/posts`);
    if (allPages.length === 0) {
      // Check if REST API requires auth
      const testResp = await fetch(`${wpBase}/wp-json/wp/v2/pages?per_page=1`, { signal: AbortSignal.timeout(10000) }).catch(() => null);
      const isAuthRequired = testResp && testResp.status === 401;
      const msg = isAuthRequired
        ? 'WordPress REST API requires authentication. Add WP Username and Application Password in Project Settings.'
        : 'No published pages found. Check that the WordPress URL is correct and the REST API is accessible.';
      return res.json({ pages: [], message: msg });
    }

    // 3. Analyze each page
    const isElementor = project.is_elementor_site;
    const results = [];
    for (const pg of allPages) {
      const url = pg.link || '';
      const slug = pg.slug || '';
      const title = pg.title?.rendered || '';
      let content = pg.content?.rendered || '';
      const yoast = pg.yoast_head_json || {};
      const pluginData = yoastMap[pg.id];
      // Fallback: read from seoroom_yoast (added by plugin to REST response) or meta fields
      const srYoast = pg.seoroom_yoast || {};
      const pgMeta = pg.meta || {};

      // Elementor fix: content.rendered is often empty/minimal for Elementor pages.
      // Fetch the actual rendered HTML from the live page to get real word count.
      let prelimPlain = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      let prelimWords = prelimPlain.split(/\s+/).filter(Boolean).length;
      if (isElementor && prelimWords < 50 && url) {
        try {
          const liveResp = await fetch(url, { signal: AbortSignal.timeout(10000) });
          if (liveResp.ok) {
            const liveHtml = await liveResp.text();
            // Extract main content area — look for elementor-widget-text-editor or main content
            const mainMatch = liveHtml.match(/<main[\s\S]*?<\/main>/i) ||
                              liveHtml.match(/<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>[\s\S]*?<\/div>/i) ||
                              liveHtml.match(/<article[\s\S]*?<\/article>/i);
            if (mainMatch) {
              content = mainMatch[0];
            } else {
              // Fallback: extract body content between header and footer
              const bodyMatch = liveHtml.match(/<body[\s\S]*?<\/body>/i);
              if (bodyMatch) content = bodyMatch[0];
            }
            console.log(`[onpage-audit] Elementor page ${slug}: fetched live HTML, content length ${content.length}`);
          }
        } catch (e) {
          console.log(`[onpage-audit] Failed to fetch live page ${slug}: ${e.message}`);
        }
      }

      // Extract fields
      const metaTitle = yoast.title || '';
      const metaDesc = yoast.description || '';
      const focusKeyword = pluginData?.focus_keyword || srYoast.focus_keyword || pgMeta._yoast_wpseo_focuskw || pgMeta.yoast_wpseo_focuskw || '';
      const plainText = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const wordCount = plainText.split(/\s+/).filter(Boolean).length;

      // Count links
      const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>/gi;
      let m; let internalLinks = 0; let externalLinks = 0;
      while ((m = linkRegex.exec(content)) !== null) {
        const href = m[1];
        if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;
        if (href.includes(domain) || href.startsWith('/')) internalLinks++;
        else if (href.startsWith('http')) externalLinks++;
      }

      // Count images
      const imgMatches = content.match(/<img[^>]*>/gi) || [];
      const images = imgMatches.length;
      const imagesWithAlt = imgMatches.filter(img => /alt=["'][^"']+["']/i.test(img)).length;

      // Extract H1
      const h1Match = content.match(/<h1[^>]*>(.*?)<\/h1>/i);
      const h1 = h1Match ? h1Match[1].replace(/<[^>]+>/g, '') : title;

      // Determine Yoast score
      let yoastScore = 'gray';
      const rawSeoScore = pluginData?.seo_score || srYoast.seo_score || pgMeta._yoast_wpseo_linkdex || 0;
      if (rawSeoScore) {
        const seoScore = parseInt(rawSeoScore) || 0;
        yoastScore = seoScore >= 70 ? 'green' : seoScore >= 40 ? 'orange' : 'red';
      } else {
        // Heuristic based on meta completeness (Yoast only updates linkdex when page is opened in editor)
        const hasGoodTitle = metaTitle.length >= 30 && metaTitle.length <= 60;
        const hasGoodDesc = metaDesc.length >= 120 && metaDesc.length <= 155;
        const hasFocus = !!focusKeyword;
        const goodCount = [hasGoodTitle, hasGoodDesc, hasFocus, wordCount >= 500].filter(Boolean).length;
        yoastScore = goodCount >= 3 ? 'green' : goodCount >= 1 ? 'orange' : 'red';
      }

      // Build issues
      const issues = [];
      const kwLower = focusKeyword.toLowerCase();

      if (!metaTitle) issues.push({ type: 'problem', text: 'Meta title is missing' });
      else {
        if (metaTitle.length < 30) issues.push({ type: 'problem', text: `Meta title too short (${metaTitle.length} chars) — should be 50-60` });
        if (metaTitle.length > 60) issues.push({ type: 'warning', text: `Meta title too long (${metaTitle.length} chars) — max 60` });
        if (metaTitle.length >= 50 && metaTitle.length <= 60) issues.push({ type: 'good', text: 'Title tag length is good' });
        if (kwLower && metaTitle.toLowerCase().includes(kwLower)) issues.push({ type: 'good', text: 'Title tag contains focus keyword' });
        else if (kwLower) issues.push({ type: 'warning', text: 'Focus keyword not in title tag' });
      }

      if (!metaDesc) issues.push({ type: 'problem', text: 'Meta description is empty' });
      else {
        if (metaDesc.length < 120) issues.push({ type: 'warning', text: `Meta description short (${metaDesc.length} chars) — aim for 120-155` });
        if (metaDesc.length > 155) issues.push({ type: 'warning', text: `Meta description too long (${metaDesc.length} chars) — max 155` });
        if (metaDesc.length >= 120 && metaDesc.length <= 155) issues.push({ type: 'good', text: 'Meta description length is good' });
        if (kwLower && metaDesc.toLowerCase().includes(kwLower)) issues.push({ type: 'good', text: 'Meta description contains focus keyword' });
      }

      if (!focusKeyword) issues.push({ type: 'problem', text: 'No focus keyword set' });
      if (wordCount < 300) issues.push({ type: 'problem', text: `Content is very thin (${wordCount} words)` });
      else if (wordCount < 800) issues.push({ type: 'warning', text: `Content could be longer (${wordCount} words) — aim for 800+` });
      else issues.push({ type: 'good', text: `Good content length (${wordCount} words)` });

      if (internalLinks < 3) issues.push({ type: 'warning', text: `Only ${internalLinks} outbound links — add more for better linking` });
      else issues.push({ type: 'good', text: `Good outbound linking (${internalLinks} links)` });

      if (images > 0 && imagesWithAlt < images) issues.push({ type: 'warning', text: `${images - imagesWithAlt} image(s) missing alt text` });
      else if (images > 0) issues.push({ type: 'good', text: 'All images have alt text' });

      if (externalLinks === 0) issues.push({ type: 'warning', text: 'No external links' });

      results.push({
        id: pg.id,
        url: url.replace(wpBase, '') || '/',
        title,
        yoastScore,
        focusKeyword,
        wordCount,
        metaTitle,
        metaTitleLen: metaTitle.length,
        metaDesc,
        metaDescLen: metaDesc.length,
        h1,
        internalLinks,
        externalLinks,
        images,
        imagesWithAlt,
        issues
      });
    }

    // Calculate inbound links — for each page, count how many other pages link to it
    const allUrls = allPages.map(pg => (pg.link || '').replace(/\/$/, ''));
    for (const result of results) {
      const targetUrl = (wpBase + result.url).replace(/\/$/, '');
      const targetSlug = result.url.replace(/\//g, '');
      let inbound = 0;
      const inboundFrom = [];
      for (const pg of allPages) {
        if (pg.id === result.id) continue;
        const pgContent = pg.content?.rendered || '';
        // Check if this page's content links to our target
        const hrefRegex = /href=["']([^"']+)["']/gi;
        let hm;
        while ((hm = hrefRegex.exec(pgContent)) !== null) {
          const href = hm[1].replace(/\/$/, '');
          if (href === targetUrl || href === result.url.replace(/\/$/, '') || href.endsWith('/' + targetSlug)) {
            inbound++;
            inboundFrom.push({ title: pg.title?.rendered || '', url: (pg.link || '').replace(wpBase, '') || '/' });
            break; // count each source page once
          }
        }
      }
      result.inboundLinks = inbound;
      result.inboundFrom = inboundFrom;
      // Add inbound link issue to the issues array
      if (inbound === 0) {
        result.issues.push({ type: 'problem', text: 'No inbound links — orphan page, no other pages link here' });
      } else if (inbound < 3) {
        result.issues.push({ type: 'warning', text: `Only ${inbound} inbound link${inbound > 1 ? 's' : ''} — aim for 3+` });
      } else {
        result.issues.push({ type: 'good', text: `Good inbound linking (${inbound} pages link here)` });
      }
    }

    // Sort: red first, then orange, then green
    const scoreOrder = { red: 0, orange: 1, gray: 2, green: 3 };
    results.sort((a, b) => (scoreOrder[a.yoastScore] || 2) - (scoreOrder[b.yoastScore] || 2));

    console.log(`[onpage-audit] Analyzed ${results.length} pages. Red: ${results.filter(r => r.yoastScore === 'red').length}, Orange: ${results.filter(r => r.yoastScore === 'orange').length}, Green: ${results.filter(r => r.yoastScore === 'green').length}`);

    // Cache results in DB for persistence
    try {
      await pool.query(
        `INSERT INTO onpage_audit_cache (project_id, results, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (project_id) DO UPDATE SET results = $2, updated_at = NOW()`,
        [projectId, JSON.stringify(results)]
      );
    } catch (cacheErr) { console.log('[onpage-audit] Cache save failed:', cacheErr.message); }

    res.json({ pages: results });
  } catch (e) {
    console.error('[onpage-audit] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get cached on-page audit results
app.get('/api/projects/:projectId/onpage-audit/results', async (req, res) => {
  try {
    const r = await pool.query('SELECT results, updated_at FROM onpage_audit_cache WHERE project_id=$1', [req.params.projectId]);
    if (r.rows.length === 0) return res.json({ pages: [] });
    const results = typeof r.rows[0].results === 'string' ? JSON.parse(r.rows[0].results) : r.rows[0].results;
    res.json({ pages: results, cached_at: r.rows[0].updated_at });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== ON-PAGE FIX (WordPress Write-Back) ====================

// Helper: get WP auth headers for a project
function getWpAuthHeaders(project) {
  if (!project.wp_username || !project.wp_app_password) return null;
  const token = Buffer.from(`${project.wp_username}:${project.wp_app_password}`).toString('base64');
  return { 'Authorization': `Basic ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'SEORoom-Dashboard/5.0 (WordPress Integration)' };
}

// Helper: read current Yoast meta from WordPress for a page/post
// Returns { type, title, yoast_wpseo_title, ..., wpId } — wpId is the resolved numeric ID
async function readWpYoastMeta(wpBase, pageId, authHeaders) {
  const parseWpData = (data, type) => {
    const yoast = data.yoast_head_json || {};
    const seoroom = data.seoroom_yoast || {};
    const meta = data.meta || {};
    return {
      type,
      wpId: data.id, // always numeric
      title: data.title?.rendered || '',
      yoast_wpseo_title: meta._yoast_wpseo_title || meta.yoast_wpseo_title || seoroom.title || yoast.title || '',
      yoast_wpseo_metadesc: meta._yoast_wpseo_metadesc || meta.yoast_wpseo_metadesc || seoroom.description || yoast.description || '',
      yoast_wpseo_focuskw: meta._yoast_wpseo_focuskw || meta.yoast_wpseo_focuskw || seoroom.focus_keyword || ''
    };
  };

  // Try numeric ID lookup first
  if (!isNaN(Number(pageId)) && Number(pageId) > 0) {
    for (const type of ['pages', 'posts']) {
      try {
        const resp = await fetch(`${wpBase}/wp-json/wp/v2/${type}/${pageId}`, {
          headers: authHeaders,
          signal: AbortSignal.timeout(15000)
        });
        if (resp.ok) return parseWpData(await resp.json(), type);
      } catch (e) { /* try next type */ }
    }
  }

  // Fallback: slug-based lookup (handles site graph pages with slug IDs)
  const slug = String(pageId).replace(/^\/|\/$/g, '').split('/').pop() || pageId;
  for (const type of ['pages', 'posts']) {
    try {
      const resp = await fetch(`${wpBase}/wp-json/wp/v2/${type}?slug=${encodeURIComponent(slug)}&per_page=1`, {
        headers: authHeaders,
        signal: AbortSignal.timeout(15000)
      });
      if (resp.ok) {
        const items = await resp.json();
        if (Array.isArray(items) && items.length > 0) return parseWpData(items[0], type);
      }
    } catch (e) { /* try next type */ }
  }
  return null;
}

// AI-generate suggested meta fixes for a page
app.post('/api/projects/:projectId/onpage-audit/suggest', async (req, res) => {
  const { projectId } = req.params;
  const { pages } = req.body; // array of { id, title, url, metaTitle, metaDesc, focusKeyword, h1, wordCount, issues }
  if (!pages || !pages.length) return res.status(400).json({ error: 'No pages provided' });

  try {
    const projRes = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    if (projRes.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = projRes.rows[0];

    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const pagesData = pages.map(p => ({
      id: p.id, title: p.title, url: p.url,
      current_meta_title: p.metaTitle || '(empty)',
      current_meta_description: p.metaDesc || '(empty)',
      current_focus_keyword: p.focusKeyword || '(not set)',
      h1: p.h1, word_count: p.wordCount,
      problems: (p.issues || []).filter(i => i.type === 'problem' || i.type === 'warning').map(i => i.text)
    }));

    // Batch pages in groups of 5 to avoid Haiku timeout/token issues
    const BATCH_SIZE = 5;
    const allSuggestions = [];
    for (let i = 0; i < pagesData.length; i += BATCH_SIZE) {
      const batch = pagesData.slice(i, i + BATCH_SIZE);
      console.log(`[onpage-suggest] Processing batch ${Math.floor(i/BATCH_SIZE)+1}/${Math.ceil(pagesData.length/BATCH_SIZE)} (${batch.length} pages)`);

      const resp = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: `You are an SEO expert. Generate optimized meta fixes for these WordPress pages.

Business: ${project.business_name || project.name} | Domain: ${project.domain} | Industry: ${project.industry || 'general'} | Location: ${project.location || ''}

Pages to fix:
${JSON.stringify(batch, null, 2)}

For each page, return a JSON array with objects:
{
  "id": <page_id>,
  "suggested_title": "<optimized meta title, 50-60 chars, include primary keyword near start>",
  "suggested_desc": "<optimized meta description, 120-155 chars, compelling with CTA>",
  "suggested_keyword": "<best focus keyword for this page based on content and business>"
}

Rules:
- Meta title: 50-60 characters, keyword near the front, include brand name at end with | separator
- Meta description: 120-155 characters, include keyword naturally, add call-to-action
- Focus keyword: choose the most relevant, search-intent-matching keyword for each page
- If current values are already good, return them unchanged
- ONLY return valid JSON array, no explanation`
        }]
      });

      const text = resp.content[0].text.trim();
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        console.error(`[onpage-suggest] Batch ${Math.floor(i/BATCH_SIZE)+1} returned invalid format:`, text.substring(0, 200));
        continue; // skip bad batch, don't fail entire request
      }
      try {
        const batchSuggestions = JSON.parse(jsonMatch[0]);
        allSuggestions.push(...batchSuggestions);
      } catch (parseErr) {
        console.error(`[onpage-suggest] Batch ${Math.floor(i/BATCH_SIZE)+1} JSON parse error:`, parseErr.message);
        continue;
      }
    }

    if (allSuggestions.length === 0) {
      return res.status(500).json({ error: 'AI failed to generate suggestions for any pages' });
    }

    // Auto-add H1 fix flag for pages missing H1
    for (const s of allSuggestions) {
      const page = pages.find(p => String(p.id) === String(s.id));
      if (page) {
        const issues = (page.issues || []).map(i => typeof i === 'string' ? i : (i.text || ''));
        if (issues.some(i => i.includes('Missing H1'))) {
          s.add_h1 = true;
          s.h1_text = page.title || s.suggested_title || '';
        }
      }
    }

    res.json({ suggestions: allSuggestions });
  } catch (e) {
    console.error('[onpage-suggest] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Apply on-page fixes to WordPress (with rollback snapshot)
// Bulk fix — suggest + apply in one server-side call (doesn't stop on frontend navigation)
app.post('/api/projects/:projectId/onpage-audit/bulk-fix', async (req, res) => {
  const { projectId } = req.params;
  const { pages } = req.body; // array of { id, url, title, meta_title, meta_description, focusKeyword, h1, word_count, issues }
  if (!pages || !pages.length) return res.status(400).json({ error: 'No pages provided' });

  try {
    const projRes = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    if (projRes.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = projRes.rows[0];
    const wpBase = (project.wordpress_url || '').replace(/\/$/, '');
    if (!wpBase) return res.status(400).json({ error: 'WordPress URL not configured' });
    const authHeaders = getWpAuthHeaders(project);
    if (!authHeaders) return res.status(400).json({ error: 'WordPress Application Password not configured' });

    console.log(`[bulk-fix] Starting bulk fix for ${pages.length} pages`);

    // Step 1: Get AI suggestions (reuse suggest logic)
    const pagesData = pages.map(p => `Page ID: ${p.id}\nURL: ${p.url}\nTitle: ${p.title}\nCurrent Meta Title: ${p.metaTitle || '(none)'}\nCurrent Meta Desc: ${p.metaDesc || '(none)'}\nCurrent Focus Keyword: ${p.focusKeyword || '(none)'}\nH1: ${p.h1 || '(none)'}\nWord Count: ${p.wordCount || 0}\nIssues: ${(p.issues || []).map(i => typeof i === 'string' ? i : i.text).join(', ')}`);

    const BATCH_SIZE = 5;
    const allSuggestions = [];
    for (let i = 0; i < pagesData.length; i += BATCH_SIZE) {
      const batch = pagesData.slice(i, i + BATCH_SIZE);
      console.log(`[bulk-fix] Suggesting batch ${Math.floor(i/BATCH_SIZE)+1}/${Math.ceil(pagesData.length/BATCH_SIZE)}`);
      const resp = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        messages: [{ role: 'user', content: `You are an SEO expert. Generate optimized meta fixes for these WordPress pages.\n\nFor each page, suggest:\n- suggested_title (50-60 chars, include primary keyword)\n- suggested_desc (120-155 chars, compelling with CTA)\n- suggested_keyword (2-4 word focus keyword)\n\nReturn ONLY a JSON array: [{\"id\": ..., \"suggested_title\": \"...\", \"suggested_desc\": \"...\", \"suggested_keyword\": \"...\"}]\n\nPages:\n${batch.join('\n\n')}` }]
      });
      try {
        const text = resp.content[0].text;
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (jsonMatch) allSuggestions.push(...JSON.parse(jsonMatch[0]));
      } catch (e) { console.error('[bulk-fix] Parse error:', e.message); }
    }

    // Step 2: Apply each suggestion
    const results = [];
    for (const s of allSuggestions) {
      const page = pages.find(p => String(p.id) === String(s.id));
      if (!page) { results.push({ id: s.id, success: false, error: 'Page not found in request' }); continue; }

      try {
        const current = await readWpYoastMeta(wpBase, s.id, authHeaders);
        if (!current) { results.push({ id: s.id, success: true, skipped: true, changes: 0 }); continue; }

        const changes = [];
        if (s.suggested_title && s.suggested_title !== current.yoast_wpseo_title) changes.push({ field: 'yoast_wpseo_title', old: current.yoast_wpseo_title, new: s.suggested_title });
        if (s.suggested_desc && s.suggested_desc !== current.yoast_wpseo_metadesc) changes.push({ field: 'yoast_wpseo_metadesc', old: current.yoast_wpseo_metadesc, new: s.suggested_desc });
        if (s.suggested_keyword && s.suggested_keyword !== current.yoast_wpseo_focuskw) changes.push({ field: 'yoast_wpseo_focuskw', old: current.yoast_wpseo_focuskw, new: s.suggested_keyword });

        if (changes.length === 0) { results.push({ id: s.id, success: true, skipped: true, changes: 0 }); continue; }

        const meta = {};
        if (s.suggested_title) meta._yoast_wpseo_title = s.suggested_title;
        if (s.suggested_desc) meta._yoast_wpseo_metadesc = s.suggested_desc;
        if (s.suggested_keyword) meta._yoast_wpseo_focuskw = s.suggested_keyword;

        let writeResp = await fetch(`${wpBase}/wp-json/wp/v2/${current.type}/${current.wpId}`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ meta }), signal: AbortSignal.timeout(15000) });
        if (!writeResp.ok && (writeResp.status === 401 || writeResp.status === 403)) {
          const yoastPayload = {};
          if (s.suggested_title) yoastPayload.yoast_wpseo_title = s.suggested_title;
          if (s.suggested_desc) yoastPayload.yoast_wpseo_metadesc = s.suggested_desc;
          if (s.suggested_keyword) yoastPayload.yoast_wpseo_focuskw = s.suggested_keyword;
          writeResp = await fetch(`${wpBase}/wp-json/wp/v2/${current.type}/${current.wpId}`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ yoast_meta: yoastPayload }), signal: AbortSignal.timeout(15000) });
        }
        if (!writeResp.ok) { results.push({ id: s.id, success: false, error: `WP returned ${writeResp.status}` }); continue; }

        const verify = await readWpYoastMeta(wpBase, current.wpId, authHeaders);
        const verified = verify && ((!s.suggested_title || verify.yoast_wpseo_title === s.suggested_title) || (!s.suggested_desc || verify.yoast_wpseo_metadesc === s.suggested_desc));
        if (!verified) { results.push({ id: s.id, success: false, error: 'Verification failed' }); continue; }

        for (const ch of changes) {
          await pool.query(`INSERT INTO wp_change_history (project_id, page_id, page_url, page_title, change_type, field_name, original_value, new_value) VALUES ($1, $2, $3, $4, 'meta_fix', $5, $6, $7)`,
            [projectId, current.wpId, page.url || '', page.title || '', ch.field, ch.old, ch.new]);
        }

        // Handle H1 fix if page has Missing H1 issue
        let h1Fixed = false;
        const pageIssues = (page.issues || []).map(i => typeof i === 'string' ? i : (i.text || ''));
        if (pageIssues.some(i => i.includes('Missing H1'))) {
          try {
            const pageResp = await fetch(`${wpBase}/wp-json/wp/v2/${current.type}/${current.wpId}`, {
              headers: authHeaders, signal: AbortSignal.timeout(15000)
            });
            if (pageResp.ok) {
              const pageData = await pageResp.json();
              const content = pageData.content?.raw || pageData.content?.rendered || '';
              if (!/<h1[\s>]/i.test(content)) {
                const h1Text = page.title || s.suggested_title || '';
                const newContent = `<h1>${h1Text}</h1>\n${content}`;
                const h1WriteResp = await fetch(`${wpBase}/wp-json/wp/v2/${current.type}/${current.wpId}`, {
                  method: 'POST', headers: authHeaders,
                  body: JSON.stringify({ content: newContent }),
                  signal: AbortSignal.timeout(15000)
                });
                if (h1WriteResp.ok) {
                  h1Fixed = true;
                  await pool.query(`INSERT INTO wp_change_history (project_id, page_id, page_url, page_title, change_type, field_name, original_value, new_value) VALUES ($1, $2, $3, $4, 'h1_fix', 'content', $5, $6)`,
                    [projectId, current.wpId, page.url || '', page.title || '', content.substring(0, 5000), newContent.substring(0, 5000)]);
                  console.log(`[bulk-fix] Added H1 to page ${current.wpId}`);
                }
              } else { h1Fixed = true; }
            }
          } catch (h1Err) { console.warn(`[bulk-fix] H1 fix error:`, h1Err.message); }
        }

        results.push({ id: s.id, success: true, changes: changes.length, h1Fixed });
        console.log(`[bulk-fix] Fixed ${s.id} (${changes.length} fields${h1Fixed ? ' + H1' : ''})`);
      } catch (e) { results.push({ id: s.id, success: false, error: e.message }); }
    }

    // Step 3: Update caches (same as /fix endpoint)
    const successIds = results.filter(r => r.success).map(r => String(r.id));
    if (successIds.length > 0) {
      try {
        const graphRes = await pool.query(`SELECT id, audit_data FROM audits WHERE project_id=$1 AND pillar='site_graph' AND status='completed' ORDER BY completed_at DESC LIMIT 1`, [projectId]);
        if (graphRes.rows.length > 0) {
          const graphData = graphRes.rows[0].audit_data;
          const auditId = graphRes.rows[0].id;
          if (graphData && graphData.nodes) {
            // Update h1 for nodes where H1 was fixed
            for (const node of graphData.nodes) {
              const r = results.find(r => String(r.id) === String(node.id));
              if (r && r.h1Fixed) {
                const page = pages.find(p => String(p.id) === String(node.id));
                node.h1 = page?.title || node.title || '';
                // Rebuild issues
                const newIssues = [];
                if (!node.h1) newIssues.push('Missing H1 tag');
                if (node.word_count < 300) newIssues.push('Thin content (' + node.word_count + ' words)');
                if (!node.internal_links || node.internal_links.length === 0) newIssues.push('No outbound internal links');
                if ((node.inbound_count || 0) === 0 && node.slug !== 'home' && node.slug !== '') newIssues.push('Orphan page — no inbound links');
                node.issues = newIssues;
              }
            }
            // Recalculate stats
            graphData.stats.issues = graphData.nodes.reduce((sum, n) => sum + (n.issues || []).length, 0);
            if (!graphData.fixed_nodes) graphData.fixed_nodes = [];
            for (const id of successIds) { if (!graphData.fixed_nodes.includes(id)) graphData.fixed_nodes.push(id); }
            await pool.query(`UPDATE audits SET audit_data = $1 WHERE id = $2`, [JSON.stringify(graphData), auditId]);
          }
        }
      } catch (e) { console.log('[bulk-fix] Cache update error:', e.message); }
    }

    console.log(`[bulk-fix] Done: ${results.filter(r => r.success).length}/${results.length} succeeded`);
    res.json({ results, suggestions: allSuggestions });
  } catch (e) {
    console.error('[bulk-fix] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects/:projectId/onpage-audit/fix', async (req, res) => {
  const { projectId } = req.params;
  const { fixes } = req.body; // array of { id, url, title, new_meta_title, new_meta_desc, new_focus_keyword }
  if (!fixes || !fixes.length) return res.status(400).json({ error: 'No fixes provided' });

  try {
    const projRes = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    if (projRes.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = projRes.rows[0];
    const wpBase = (project.wordpress_url || '').replace(/\/$/, '');
    if (!wpBase) return res.status(400).json({ error: 'WordPress URL not configured' });

    const authHeaders = getWpAuthHeaders(project);
    if (!authHeaders) return res.status(400).json({ error: 'WordPress Application Password not configured. Go to Settings → WordPress Auth.' });

    const results = [];
    for (const fix of fixes) {
      try {
        // 1. Read current values from WordPress (before snapshot)
        const current = await readWpYoastMeta(wpBase, fix.id, authHeaders);
        if (!current) {
          results.push({ id: fix.id, success: false, error: 'Page not found in WordPress' });
          continue;
        }

        // 2. Save snapshot to wp_change_history (one row per field changed)
        const changes = [];
        if (fix.new_meta_title && fix.new_meta_title !== current.yoast_wpseo_title) {
          changes.push({ field: 'yoast_wpseo_title', old: current.yoast_wpseo_title, new: fix.new_meta_title });
        }
        if (fix.new_meta_desc && fix.new_meta_desc !== current.yoast_wpseo_metadesc) {
          changes.push({ field: 'yoast_wpseo_metadesc', old: current.yoast_wpseo_metadesc, new: fix.new_meta_desc });
        }
        if (fix.new_focus_keyword && fix.new_focus_keyword !== current.yoast_wpseo_focuskw) {
          changes.push({ field: 'yoast_wpseo_focuskw', old: current.yoast_wpseo_focuskw, new: fix.new_focus_keyword });
        }

        if (changes.length === 0 && !fix.fix_h1) {
          results.push({ id: fix.id, success: true, skipped: true, changes: 0 });
          continue;
        }

        // 3. Write meta values to WordPress (only if there are meta changes)
        if (changes.length > 0) {
          const meta = {};
          if (fix.new_meta_title) meta._yoast_wpseo_title = fix.new_meta_title;
          if (fix.new_meta_desc) meta._yoast_wpseo_metadesc = fix.new_meta_desc;
          if (fix.new_focus_keyword) meta._yoast_wpseo_focuskw = fix.new_focus_keyword;

          console.log(`[onpage-fix] Writing to ${wpBase}/wp-json/wp/v2/${current.type}/${current.wpId} meta:`, JSON.stringify(meta));

          let writeResp = await fetch(`${wpBase}/wp-json/wp/v2/${current.type}/${current.wpId}`, {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({ meta }),
            signal: AbortSignal.timeout(15000)
          });

          // If meta write fails with 401/403, try yoast_meta wrapper (some Yoast versions expose this)
          if (!writeResp.ok && (writeResp.status === 401 || writeResp.status === 403)) {
            console.log(`[onpage-fix] Meta write failed (${writeResp.status}), trying yoast_meta wrapper...`);
            const yoastPayload = {};
            if (fix.new_meta_title) yoastPayload.yoast_wpseo_title = fix.new_meta_title;
            if (fix.new_meta_desc) yoastPayload.yoast_wpseo_metadesc = fix.new_meta_desc;
            if (fix.new_focus_keyword) yoastPayload.yoast_wpseo_focuskw = fix.new_focus_keyword;

            writeResp = await fetch(`${wpBase}/wp-json/wp/v2/${current.type}/${current.wpId}`, {
              method: 'POST',
              headers: authHeaders,
              body: JSON.stringify({ yoast_meta: yoastPayload }),
              signal: AbortSignal.timeout(15000)
            });
          }

          if (!writeResp.ok) {
            const errText = await writeResp.text();
            console.error(`[onpage-fix] WP write failed: ${writeResp.status} — ${errText.slice(0, 300)}`);
            results.push({ id: fix.id, success: false, error: `WordPress returned ${writeResp.status}: ${errText.slice(0, 200)}` });
            continue;
          }

          // 4. Verify write succeeded by reading back
          const verify = await readWpYoastMeta(wpBase, current.wpId, authHeaders);
          const verified = verify && (
            (!fix.new_meta_title || verify.yoast_wpseo_title === fix.new_meta_title) ||
            (!fix.new_meta_desc || verify.yoast_wpseo_metadesc === fix.new_meta_desc)
          );

          if (!verified) {
            console.warn(`[onpage-fix] Write returned 200 but verification failed — meta fields may not be registered for REST API`);
            results.push({ id: fix.id, success: false, error: 'WordPress accepted the request but meta fields were not updated. The seoroom-helper plugin may be needed to register Yoast meta fields for REST API writes.' });
            continue;
          }

          // Save each field change to history ONLY after verified write
          for (const ch of changes) {
            await pool.query(
              `INSERT INTO wp_change_history (project_id, page_id, page_url, page_title, change_type, field_name, original_value, new_value)
               VALUES ($1, $2, $3, $4, 'meta_fix', $5, $6, $7)`,
              [projectId, current.wpId, fix.url || '', fix.title || '', ch.field, ch.old, ch.new]
            );
          }
        }

        // Handle H1 fix — add H1 tag to page content if requested
        let h1Fixed = false;
        if (fix.fix_h1) {
          try {
            const pageResp = await fetch(`${wpBase}/wp-json/wp/v2/${current.type}/${current.wpId}`, {
              headers: authHeaders, signal: AbortSignal.timeout(15000)
            });
            if (pageResp.ok) {
              const pageData = await pageResp.json();
              const content = pageData.content?.raw || pageData.content?.rendered || '';
              const hasH1 = /<h1[\s>]/i.test(content);
              if (!hasH1) {
                const h1Text = fix.h1_text || fix.title || 'Untitled';
                const newContent = `<h1>${h1Text}</h1>\n${content}`;
                const h1WriteResp = await fetch(`${wpBase}/wp-json/wp/v2/${current.type}/${current.wpId}`, {
                  method: 'POST', headers: authHeaders,
                  body: JSON.stringify({ content: newContent }),
                  signal: AbortSignal.timeout(15000)
                });
                if (h1WriteResp.ok) {
                  h1Fixed = true;
                  await pool.query(
                    `INSERT INTO wp_change_history (project_id, page_id, page_url, page_title, change_type, field_name, original_value, new_value)
                     VALUES ($1, $2, $3, $4, 'h1_fix', 'content', $5, $6)`,
                    [projectId, current.wpId, fix.url || '', fix.title || '', content.substring(0, 5000), newContent.substring(0, 5000)]
                  );
                  console.log(`[onpage-fix] Added H1 tag to page ${current.wpId}`);
                } else {
                  console.warn(`[onpage-fix] H1 write failed: ${h1WriteResp.status}`);
                }
              } else {
                console.log(`[onpage-fix] Page ${current.wpId} already has H1 in content`);
                h1Fixed = true; // already has H1, count as fixed
              }
            }
          } catch (h1Err) { console.warn(`[onpage-fix] H1 fix error:`, h1Err.message); }
        }

        results.push({ id: fix.id, success: true, changes: changes.length, h1Fixed });
        console.log(`[onpage-fix] Fixed page ${fix.id} (${changes.length} fields) — verified ✓`);
      } catch (e) {
        results.push({ id: fix.id, success: false, error: e.message });
      }
    }

    // --- Update cached data so Site Map + Issues page reflect fixes ---
    const successIds = results.filter(r => r.success).map(r => r.id);
    console.log(`[onpage-fix] Results: ${results.length} total, ${successIds.length} succeeded. Success IDs: [${successIds.join(', ')}] (types: ${successIds.map(id => typeof id).join(', ')})`);
    if (successIds.length > 0) {
      // Build a map of what was fixed per page
      const fixMap = {};
      for (const fix of fixes) {
        if (!successIds.includes(fix.id)) continue;
        fixMap[fix.id] = fix;
      }
      // Also add string/number variants to fixMap for cross-type matching
      for (const key of Object.keys(fixMap)) {
        const numKey = Number(key);
        const strKey = String(key);
        if (!isNaN(numKey) && !fixMap[numKey]) fixMap[numKey] = fixMap[key];
        if (!fixMap[strKey]) fixMap[strKey] = fixMap[key];
      }

      // 1. Update onpage_audit_cache — recalculate issues for fixed pages
      try {
        const cacheRes = await pool.query('SELECT results FROM onpage_audit_cache WHERE project_id=$1', [projectId]);
        if (cacheRes.rows.length > 0) {
          const cached = typeof cacheRes.rows[0].results === 'string' ? JSON.parse(cacheRes.rows[0].results) : cacheRes.rows[0].results;
          for (const page of cached) {
            const fix = fixMap[page.id];
            if (!fix) continue;
            // Update the stored meta values
            if (fix.new_meta_title) { page.metaTitle = fix.new_meta_title; page.metaTitleLen = fix.new_meta_title.length; }
            if (fix.new_meta_desc) { page.metaDesc = fix.new_meta_desc; page.metaDescLen = fix.new_meta_desc.length; }
            if (fix.new_focus_keyword) page.focusKeyword = fix.new_focus_keyword;
            // Rebuild issues array from updated values
            const issues = [];
            const kwLower = (page.focusKeyword || '').toLowerCase();
            if (!page.metaTitle) issues.push({ type: 'problem', text: 'Meta title is missing' });
            else {
              if (page.metaTitleLen < 30) issues.push({ type: 'problem', text: `Meta title too short (${page.metaTitleLen} chars) — should be 50-60` });
              if (page.metaTitleLen > 60) issues.push({ type: 'warning', text: `Meta title too long (${page.metaTitleLen} chars) — max 60` });
              if (page.metaTitleLen >= 50 && page.metaTitleLen <= 60) issues.push({ type: 'good', text: 'Title tag length is good' });
              if (kwLower && page.metaTitle.toLowerCase().includes(kwLower)) issues.push({ type: 'good', text: 'Title tag contains focus keyword' });
              else if (kwLower) issues.push({ type: 'warning', text: 'Focus keyword not in title tag' });
            }
            if (!page.metaDesc) issues.push({ type: 'problem', text: 'Meta description is empty' });
            else {
              if (page.metaDescLen < 120) issues.push({ type: 'warning', text: `Meta description short (${page.metaDescLen} chars) — aim for 120-155` });
              if (page.metaDescLen > 155) issues.push({ type: 'warning', text: `Meta description too long (${page.metaDescLen} chars) — max 155` });
              if (page.metaDescLen >= 120 && page.metaDescLen <= 155) issues.push({ type: 'good', text: 'Meta description length is good' });
              if (kwLower && page.metaDesc.toLowerCase().includes(kwLower)) issues.push({ type: 'good', text: 'Meta description contains focus keyword' });
            }
            if (!page.focusKeyword) issues.push({ type: 'problem', text: 'No focus keyword set' });
            // Preserve non-meta issues (word count, links, images, etc.)
            const metaIssueTexts = ['Meta title', 'Title tag', 'Meta description', 'No focus keyword', 'Focus keyword not'];
            const preserved = (page.issues || []).filter(i => !metaIssueTexts.some(t => i.text.startsWith(t)));
            page.issues = [...issues, ...preserved];
            // Recalculate yoastScore heuristic
            const problems = page.issues.filter(i => i.type === 'problem').length;
            const warnings = page.issues.filter(i => i.type === 'warning').length;
            if (problems === 0 && warnings <= 1) page.yoastScore = 'green';
            else if (problems <= 1) page.yoastScore = 'orange';
            else page.yoastScore = 'red';
          }
          await pool.query(
            `UPDATE onpage_audit_cache SET results = $1, updated_at = NOW() WHERE project_id = $2`,
            [JSON.stringify(cached), projectId]
          );
          console.log(`[onpage-fix] Updated onpage_audit_cache for ${successIds.length} pages`);
        }
      } catch (cacheErr) { console.log('[onpage-fix] Cache update failed:', cacheErr.message); }

      // 2. Update site_graph audit — recalculate issues for fixed nodes
      // Site graph uses: node.id (string), node.meta_title, node.meta_description, node.h1, node.word_count
      // Issues are plain strings like 'Missing H1 tag', 'Meta title too long (65 chars)'
      try {
        const graphRes = await pool.query(
          `SELECT id, audit_data FROM audits WHERE project_id=$1 AND pillar='site_graph' AND status='completed' ORDER BY completed_at DESC LIMIT 1`,
          [projectId]
        );
        if (graphRes.rows.length > 0) {
          const graphData = graphRes.rows[0].audit_data;
          const auditId = graphRes.rows[0].id;
          if (graphData && graphData.nodes) {
            const fixKeys = Object.keys(fixMap);
            const nodeIds = graphData.nodes.slice(0, 5).map(n => ({ id: n.id, type: typeof n.id }));
            console.log(`[onpage-fix] Graph cache: ${graphData.nodes.length} nodes. fixMap keys: [${fixKeys.join(', ')}] (type: ${fixKeys.length ? typeof fixKeys[0] : 'none'}). Sample node IDs:`, JSON.stringify(nodeIds));
            let updated = false;
            for (const node of graphData.nodes) {
              // Match by string or number ID
              const fix = fixMap[node.id] || fixMap[String(node.id)] || fixMap[Number(node.id)];
              if (!fix) continue;
              console.log(`[onpage-fix] Matched node ${node.id} — updating meta + rebuilding issues`);
              updated = true;
              // Update stored values (snake_case fields)
              if (fix.new_meta_title) node.meta_title = fix.new_meta_title;
              if (fix.new_meta_desc) node.meta_description = fix.new_meta_desc;
              // If H1 was fixed, update the cached h1 value
              const fixResult = results.find(r => String(r.id) === String(fix.id));
              if (fix.fix_h1 && fixResult && fixResult.h1Fixed) {
                node.h1 = fix.h1_text || fix.title || node.title || '';
              }
              // Rebuild issues array (plain strings, matching crawlSiteGraph format — no meta checks, On-Page Audit handles those)
              const newIssues = [];
              if (!node.h1) newIssues.push('Missing H1 tag');
              if (node.word_count < 300) newIssues.push('Thin content (' + node.word_count + ' words)');
              if (!node.internal_links || node.internal_links.length === 0) newIssues.push('No outbound internal links');
              if ((node.inbound_count || 0) === 0 && node.slug !== 'home' && node.slug !== '') newIssues.push('Orphan page — no inbound links');
              node.issues = newIssues;
            }
            if (updated) {
              // Recalculate stats (matching crawlSiteGraph format)
              const issueCount = graphData.nodes.reduce((sum, n) => sum + (n.issues || []).length, 0);
              const orphans = graphData.nodes.filter(n => (n.inbound_count || 0) === 0 && n.slug !== 'home' && n.slug !== '').length;
              if (graphData.stats) {
                graphData.stats.issues = issueCount;
                graphData.stats.orphans = orphans;
              }
              // Persist fixed node IDs so frontend can restore "Fixed" badges across navigations
              if (!graphData.fixed_nodes) graphData.fixed_nodes = [];
              for (const id of successIds) {
                const sid = String(id);
                if (!graphData.fixed_nodes.includes(sid)) graphData.fixed_nodes.push(sid);
              }
              await pool.query(`UPDATE audits SET audit_data = $1 WHERE id = $2`, [JSON.stringify(graphData), auditId]);
              console.log(`[onpage-fix] Updated site_graph audit data for ${successIds.length} nodes. fixed_nodes: ${graphData.fixed_nodes.length}`);
            }
          }
        }
      } catch (graphErr) { console.log('[onpage-fix] Graph cache update failed:', graphErr.message); }
    }

    res.json({ results });
  } catch (e) {
    console.error('[onpage-fix] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Add internal links to a page via AI (supports Elementor + classic editor)
app.post('/api/projects/:projectId/onpage-audit/add-links', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { page_id, selected_links } = req.body;
    const project = (await pool.query('SELECT * FROM projects WHERE id=$1', [projectId])).rows[0];
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const wpUrl = project.wordpress_url?.replace(/\/$/, '');
    const authHeaders = getWpAuthHeaders(project);
    if (!wpUrl || !authHeaders) return res.status(400).json({ error: 'WordPress credentials not configured' });

    // Fetch target page with all fields
    let pageData, pageType = 'pages';
    let pageResp = await fetch(`${wpUrl}/wp-json/wp/v2/pages/${page_id}?context=edit`, { headers: authHeaders, signal: AbortSignal.timeout(15000) });
    if (pageResp.ok) {
      pageData = await pageResp.json();
    } else {
      pageResp = await fetch(`${wpUrl}/wp-json/wp/v2/posts/${page_id}?context=edit`, { headers: authHeaders, signal: AbortSignal.timeout(15000) });
      if (pageResp.ok) { pageData = await pageResp.json(); pageType = 'posts'; }
    }
    if (!pageData) return res.status(404).json({ error: 'Page not found in WordPress' });

    // Detect Elementor — check for _elementor_data in meta
    const isElementor = project.is_elementor_site || (pageData.meta && pageData.meta._elementor_data);
    let elementorData = null;
    let textWidgets = []; // { path, content } for each text widget

    if (isElementor && pageData.meta?._elementor_data) {
      try {
        elementorData = typeof pageData.meta._elementor_data === 'string'
          ? JSON.parse(pageData.meta._elementor_data) : pageData.meta._elementor_data;
      } catch { elementorData = null; }
    }

    // Extract text content from Elementor widgets recursively
    const extractTextWidgets = (elements, path = '') => {
      if (!Array.isArray(elements)) return;
      elements.forEach((el, idx) => {
        const currentPath = path ? `${path}.${idx}` : `${idx}`;
        // Text editor widgets contain HTML in settings.editor
        if (el.widgetType === 'text-editor' && el.settings?.editor) {
          textWidgets.push({ path: currentPath, field: 'editor', content: el.settings.editor });
        }
        // Heading widgets — skip (don't add links in headings)
        // Recursively check sections/columns/inner sections
        if (el.elements && el.elements.length > 0) {
          extractTextWidgets(el.elements, currentPath + '.elements');
        }
      });
    };

    let contentForAI;
    if (elementorData) {
      extractTextWidgets(elementorData);
      if (textWidgets.length === 0) {
        return res.json({ success: false, message: 'No text editor widgets found in Elementor data', links_added: [] });
      }
      // Combine all text widgets for AI, with markers
      contentForAI = textWidgets.map((tw, i) => `[WIDGET_${i}]\n${tw.content}\n[/WIDGET_${i}]`).join('\n\n');
      console.log(`[add-links] Elementor page ${page_id}: found ${textWidgets.length} text widgets`);
    } else {
      contentForAI = pageData.content?.raw || pageData.content?.rendered || '';
      if (!contentForAI.trim()) return res.status(400).json({ error: 'Page has no content' });
      console.log(`[add-links] Classic page ${page_id}: using standard content`);
    }

    // Fetch all other pages to build link targets
    const allPages = [];
    for (const type of ['pages', 'posts']) {
      let pg = 1;
      while (true) {
        try {
          const r = await fetch(`${wpUrl}/wp-json/wp/v2/${type}?per_page=50&page=${pg}&status=publish&_fields=id,title,link,slug`, {
            headers: authHeaders, signal: AbortSignal.timeout(15000)
          });
          if (!r.ok) break;
          const items = await r.json();
          if (!Array.isArray(items) || items.length === 0) break;
          allPages.push(...items.filter(p => p.id !== page_id));
          if (items.length < 50) break;
          pg++;
        } catch { break; }
      }
    }
    if (allPages.length === 0) return res.status(400).json({ error: 'No other pages found to link to' });

    let linkTargets = allPages.map(p => {
      const pm = p.meta || {};
      const sr = p.seoroom_yoast || {};
      const fk = pm._yoast_wpseo_focuskw || pm.yoast_wpseo_focuskw || sr.focus_keyword || '';
      return { title: p.title?.rendered || p.title, url: p.link || '', focus_keyword: fk };
    });

    // If selected_links provided (from preview approval), only target those URLs
    if (Array.isArray(selected_links) && selected_links.length > 0) {
      linkTargets = linkTargets.filter(t => selected_links.includes(t.url));
      console.log(`[add-links] Filtered to ${linkTargets.length} selected targets: ${selected_links.join(', ')}`);
    }

    console.log(`[add-links] Page "${pageData.title?.rendered || pageData.title?.raw}", ${linkTargets.length} link targets, elementor=${!!elementorData}`);

    // Check if this is preview-only mode (suggest but don't apply)
    const previewOnly = req.body.preview === true;

    // Build AI prompt — different for Elementor vs classic
    const systemPrompt = elementorData
      ? `You are an SEO expert. Add internal links to Elementor text widget content.
The content is split into numbered widgets: [WIDGET_0], [WIDGET_1], etc.
Return the SAME widget structure with links added inside the widget content.

ANCHOR TEXT RULES (CRITICAL):
- The anchor text MUST be the target page's focus keyword (exact match or very close variation)
- If the focus keyword doesn't appear naturally in the content, find the closest matching phrase
- NEVER use full page titles as anchor text — use the SHORT focus keyword
- Example: target focus keyword "car key replacement Perth" → anchor "car key replacement Perth" or "car key replacement" if "Perth" isn't nearby

Other rules:
- ONLY add <a href="URL">anchor text</a> links to EXISTING text — wrap existing phrases
- Add 3-8 internal links total across all widgets
- Do NOT link the same target page twice
- Do NOT add links where there's already an <a> tag
- Do NOT modify any HTML structure, classes, IDs, styles, or Elementor shortcodes
- Do NOT change any text content — only wrap existing phrases in <a> tags
- Keep all existing links intact

Return JSON:
{
  "widgets": [
    {"index": 0, "modified_content": "<widget 0 HTML with links>"},
    {"index": 1, "modified_content": "<widget 1 HTML with links>"}
  ],
  "links_added": [{"anchor": "text used", "target_keyword": "focus keyword of target", "url": "target URL", "widget": 0, "reason": "why this link"}]
}
Only include widgets that were actually modified.`
      : `You are an SEO expert. Add internal links to existing page content.

ANCHOR TEXT RULES (CRITICAL):
- The anchor text MUST be the target page's focus keyword (exact match or very close variation)
- If the focus keyword doesn't appear naturally in the content, find the closest matching phrase
- NEVER use full page titles as anchor text — use the SHORT focus keyword
- Example: target focus keyword "car key replacement Perth" → anchor "car key replacement Perth"

Other rules:
- ONLY add <a href="URL">anchor text</a> links to EXISTING text — wrap existing phrases
- Add 3-8 internal links depending on content length
- Do NOT link the same target page twice
- Do NOT add links inside headings (h1-h6)
- Do NOT add links where there's already an <a> tag
- Do NOT modify any HTML structure, classes, IDs, or styles
- Do NOT change any text content — only wrap existing phrases in <a> tags
- Keep all existing links intact
- Return the FULL modified HTML content

Return JSON: {"modified_content": "<full HTML with links>", "links_added": [{"anchor": "text used", "target_keyword": "focus keyword of target", "url": "target URL", "reason": "why this link"}]}`;

    const aiResp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8000,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Add internal links to this page content.

Page: ${pageData.title?.rendered || pageData.title?.raw || ''}

Available link targets (use the FOCUS KEYWORD as anchor text):
${linkTargets.map(t => `- "${t.title}" | focus keyword: "${t.focus_keyword || 'none'}" → ${t.url}`).join('\n')}

Current content:
${contentForAI.slice(0, 12000)}` }],
    });

    const raw = aiResp.content[0].text;
    let parsed;
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      return res.status(500).json({ error: 'AI returned invalid JSON', raw: raw.slice(0, 500) });
    }

    if (!parsed.links_added?.length) {
      return res.json({ success: false, message: 'AI could not find suitable places to add links', links_added: [] });
    }

    // Preview mode — return suggestions without applying
    if (previewOnly) {
      return res.json({
        success: true,
        preview: true,
        links_added: parsed.links_added,
        count: parsed.links_added.length,
        elementor: !!elementorData,
        page_id: page_id,
      });
    }

    // Apply changes based on content type
    if (elementorData && parsed.widgets) {
      // Apply to Elementor widgets
      const originalJson = JSON.stringify(elementorData);

      // Navigate to each widget by path and update settings.editor
      const setByPath = (obj, pathStr, value) => {
        const parts = pathStr.split('.');
        let current = obj;
        for (let i = 0; i < parts.length - 1; i++) {
          const key = isNaN(parts[i]) ? parts[i] : parseInt(parts[i]);
          current = current[key];
        }
        const lastKey = isNaN(parts[parts.length - 1]) ? parts[parts.length - 1] : parseInt(parts[parts.length - 1]);
        current[lastKey] = value;
      };

      for (const w of parsed.widgets) {
        const tw = textWidgets[w.index];
        if (!tw) continue;
        // The path points to the element, we need to set settings.editor
        const editorPath = tw.path + '.settings.editor';
        try { setByPath(elementorData, editorPath, w.modified_content); }
        catch (e) { console.log(`[add-links] Failed to set widget ${w.index}: ${e.message}`); }
      }

      // Snapshot for rollback (full data, no truncation)
      await pool.query(
        `INSERT INTO wp_change_history (project_id, page_id, page_url, page_title, change_type, field_name, original_value, new_value)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [projectId, page_id, pageData.link, pageData.title?.rendered || '', 'internal-links', '_elementor_data',
         originalJson, JSON.stringify(elementorData)]
      );

      // Write Elementor data back via meta
      const writeResp = await fetch(`${wpUrl}/wp-json/wp/v2/${pageType}/${page_id}`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ meta: { _elementor_data: JSON.stringify(elementorData) } }),
        signal: AbortSignal.timeout(15000),
      });

      if (!writeResp.ok) {
        const errText = await writeResp.text();
        return res.status(500).json({ error: `WordPress write failed: ${errText.slice(0, 300)}` });
      }

      // Also clear Elementor CSS cache by touching _elementor_css meta
      await fetch(`${wpUrl}/wp-json/wp/v2/${pageType}/${page_id}`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ meta: { _elementor_css: '' } }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});

    } else if (parsed.modified_content) {
      // Classic editor — write content directly
      const currentContent = pageData.content?.raw || pageData.content?.rendered || '';
      await pool.query(
        `INSERT INTO wp_change_history (project_id, page_id, page_url, page_title, change_type, field_name, original_value, new_value)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [projectId, page_id, pageData.link, pageData.title?.rendered || '', 'internal-links', 'content',
         currentContent, parsed.modified_content]
      );

      const writeResp = await fetch(`${wpUrl}/wp-json/wp/v2/${pageType}/${page_id}`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: parsed.modified_content }),
        signal: AbortSignal.timeout(15000),
      });

      if (!writeResp.ok) {
        const errText = await writeResp.text();
        return res.status(500).json({ error: `WordPress write failed: ${errText.slice(0, 300)}` });
      }
    } else {
      return res.json({ success: false, message: 'No content modifications returned', links_added: [] });
    }

    console.log(`[add-links] Added ${parsed.links_added.length} links to page ${page_id} (elementor=${!!elementorData})`);
    res.json({
      success: true,
      links_added: parsed.links_added,
      count: parsed.links_added.length,
      elementor: !!elementorData,
    });
  } catch (e) {
    console.error('[add-links] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Add external links — AI suggests relevant authoritative external links for a page
app.post('/api/projects/:projectId/onpage-audit/add-external-links', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { page_id, selected_links, apply } = req.body;
    const project = (await pool.query('SELECT * FROM projects WHERE id=$1', [projectId])).rows[0];
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!anthropic) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });

    const wpUrl = project.wordpress_url?.replace(/\/$/, '');
    const authHeaders = getWpAuthHeaders(project);
    if (!wpUrl || !authHeaders) return res.status(400).json({ error: 'WordPress credentials not configured' });

    // Fetch page content
    let pageData, pageType = 'pages';
    let pageResp = await fetch(`${wpUrl}/wp-json/wp/v2/pages/${page_id}?context=edit`, { headers: authHeaders, signal: AbortSignal.timeout(15000) });
    if (pageResp.ok) {
      pageData = await pageResp.json();
    } else {
      pageResp = await fetch(`${wpUrl}/wp-json/wp/v2/posts/${page_id}?context=edit`, { headers: authHeaders, signal: AbortSignal.timeout(15000) });
      if (pageResp.ok) { pageData = await pageResp.json(); pageType = 'posts'; }
      else return res.status(404).json({ error: 'Page not found in WordPress' });
    }

    const content = pageData.content?.raw || pageData.content?.rendered || '';
    const plainText = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const title = pageData.title?.rendered || pageData.title?.raw || '';
    const industry = project.industry || '';
    const location = project.location || '';

    // STEP 1: Suggest external links (preview mode)
    if (!apply) {
      const suggestResp = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        system: `You are an SEO expert. Suggest 5-8 relevant, authoritative EXTERNAL links to add to this page.

RULES:
- Links must be to high-authority domains (government sites, industry bodies, Wikipedia, major publications, official tools)
- Links must be RELEVANT to the page topic — they should add value for the reader
- Suggest the exact anchor text (an existing phrase in the content to wrap)
- Each link must open in a new tab (target="_blank")
- Do NOT suggest links to competitors or the site's own domain (${project.domain || ''})
- Prefer Australian sources when relevant (e.g. .gov.au, .com.au)
- Only suggest links where the anchor text EXISTS in the current content

Return JSON array:
[{"url": "https://...", "anchor": "existing phrase in content", "site_name": "Source Name", "reason": "why this link adds value"}]`,
        messages: [{ role: 'user', content: `Page: "${title}"
Industry: ${industry}
Location: ${location}
Business: ${project.business_name || project.name}

Content (first 4000 chars):
${plainText.slice(0, 4000)}

Suggest relevant external links. Return ONLY JSON array.` }]
      });

      const raw = suggestResp.content[0].text;
      let suggestions;
      try {
        const jsonMatch = raw.match(/\[[\s\S]*\]/);
        suggestions = JSON.parse(jsonMatch[0]);
      } catch {
        return res.status(500).json({ error: 'AI returned invalid suggestions' });
      }

      console.log(`[add-external-links] Suggested ${suggestions.length} external links for "${title}"`);
      return res.json({ success: true, preview: true, suggestions, page_id });
    }

    // STEP 2: Apply selected links
    if (!selected_links || !selected_links.length) {
      return res.status(400).json({ error: 'No links selected' });
    }

    console.log(`[add-external-links] Applying ${selected_links.length} external links to "${title}"`);

    const applyResp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8000,
      system: `You are an SEO expert. Add the specified external links to the page content.

RULES:
- Wrap EXISTING phrases with <a href="URL" target="_blank" rel="noopener noreferrer">anchor text</a>
- Do NOT modify any other HTML, text, structure, classes, or styles
- Do NOT add links inside headings (h1-h6)
- Do NOT add links where there's already an <a> tag nearby
- Keep ALL existing links intact
- Return the FULL modified HTML content

Return JSON: {"modified_content": "<full HTML with links added>", "links_added": [{"anchor": "text", "url": "URL"}]}`,
      messages: [{ role: 'user', content: `Add these external links to the content:

${selected_links.map(l => `- Anchor: "${l.anchor}" → URL: ${l.url}`).join('\n')}

Current content:
${content.slice(0, 12000)}` }]
    });

    const applyRaw = applyResp.content[0].text;
    let parsed;
    try {
      const jsonMatch = applyRaw.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      return res.status(500).json({ error: 'AI returned invalid response' });
    }

    if (!parsed.modified_content) {
      return res.json({ success: false, message: 'No modifications returned' });
    }

    // Snapshot for rollback
    await pool.query(
      `INSERT INTO wp_change_history (project_id, page_id, page_url, page_title, change_type, field_name, original_value, new_value)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [projectId, page_id, pageData.link, title, 'external-links', 'content', content, parsed.modified_content]
    );

    // Write to WordPress
    const writeResp = await fetch(`${wpUrl}/wp-json/wp/v2/${pageType}/${page_id}`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: parsed.modified_content }),
      signal: AbortSignal.timeout(15000),
    });

    if (!writeResp.ok) {
      const errText = await writeResp.text();
      return res.status(500).json({ error: `WordPress write failed: ${errText.slice(0, 300)}` });
    }

    console.log(`[add-external-links] Applied ${parsed.links_added?.length || 0} external links to page ${page_id}`);
    res.json({ success: true, links_added: parsed.links_added || selected_links, count: selected_links.length });
  } catch (e) {
    console.error('[add-external-links] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Fix orphan page — add inbound links FROM other pages TO the orphan
app.post('/api/projects/:projectId/fix-orphan', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { orphan_id, orphan_title, orphan_url } = req.body;
    if (!orphan_id) return res.status(400).json({ error: 'orphan_id required' });

    const project = (await pool.query('SELECT * FROM projects WHERE id=$1', [projectId])).rows[0];
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const wpUrl = project.wordpress_url?.replace(/\/$/, '');
    const authHeaders = getWpAuthHeaders(project);
    if (!wpUrl || !authHeaders) return res.status(400).json({ error: 'WordPress credentials not configured' });

    // 1. Fetch the orphan page info
    let orphanPage, orphanType = 'pages';
    for (const type of ['pages', 'posts']) {
      try {
        const r = await fetch(`${wpUrl}/wp-json/wp/v2/${type}/${orphan_id}?_fields=id,title,link,slug,meta`, {
          headers: authHeaders, signal: AbortSignal.timeout(15000)
        });
        if (r.ok) { orphanPage = await r.json(); orphanType = type; break; }
      } catch {}
    }
    if (!orphanPage) return res.status(404).json({ error: 'Orphan page not found in WordPress' });

    const orphanLink = orphanPage.link || orphan_url;
    const orphanName = orphanPage.title?.rendered || orphan_title || '';
    const orphanKeyword = orphanPage.meta?._yoast_wpseo_focuskw || orphanPage.meta?.yoast_wpseo_focuskw || '';
    console.log(`[fix-orphan] Orphan: "${orphanName}" (${orphan_id}), keyword: "${orphanKeyword}", URL: ${orphanLink}`);

    // 2. Fetch all other pages with their content length
    const candidates = [];
    for (const type of ['pages', 'posts']) {
      let pg = 1;
      while (true) {
        try {
          const r = await fetch(`${wpUrl}/wp-json/wp/v2/${type}?per_page=50&page=${pg}&status=publish&_fields=id,title,link,slug,content`, {
            headers: authHeaders, signal: AbortSignal.timeout(15000)
          });
          if (!r.ok) break;
          const items = await r.json();
          if (!Array.isArray(items) || items.length === 0) break;
          for (const p of items) {
            if (p.id === Number(orphan_id)) continue;
            const content = p.content?.rendered || '';
            const wordCount = content.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(w => w).length;
            // Skip thin pages and pages that already link to the orphan
            if (wordCount < 200) continue;
            if (content.includes(orphanLink)) continue;
            candidates.push({
              id: p.id, type, title: p.title?.rendered || '', url: p.link || '',
              slug: p.slug, wordCount, contentPreview: content.substring(0, 500)
            });
          }
          if (items.length < 50) break;
          pg++;
        } catch { break; }
      }
    }
    if (candidates.length === 0) return res.json({ success: false, message: 'No suitable pages found to link from', fixes: [] });

    // 3. Ask AI to pick the best 2-3 pages to link from
    const pickResp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages: [{ role: 'user', content: `You are an SEO expert. Pick the 2-3 BEST pages to add an internal link FROM, pointing TO this orphan page:

Orphan page: "${orphanName}"
Orphan URL: ${orphanLink}
Orphan focus keyword: "${orphanKeyword || 'none'}"

Candidate pages (pick ones that are topically related):
${candidates.slice(0, 30).map(c => `- ID: ${c.id} | "${c.title}" (${c.wordCount} words) | ${c.url}`).join('\n')}

Return ONLY a JSON array of IDs: [123, 456, 789]
Pick 2-3 pages that are most topically related to "${orphanName}".` }]
    });

    let selectedIds;
    try {
      const match = pickResp.content[0].text.match(/\[[\d\s,]+\]/);
      selectedIds = JSON.parse(match[0]);
    } catch {
      // Fallback: pick top 2 by word count
      selectedIds = candidates.sort((a, b) => b.wordCount - a.wordCount).slice(0, 2).map(c => c.id);
    }
    console.log(`[fix-orphan] AI selected pages: ${selectedIds.join(', ')}`);

    // 4. For each selected page, fetch full content and add a link to the orphan
    const fixes = [];
    const isElementor = project.is_elementor_site;

    for (const sourceId of selectedIds) {
      const candidate = candidates.find(c => c.id === sourceId);
      if (!candidate) continue;

      try {
        // Fetch full content
        const fullResp = await fetch(`${wpUrl}/wp-json/wp/v2/${candidate.type}/${sourceId}?context=edit`, {
          headers: authHeaders, signal: AbortSignal.timeout(15000)
        });
        if (!fullResp.ok) { fixes.push({ id: sourceId, success: false, error: 'Failed to fetch page' }); continue; }
        const fullPage = await fullResp.json();

        // Check for Elementor
        let elementorData = null;
        if (isElementor && fullPage.meta?._elementor_data) {
          try {
            elementorData = typeof fullPage.meta._elementor_data === 'string'
              ? JSON.parse(fullPage.meta._elementor_data) : fullPage.meta._elementor_data;
          } catch { elementorData = null; }
        }

        const content = elementorData ? null : (fullPage.content?.raw || fullPage.content?.rendered || '');
        if (!elementorData && !content) { fixes.push({ id: sourceId, success: false, error: 'No content' }); continue; }

        // Extract Elementor text widgets if applicable
        let textWidgets = [];
        if (elementorData) {
          const extract = (elements, path = '') => {
            if (!Array.isArray(elements)) return;
            elements.forEach((el, idx) => {
              const cp = path ? `${path}.${idx}` : `${idx}`;
              if (el.widgetType === 'text-editor' && el.settings?.editor) {
                textWidgets.push({ path: cp, content: el.settings.editor });
              }
              if (el.elements?.length) extract(el.elements, cp + '.elements');
            });
          };
          extract(elementorData);
        }

        const contentForAI = elementorData
          ? textWidgets.map((tw, i) => `[WIDGET_${i}]\n${tw.content}\n[/WIDGET_${i}]`).join('\n\n')
          : content;

        // Ask AI to add a single link to the orphan
        const linkResp = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 8000,
          messages: [{ role: 'user', content: `You are an SEO expert. Add ONE internal link to the following page content, pointing to:

Target page: "${orphanName}"
Target URL: ${orphanLink}
Target focus keyword: "${orphanKeyword || orphanName}"

Rules:
- Find a phrase in the content that naturally relates to "${orphanKeyword || orphanName}"
- Wrap that phrase in <a href="${orphanLink}">phrase</a>
- Use the focus keyword or a close variation as anchor text
- Do NOT add the link inside headings (h1-h6)
- Do NOT modify any other HTML
- Do NOT change any text — only wrap an existing phrase
- Return the FULL modified content

${elementorData ? `The content uses Elementor widgets. Return JSON:
{"widgets": [{"index": 0, "modified_content": "..."}], "links_added": [{"anchor": "text", "url": "${orphanLink}"}]}
Only include the widget you modified.` : `Return JSON: {"modified_content": "<full HTML>", "links_added": [{"anchor": "text", "url": "${orphanLink}"}]}`}

Content:
${contentForAI.slice(0, 12000)}` }]
        });

        let parsed;
        try {
          const jsonMatch = linkResp.content[0].text.match(/\{[\s\S]*\}/);
          parsed = JSON.parse(jsonMatch[0]);
        } catch {
          fixes.push({ id: sourceId, success: false, error: 'AI returned invalid JSON' });
          continue;
        }

        if (!parsed.links_added?.length) {
          fixes.push({ id: sourceId, success: false, error: 'AI could not find a place to add link' });
          continue;
        }

        // Apply the change
        if (elementorData && parsed.widgets) {
          const originalJson = JSON.stringify(elementorData);
          for (const w of parsed.widgets) {
            const tw = textWidgets[w.index];
            if (!tw) continue;
            const parts = (tw.path + '.settings.editor').split('.');
            let cur = elementorData;
            for (let i = 0; i < parts.length - 1; i++) cur = cur[isNaN(parts[i]) ? parts[i] : parseInt(parts[i])];
            cur[isNaN(parts[parts.length-1]) ? parts[parts.length-1] : parseInt(parts[parts.length-1])] = w.modified_content;
          }
          await pool.query(
            `INSERT INTO wp_change_history (project_id, page_id, page_url, page_title, change_type, field_name, original_value, new_value) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [projectId, sourceId, fullPage.link, candidate.title, 'orphan-fix', '_elementor_data', originalJson, JSON.stringify(elementorData)]
          );
          const wr = await fetch(`${wpUrl}/wp-json/wp/v2/${candidate.type}/${sourceId}`, {
            method: 'POST', headers: authHeaders,
            body: JSON.stringify({ meta: { _elementor_data: JSON.stringify(elementorData) } }),
            signal: AbortSignal.timeout(15000)
          });
          if (!wr.ok) { fixes.push({ id: sourceId, success: false, error: `WP write failed: ${wr.status}` }); continue; }
        } else if (parsed.modified_content) {
          const currentContent = fullPage.content?.raw || fullPage.content?.rendered || '';
          await pool.query(
            `INSERT INTO wp_change_history (project_id, page_id, page_url, page_title, change_type, field_name, original_value, new_value) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [projectId, sourceId, fullPage.link, candidate.title, 'orphan-fix', 'content', currentContent, parsed.modified_content]
          );
          const wr = await fetch(`${wpUrl}/wp-json/wp/v2/${candidate.type}/${sourceId}`, {
            method: 'POST', headers: authHeaders,
            body: JSON.stringify({ content: parsed.modified_content }),
            signal: AbortSignal.timeout(15000)
          });
          if (!wr.ok) { fixes.push({ id: sourceId, success: false, error: `WP write failed: ${wr.status}` }); continue; }
        }

        fixes.push({ id: sourceId, success: true, title: candidate.title, links_added: parsed.links_added });
        console.log(`[fix-orphan] Added link to orphan from "${candidate.title}" (${sourceId})`);
      } catch (e) {
        fixes.push({ id: sourceId, success: false, error: e.message });
      }
    }

    // 5. Update site graph cache — increase inbound_count for orphan node
    const successCount = fixes.filter(f => f.success).length;
    if (successCount > 0) {
      try {
        const graphRes = await pool.query(
          `SELECT id, audit_data FROM audits WHERE project_id=$1 AND pillar='site_graph' AND status='completed' ORDER BY completed_at DESC LIMIT 1`,
          [projectId]
        );
        if (graphRes.rows.length > 0) {
          const graphData = graphRes.rows[0].audit_data;
          if (graphData && graphData.nodes) {
            const node = graphData.nodes.find(n => String(n.id) === String(orphan_id));
            if (node) {
              node.inbound_count = (node.inbound_count || 0) + successCount;
              // Rebuild issues
              const newIssues = [];
              if (!node.h1) newIssues.push('Missing H1 tag');
              if (node.word_count < 300) newIssues.push('Thin content (' + node.word_count + ' words)');
              if (!node.internal_links || node.internal_links.length === 0) newIssues.push('No outbound internal links');
              if (node.inbound_count === 0 && node.slug !== 'home' && node.slug !== '') newIssues.push('Orphan page — no inbound links');
              node.issues = newIssues;
              graphData.stats.issues = graphData.nodes.reduce((sum, n) => sum + (n.issues || []).length, 0);
              graphData.stats.orphans = graphData.nodes.filter(n => (n.inbound_count || 0) === 0 && n.slug !== 'home' && n.slug !== '').length;
              if (!graphData.fixed_nodes) graphData.fixed_nodes = [];
              if (!graphData.fixed_nodes.includes(String(orphan_id))) graphData.fixed_nodes.push(String(orphan_id));
              await pool.query(`UPDATE audits SET audit_data = $1 WHERE id = $2`, [JSON.stringify(graphData), graphRes.rows[0].id]);
              console.log(`[fix-orphan] Updated cache: node ${orphan_id} inbound_count=${node.inbound_count}, issues=${node.issues.length}`);
            }
          }
        }
      } catch (e) { console.log('[fix-orphan] Cache update error:', e.message); }
    }

    console.log(`[fix-orphan] Done: ${successCount}/${fixes.length} pages linked to orphan "${orphanName}"`);
    res.json({ success: successCount > 0, fixes, orphan_id, orphan_title: orphanName });
  } catch (e) {
    console.error('[fix-orphan] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Update focus keyword on WordPress
app.post('/api/projects/:projectId/onpage-audit/update-keyword', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { page_id, keyword } = req.body;
    if (!page_id) return res.status(400).json({ error: 'page_id required' });

    const project = (await pool.query('SELECT * FROM projects WHERE id=$1', [projectId])).rows[0];
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const wpUrl = (project.wordpress_url || '').replace(/\/$/, '');
    const authHeaders = getWpAuthHeaders(project);
    if (!wpUrl || !authHeaders) return res.status(400).json({ error: 'WordPress auth not configured' });

    // Read current value for rollback
    const currentMeta = await readWpYoastMeta(wpUrl, page_id, authHeaders);
    const oldKeyword = currentMeta?._yoast_wpseo_focuskw || currentMeta?.yoast_wpseo_focuskw || '';

    // Determine page type
    let pageType = 'pages';
    let pageResp = await fetch(`${wpUrl}/wp-json/wp/v2/pages/${page_id}`, { headers: authHeaders, signal: AbortSignal.timeout(10000) });
    if (!pageResp.ok) {
      pageType = 'posts';
      pageResp = await fetch(`${wpUrl}/wp-json/wp/v2/posts/${page_id}`, { headers: authHeaders, signal: AbortSignal.timeout(10000) });
    }
    if (!pageResp.ok) return res.status(404).json({ error: 'Page not found in WordPress' });
    const pageData = await pageResp.json();

    // Write new keyword
    const writeResp = await fetch(`${wpUrl}/wp-json/wp/v2/${pageType}/${page_id}`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ meta: { _yoast_wpseo_focuskw: keyword || '' } }),
      signal: AbortSignal.timeout(15000),
    });
    if (!writeResp.ok) {
      const errText = await writeResp.text();
      return res.status(500).json({ error: `WordPress write failed: ${errText.slice(0, 300)}` });
    }

    // Save to change history for rollback
    await pool.query(
      `INSERT INTO wp_change_history (project_id, page_id, page_url, page_title, change_type, field_name, original_value, new_value)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [projectId, page_id, pageData.link || '', pageData.title?.rendered || '', 'focus-keyword', '_yoast_wpseo_focuskw', oldKeyword, keyword || '']
    );

    console.log(`[onpage] Updated focus keyword for page ${page_id}: "${oldKeyword}" → "${keyword}"`);
    res.json({ success: true, old: oldKeyword, new: keyword });
  } catch (e) {
    console.error('[onpage] Update keyword error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Add inbound links — find other pages and add links in them pointing TO this page
app.post('/api/projects/:projectId/onpage-audit/add-inbound-links', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { page_id, preview, selected_links } = req.body;
    const project = (await pool.query('SELECT * FROM projects WHERE id=$1', [projectId])).rows[0];
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const wpUrl = project.wordpress_url?.replace(/\/$/, '');
    const authHeaders = getWpAuthHeaders(project);
    if (!wpUrl || !authHeaders) return res.status(400).json({ error: 'WordPress credentials not configured' });

    // Fetch target page info
    let targetPage, targetType = 'pages';
    let pageResp = await fetch(`${wpUrl}/wp-json/wp/v2/pages/${page_id}?context=edit`, { headers: authHeaders, signal: AbortSignal.timeout(15000) });
    if (pageResp.ok) { targetPage = await pageResp.json(); }
    else {
      pageResp = await fetch(`${wpUrl}/wp-json/wp/v2/posts/${page_id}?context=edit`, { headers: authHeaders, signal: AbortSignal.timeout(15000) });
      if (pageResp.ok) { targetPage = await pageResp.json(); targetType = 'posts'; }
    }
    if (!targetPage) return res.status(404).json({ error: 'Page not found' });

    const targetUrl = targetPage.link || '';
    const targetTitle = targetPage.title?.rendered || targetPage.title?.raw || '';

    // Fetch all other pages with content
    const otherPages = [];
    for (const type of ['pages', 'posts']) {
      let pg = 1;
      while (true) {
        try {
          const r = await fetch(`${wpUrl}/wp-json/wp/v2/${type}?per_page=50&page=${pg}&status=publish&context=edit`, {
            headers: authHeaders, signal: AbortSignal.timeout(15000)
          });
          if (!r.ok) break;
          const items = await r.json();
          if (!Array.isArray(items) || items.length === 0) break;
          otherPages.push(...items.filter(p => p.id !== page_id).map(p => ({ ...p, _type: type })));
          if (items.length < 50) break;
          pg++;
        } catch { break; }
      }
    }

    if (otherPages.length === 0) return res.json({ success: false, message: 'No other pages found', links_added: [] });

    const isElementor = project.is_elementor_site;

    // Build page summaries for AI to pick the most relevant ones
    const pageSummaries = otherPages.map(p => {
      const content = p.content?.rendered || p.content?.raw || '';
      const plainText = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      // Check if already links to target
      const alreadyLinks = content.toLowerCase().includes(targetUrl.toLowerCase().replace(/\/$/, ''));
      return {
        id: p.id,
        title: p.title?.rendered || p.title?.raw || '',
        url: p.link || '',
        type: p._type,
        snippet: plainText.slice(0, 200),
        alreadyLinks,
        hasElementor: !!(p.meta?._elementor_data),
      };
    }).filter(p => !p.alreadyLinks); // Exclude pages that already link to target

    if (pageSummaries.length === 0) return res.json({ success: false, message: 'All pages already link to this page', links_added: [] });

    console.log(`[add-inbound] Target: "${targetTitle}" (${page_id}), ${pageSummaries.length} candidate pages`);

    // Ask AI which pages should link to target and what anchor text to use
    const pickResp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      system: `You are an SEO expert. Pick the most relevant pages that should link to a target page.
For each selected page, identify a natural phrase in that page's content that can be wrapped in an <a> tag linking to the target.
Pick 3-6 pages maximum. Only pick pages where a link would be genuinely relevant and natural.

Return JSON: {"pages": [{"id": <page_id>, "anchor": "exact phrase to link", "reason": "why this link makes sense"}]}`,
      messages: [{ role: 'user', content: `Target page to link TO:
Title: "${targetTitle}"
URL: ${targetUrl}

Candidate pages (pick which ones should link to the target):
${pageSummaries.map(p => `- ID ${p.id}: "${p.title}" — ${p.snippet}`).join('\n')}` }],
    });

    let picks;
    try {
      const jsonMatch = pickResp.content[0].text.match(/\{[\s\S]*\}/);
      picks = JSON.parse(jsonMatch[0]);
    } catch {
      return res.status(500).json({ error: 'AI returned invalid JSON for page selection' });
    }

    if (!picks.pages?.length) {
      return res.json({ success: false, message: 'AI found no suitable pages for inbound links', links_added: [] });
    }

    // If selected_links provided, filter picks to only those source page IDs
    if (Array.isArray(selected_links) && selected_links.length > 0) {
      picks.pages = picks.pages.filter(p => selected_links.includes(p.id));
      console.log(`[add-inbound] Filtered to ${picks.pages.length} selected source pages`);
    }

    // Preview mode — return AI picks without applying
    if (preview === true) {
      const previewLinks = picks.pages.map(p => {
        const src = otherPages.find(op => op.id === p.id);
        return {
          source_page_id: p.id,
          source_title: src ? (src.title?.rendered || src.title?.raw || '') : '',
          source_url: src ? (src.link || '') : '',
          anchor: p.anchor,
          target_url: targetUrl,
          reason: p.reason,
        };
      });
      return res.json({ success: true, preview: true, links_added: previewLinks, count: previewLinks.length });
    }

    // Now process each selected page — add the link
    const linksAdded = [];
    for (const pick of picks.pages) {
      const sourcePage = otherPages.find(p => p.id === pick.id);
      if (!sourcePage) continue;

      const hasElementorData = sourcePage.meta?._elementor_data;

      if (isElementor && hasElementorData) {
        // Elementor: parse _elementor_data, find text widgets, add link
        let elData;
        try {
          elData = typeof hasElementorData === 'string' ? JSON.parse(hasElementorData) : hasElementorData;
        } catch { continue; }

        const originalJson = JSON.stringify(elData);
        let modified = false;

        const processElements = (elements) => {
          if (!Array.isArray(elements) || modified) return;
          for (const el of elements) {
            if (modified) break;
            if (el.widgetType === 'text-editor' && el.settings?.editor) {
              const content = el.settings.editor;
              if (content.includes(pick.anchor) && !content.includes(targetUrl)) {
                // Replace first occurrence of anchor text with linked version
                el.settings.editor = content.replace(
                  pick.anchor,
                  `<a href="${targetUrl}">${pick.anchor}</a>`
                );
                modified = true;
              }
            }
            if (el.elements) processElements(el.elements);
          }
        };
        processElements(elData);

        if (!modified) continue;

        // Snapshot for rollback
        await pool.query(
          `INSERT INTO wp_change_history (project_id, page_id, page_url, page_title, change_type, field_name, original_value, new_value)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [projectId, sourcePage.id, sourcePage.link, sourcePage.title?.rendered || '', 'inbound-link', '_elementor_data',
           originalJson, JSON.stringify(elData)]
        );

        const writeResp = await fetch(`${wpUrl}/wp-json/wp/v2/${sourcePage._type}/${sourcePage.id}`, {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ meta: { _elementor_data: JSON.stringify(elData), _elementor_css: '' } }),
          signal: AbortSignal.timeout(15000),
        });

        if (writeResp.ok) {
          linksAdded.push({
            source_page_id: sourcePage.id,
            source_title: sourcePage.title?.rendered || '',
            source_url: sourcePage.link || '',
            anchor: pick.anchor,
            target_url: targetUrl,
            reason: pick.reason,
          });
        }
      } else {
        // Classic editor
        const content = sourcePage.content?.raw || sourcePage.content?.rendered || '';
        if (!content.includes(pick.anchor) || content.includes(targetUrl)) continue;

        const newContent = content.replace(
          pick.anchor,
          `<a href="${targetUrl}">${pick.anchor}</a>`
        );

        await pool.query(
          `INSERT INTO wp_change_history (project_id, page_id, page_url, page_title, change_type, field_name, original_value, new_value)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [projectId, sourcePage.id, sourcePage.link, sourcePage.title?.rendered || '', 'inbound-link', 'content',
           content, newContent]
        );

        const writeResp = await fetch(`${wpUrl}/wp-json/wp/v2/${sourcePage._type}/${sourcePage.id}`, {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: newContent }),
          signal: AbortSignal.timeout(15000),
        });

        if (writeResp.ok) {
          linksAdded.push({
            source_page_id: sourcePage.id,
            source_title: sourcePage.title?.rendered || '',
            source_url: sourcePage.link || '',
            anchor: pick.anchor,
            target_url: targetUrl,
            reason: pick.reason,
          });
        }
      }
    }

    console.log(`[add-inbound] Added ${linksAdded.length} inbound links to "${targetTitle}"`);
    res.json({
      success: linksAdded.length > 0,
      links_added: linksAdded,
      count: linksAdded.length,
      message: linksAdded.length === 0 ? 'Could not find matching anchor text in source pages' : undefined,
    });
  } catch (e) {
    console.error('[add-inbound] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get change history for a project
app.get('/api/projects/:projectId/wp-changes', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM wp_change_history WHERE project_id=$1 ORDER BY applied_at DESC LIMIT 200`,
      [req.params.projectId]
    );
    res.json({ changes: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Rollback a specific change
app.post('/api/projects/:projectId/wp-changes/rollback/:changeId', async (req, res) => {
  const { projectId, changeId } = req.params;
  try {
    // Get the change record
    const chRes = await pool.query(
      'SELECT * FROM wp_change_history WHERE id=$1 AND project_id=$2 AND rolled_back_at IS NULL',
      [changeId, projectId]
    );
    if (chRes.rows.length === 0) return res.status(404).json({ error: 'Change not found or already rolled back' });
    const change = chRes.rows[0];

    // Get project for WP auth
    const projRes = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    const project = projRes.rows[0];
    const wpBase = (project.wordpress_url || '').replace(/\/$/, '');
    const authHeaders = getWpAuthHeaders(project);
    if (!authHeaders) return res.status(400).json({ error: 'WordPress auth not configured' });

    // Determine page type (try pages then posts)
    const current = await readWpYoastMeta(wpBase, change.page_id, authHeaders);
    if (!current) return res.status(404).json({ error: 'Page not found in WordPress' });

    // Write original value back — handle different field types
    let payload;
    if (change.field_name === '_elementor_data') {
      // Elementor data — write as meta, also clear CSS cache
      payload = { meta: { _elementor_data: change.original_value } };
    } else if (change.field_name === 'content') {
      // Standard content field — write directly
      payload = { content: change.original_value };
    } else {
      // Yoast meta fields — ensure underscore prefix (DB stores without, WP needs with)
      const wpKey = change.field_name.startsWith('_') ? change.field_name : '_' + change.field_name;
      payload = { meta: { [wpKey]: change.original_value } };
    }
    const writeResp = await fetch(`${wpBase}/wp-json/wp/v2/${current.type}/${change.page_id}`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000)
    });
    // Clear Elementor CSS cache if we just rolled back Elementor data
    if (change.field_name === '_elementor_data') {
      await fetch(`${wpBase}/wp-json/wp/v2/${current.type}/${change.page_id}`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ meta: { _elementor_css: '' } }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    }

    if (!writeResp.ok) {
      const errText = await writeResp.text();
      return res.status(500).json({ error: `WordPress returned ${writeResp.status}: ${errText.slice(0, 200)}` });
    }

    // Mark as rolled back
    await pool.query('UPDATE wp_change_history SET rolled_back_at=NOW() WHERE id=$1', [changeId]);
    const wpKey2 = change.field_name.startsWith('_') ? change.field_name : '_' + change.field_name;
    console.log(`[rollback] Rolled back change ${changeId} — ${change.field_name} (wpKey: ${wpKey2}) on page ${change.page_id}, original: "${(change.original_value || '').slice(0, 80)}"`);
    res.json({ success: true });
  } catch (e) {
    console.error('[rollback] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Bulk rollback all changes for a specific page
app.post('/api/projects/:projectId/wp-changes/rollback-page/:pageId', async (req, res) => {
  const { projectId, pageId } = req.params;
  try {
    const chRes = await pool.query(
      'SELECT * FROM wp_change_history WHERE project_id=$1 AND page_id=$2 AND rolled_back_at IS NULL ORDER BY applied_at DESC',
      [projectId, pageId]
    );
    if (chRes.rows.length === 0) return res.json({ success: true, message: 'No changes to roll back' });

    const projRes = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    const project = projRes.rows[0];
    const wpBase = (project.wordpress_url || '').replace(/\/$/, '');
    const authHeaders = getWpAuthHeaders(project);
    if (!authHeaders) return res.status(400).json({ error: 'WordPress auth not configured' });

    const current = await readWpYoastMeta(wpBase, parseInt(pageId), authHeaders);
    if (!current) return res.status(404).json({ error: 'Page not found in WordPress' });

    // Get the very first original per field (oldest change = true original)
    const allChanges = await pool.query(
      'SELECT DISTINCT ON (field_name) field_name, original_value FROM wp_change_history WHERE project_id=$1 AND page_id=$2 ORDER BY field_name, applied_at ASC',
      [projectId, pageId]
    );

    // Split fields: meta fields vs content vs elementor
    const metaFields = {};
    let contentValue = null;
    let elementorValue = null;
    for (const row of allChanges.rows) {
      if (row.field_name === 'content') {
        contentValue = row.original_value;
      } else if (row.field_name === '_elementor_data') {
        elementorValue = row.original_value;
      } else {
        metaFields[row.field_name] = row.original_value;
      }
    }

    // Write meta fields (Yoast etc) — add underscore prefix if missing
    if (Object.keys(metaFields).length > 0) {
      const wpMeta = {};
      for (const [k, v] of Object.entries(metaFields)) {
        const wpKey = k.startsWith('_') ? k : '_' + k;
        wpMeta[wpKey] = v;
      }
      const metaResp = await fetch(`${wpBase}/wp-json/wp/v2/${current.type}/${pageId}`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ meta: wpMeta }),
        signal: AbortSignal.timeout(15000)
      });
      if (!metaResp.ok) {
        const errText = await metaResp.text();
        return res.status(500).json({ error: `Meta rollback failed: ${errText.slice(0, 200)}` });
      }
    }

    // Write content field
    if (contentValue !== null) {
      const contentResp = await fetch(`${wpBase}/wp-json/wp/v2/${current.type}/${pageId}`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: contentValue }),
        signal: AbortSignal.timeout(15000)
      });
      if (!contentResp.ok) {
        const errText = await contentResp.text();
        return res.status(500).json({ error: `Content rollback failed: ${errText.slice(0, 200)}` });
      }
    }

    // Write Elementor data
    if (elementorValue !== null) {
      const elemResp = await fetch(`${wpBase}/wp-json/wp/v2/${current.type}/${pageId}`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ meta: { _elementor_data: elementorValue } }),
        signal: AbortSignal.timeout(30000)
      });
      if (!elemResp.ok) {
        const errText = await elemResp.text();
        return res.status(500).json({ error: `Elementor rollback failed: ${errText.slice(0, 200)}` });
      }
      // Clear Elementor CSS cache
      await fetch(`${wpBase}/wp-json/wp/v2/${current.type}/${pageId}`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ meta: { _elementor_css: '' } }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    }

    // Mark all as rolled back
    await pool.query(
      'UPDATE wp_change_history SET rolled_back_at=NOW() WHERE project_id=$1 AND page_id=$2 AND rolled_back_at IS NULL',
      [projectId, pageId]
    );
    console.log(`[rollback] Rolled back all changes for page ${pageId}`);
    res.json({ success: true, rolled_back: chRes.rows.length });
  } catch (e) {
    console.error('[rollback] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==================== COPYWRITER ====================

// List content queue items
app.get('/api/projects/:projectId/content-queue', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { stage } = req.query; // optional filter: queue, drafts, approved, published
    let q = 'SELECT * FROM content_queue WHERE project_id=$1';
    const params = [projectId];
    if (stage) { q += ' AND stage=$2'; params.push(stage); }
    q += ' ORDER BY created_at DESC';
    const r = await pool.query(q, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Add to content queue (from On-Page Audit or manually)
app.post('/api/projects/:projectId/content-queue', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { page_id, page_url, page_title, content_type, source, priority, brief,
            current_content, current_word_count, current_meta_title, current_meta_desc, current_focus_keyword } = req.body;
    // Check for duplicate
    if (page_id) {
      const dup = await pool.query('SELECT id FROM content_queue WHERE project_id=$1 AND page_id=$2 AND stage != $3', [projectId, page_id, 'published']);
      if (dup.rows.length > 0) return res.status(409).json({ error: 'Page already in content queue', existing_id: dup.rows[0].id });
    }

    // Auto-fetch content from WordPress if not provided
    let fetchedContent = current_content || null;
    let fetchedWordCount = current_word_count || 0;
    if (!fetchedContent && page_id) {
      try {
        const project = (await pool.query('SELECT * FROM projects WHERE id=$1', [projectId])).rows[0];
        const wpBase = (project?.wordpress_url || '').replace(/\/$/, '');
        if (wpBase) {
          const authHeaders = getWpAuthHeaders(project);
          // Try pages endpoint first, then posts
          for (const type of ['pages', 'posts']) {
            try {
              const wpRes = await fetch(`${wpBase}/wp-json/wp/v2/${type}/${page_id}`, {
                headers: { ...(authHeaders || {}), 'Accept': 'application/json' }
              });
              if (wpRes.ok) {
                const wpData = await wpRes.json();
                fetchedContent = wpData.content?.rendered || '';
                // For Elementor sites, fetch live HTML if WP REST content is thin
                const plainText = fetchedContent.replace(/<[^>]+>/g, '').trim();
                const wc = plainText ? plainText.split(/\s+/).length : 0;
                if (wc < 50 && project.is_elementor_site && page_url) {
                  try {
                    const liveRes = await fetch(page_url);
                    if (liveRes.ok) {
                      const liveHtml = await liveRes.text();
                      const mainMatch = liveHtml.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ||
                                        liveHtml.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ||
                                        liveHtml.match(/<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i) ||
                                        liveHtml.match(/<div[^>]*class="[^"]*elementor[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/i);
                      if (mainMatch) {
                        const liveText = mainMatch[1].replace(/<[^>]+>/g, '').trim();
                        if (liveText.split(/\s+/).length > wc) {
                          fetchedContent = mainMatch[1];
                        }
                      }
                    }
                  } catch (e2) { console.log('[content-queue] Live fetch fallback failed:', e2.message); }
                }
                fetchedWordCount = fetchedContent.replace(/<[^>]+>/g, '').trim().split(/\s+/).filter(Boolean).length;
                console.log(`[content-queue] Fetched ${fetchedWordCount} words from WP ${type}/${page_id}`);
                break;
              }
            } catch (e2) { /* try next type */ }
          }
        }
      } catch (e2) { console.log('[content-queue] WP content fetch failed:', e2.message); }
    }

    const r = await pool.query(
      `INSERT INTO content_queue (project_id, page_id, page_url, page_title, content_type, source, priority, brief,
        current_content, current_word_count, current_meta_title, current_meta_desc, current_focus_keyword)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [projectId, page_id, page_url, page_title, content_type || 'rewrite', source || 'onpage-audit',
       priority || 'medium', brief, fetchedContent, fetchedWordCount,
       current_meta_title, current_meta_desc, current_focus_keyword]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Bulk send action items to content queue (from Action Plan → Copywriter)
app.post('/api/projects/:projectId/content-queue/bulk-from-actions', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { action_ids } = req.body; // array of action_item IDs
    if (!action_ids || !action_ids.length) return res.status(400).json({ error: 'No action IDs provided' });

    const project = (await pool.query('SELECT * FROM projects WHERE id=$1', [projectId])).rows[0];
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // Fetch the action items — cast IDs to integers
    const intIds = action_ids.map(id => parseInt(id, 10)).filter(id => !isNaN(id));
    console.log(`[bulk-copywriter] project=${projectId}, action_ids=${JSON.stringify(intIds)}`);
    if (!intIds.length) return res.status(400).json({ error: 'No valid action IDs provided' });

    const actionRes = await pool.query(
      `SELECT * FROM action_items WHERE id = ANY($1::int[]) AND project_id=$2`,
      [intIds, parseInt(projectId, 10)]
    );
    const actions = actionRes.rows;
    console.log(`[bulk-copywriter] Found ${actions.length} action items in DB`);
    if (!actions.length) return res.status(404).json({ error: `No matching action items found (searched ${intIds.length} IDs in project ${projectId})` });

    const created = [];
    const skipped = [];
    const wpBase = (project.wordpress_url || '').replace(/\/$/, '');
    const authHeaders = getWpAuthHeaders(project);

    for (const action of actions) {
      // Try to extract page_url from description or current_value
      const urlMatch = (action.description || '').match(/https?:\/\/[^\s,)]+/) ||
                       (action.current_value || '').match(/https?:\/\/[^\s,)]+/) ||
                       (action.page_url || '').match(/https?:\/\/[^\s,)]+/);
      const pageUrl = urlMatch ? urlMatch[0].replace(/[.,;]+$/, '') : (project.domain ? `https://${project.domain.replace(/^https?:\/\//, '')}` : '');

      // Try to resolve WP page_id from URL
      let pageId = null;
      if (wpBase && pageUrl) {
        try {
          const slug = pageUrl.replace(/\/$/, '').split('/').pop();
          if (slug && slug !== project.domain?.replace(/^https?:\/\//, '').replace(/\/$/, '')) {
            for (const type of ['pages', 'posts']) {
              const wpRes = await fetch(`${wpBase}/wp-json/wp/v2/${type}?slug=${encodeURIComponent(slug)}&_fields=id`, {
                headers: { ...(authHeaders || {}), 'Accept': 'application/json' }
              });
              if (wpRes.ok) {
                const wpData = await wpRes.json();
                if (wpData.length > 0) { pageId = wpData[0].id; break; }
              }
            }
          }
        } catch (e) { /* skip WP lookup */ }
      }

      // Check for duplicate in content_queue
      if (pageId) {
        const dup = await pool.query('SELECT id FROM content_queue WHERE project_id=$1 AND page_id=$2 AND stage != $3', [projectId, pageId, 'published']);
        if (dup.rows.length > 0) { skipped.push({ action_id: action.id, title: action.title, reason: 'Already in content queue' }); continue; }
      }

      // Determine content_type from action description
      const desc = (action.description || action.title || '').toLowerCase();
      let contentType = 'rewrite';
      if (desc.includes('meta title') || desc.includes('meta description') || desc.includes('meta tag')) contentType = 'meta_only';
      else if (desc.includes('thin content') || desc.includes('word count') || desc.includes('low content')) contentType = 'rewrite';

      // Detect "create new page" actions — route to site_pages instead of content_queue
      // Either: explicitly labelled as "Copywriter New", OR auto-detected from description
      const isNewPage = (action.execution_type === 'copywriter_new') || (!pageId && (
        /\b(create|add|build|new)\b/.test(desc) &&
        /\b(suburb|location|service|landing)\s*(page|pages)\b/.test(desc)
      ));

      if (isNewPage) {
        // Route to site_pages (New Website queue)
        const pageType = /suburb|location/.test(desc) ? 'suburb' : 'service';
        const pageName = action.title || 'New Page';
        const slug = pageName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const brief = `[From Action Plan] ${action.title}\n\n${action.description || ''}\n\nTarget: ${action.new_value || 'N/A'}`;
        // Extract focus keyword from action if available
        const focusKw = action.new_value || '';

        try {
          const r = await pool.query(
            `INSERT INTO site_pages (project_id, page_type, page_name, slug, focus_keyword, stage, keywords)
             VALUES ($1,$2,$3,$4,$5,'draft',$6) RETURNING id`,
            [projectId, pageType, pageName, slug, focusKw, JSON.stringify(focusKw ? [focusKw] : [])]
          );
          created.push({ action_id: action.id, site_page_id: r.rows[0].id, title: action.title, destination: 'new_website' });
          await pool.query('UPDATE action_items SET status=$1 WHERE id=$2', ['in-progress', action.id]);
        } catch (e) {
          skipped.push({ action_id: action.id, title: action.title, reason: e.message });
        }
        continue;
      }

      // Build brief from action item data
      const brief = `[From Action Plan] ${action.title}\n\n${action.description || ''}\n\nCurrent: ${action.current_value || 'N/A'}\nTarget: ${action.new_value || 'N/A'}`;

      // Auto-fetch WP content if we have page_id
      let fetchedContent = null, fetchedWordCount = 0, fetchedMetaTitle = null, fetchedMetaDesc = null, fetchedFocusKw = null;
      if (wpBase && pageId) {
        try {
          for (const type of ['pages', 'posts']) {
            const wpRes = await fetch(`${wpBase}/wp-json/wp/v2/${type}/${pageId}`, {
              headers: { ...(authHeaders || {}), 'Accept': 'application/json' }
            });
            if (wpRes.ok) {
              const wpData = await wpRes.json();
              fetchedContent = wpData.content?.rendered || '';
              fetchedWordCount = fetchedContent.replace(/<[^>]+>/g, '').trim().split(/\s+/).filter(Boolean).length;
              const yoast = wpData.yoast_head_json;
              if (yoast) {
                fetchedMetaTitle = yoast.title || null;
                fetchedMetaDesc = yoast.description || null;
                fetchedFocusKw = yoast.focuskw || null;
              }
              break;
            }
          }
        } catch (e) { /* skip */ }
      }

      try {
        const r = await pool.query(
          `INSERT INTO content_queue (project_id, page_id, page_url, page_title, content_type, source, priority, brief,
            current_content, current_word_count, current_meta_title, current_meta_desc, current_focus_keyword)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
          [projectId, pageId, pageUrl, action.title, contentType, 'action-plan',
           action.severity || 'medium', brief, fetchedContent, fetchedWordCount,
           fetchedMetaTitle, fetchedMetaDesc, fetchedFocusKw]
        );
        created.push({ action_id: action.id, content_queue_id: r.rows[0].id, title: action.title, destination: 'content_queue' });

        // Mark action item as in-progress
        await pool.query('UPDATE action_items SET status=$1 WHERE id=$2', ['in-progress', action.id]);
      } catch (e) {
        skipped.push({ action_id: action.id, title: action.title, reason: e.message });
      }
    }

    res.json({ created: created.length, skipped: skipped.length, details: { created, skipped } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get single content queue item
app.get('/api/projects/:projectId/content-queue/:id', async (req, res) => {
  try {
    const row = (await pool.query('SELECT * FROM content_queue WHERE id=$1 AND project_id=$2', [req.params.id, req.params.projectId])).rows[0];
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update content queue item (edit draft, change stage, approve)
app.put('/api/projects/:projectId/content-queue/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    const fields = [];
    const vals = [];
    let idx = 1;
    const allowedFields = ['stage', 'draft_content', 'draft_meta_title', 'draft_meta_desc', 'draft_focus_keyword',
                           'draft_word_count', 'priority', 'brief', 'approved_by', 'approved_at', 'published_at', 'content_type', 'page_wireframe', 'wireframe_image', 'wireframe_mime'];
    for (const [k, v] of Object.entries(updates)) {
      if (allowedFields.includes(k)) {
        fields.push(`${k}=$${idx++}`);
        vals.push(v);
      }
    }
    if (fields.length === 0) return res.status(400).json({ error: 'No valid fields to update' });
    fields.push(`updated_at=NOW()`);
    vals.push(id);
    const r = await pool.query(`UPDATE content_queue SET ${fields.join(',')} WHERE id=$${idx} RETURNING *`, vals);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete content queue item
app.delete('/api/projects/:projectId/content-queue/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM content_queue WHERE id=$1 AND project_id=$2', [req.params.id, req.params.projectId]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Split a multi-location content queue item into individual items
app.post('/api/projects/:projectId/content-queue/:id/split', async (req, res) => {
  try {
    const { projectId, id } = req.params;
    const original = (await pool.query('SELECT * FROM content_queue WHERE id=$1 AND project_id=$2', [id, projectId])).rows[0];
    if (!original) return res.status(404).json({ error: 'Not found' });

    const title = original.page_title || '';
    const multiMatch = title.match(/^(.+?)\s+(?:for|:)\s+(.+)$/i);
    if (!multiMatch) return res.status(400).json({ error: 'Cannot detect multiple locations in title' });

    const baseTitle = multiMatch[1].trim();
    const locations = multiMatch[2].split(/\s*[+&,]\s*|\s+and\s+/i).map(s => s.trim()).filter(Boolean);
    if (locations.length < 2) return res.status(400).json({ error: 'Only one location detected' });

    const created = [];
    for (const loc of locations) {
      const newTitle = `${baseTitle} for ${loc}`;
      const newBrief = (original.brief || '').replace(multiMatch[2], loc);
      const r = await pool.query(
        `INSERT INTO content_queue (project_id, page_id, page_url, page_title, content_type, source, priority, brief, stage)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [projectId, null, original.page_url, newTitle, original.content_type || 'rewrite', original.source || 'action-plan', original.priority || 'medium', newBrief, 'queue']
      );
      created.push(r.rows[0]);
    }

    await pool.query('DELETE FROM content_queue WHERE id=$1', [id]);
    res.json({ split: locations.length, created });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Helper: build copywriter context block from project settings (tone, wireframe, persona)
// Returns a string to inject into AI prompts — empty string if none set
function buildCopywriterContext(project, item) {
  const parts = [];
  if (project.tone_of_voice) {
    parts.push(`TONE OF VOICE (MUST follow strictly):
${project.tone_of_voice}
You MUST write in this exact tone. Every sentence should reflect this voice.`);
  }
  // Page wireframe — text description (design layout): item-level overrides project-level
  const wireframe = (item && item.page_wireframe) || project.page_wireframe;
  if (wireframe) {
    parts.push(`PAGE WIREFRAME / DESIGN STRUCTURE (MUST follow strictly):
${wireframe}
This describes the visual layout and design structure of the page. You MUST write content that fits into these design sections exactly — match the layout blocks, content types, and visual hierarchy described above.`);
  }
  // Note: if a wireframe IMAGE is uploaded, it's handled separately via getWireframeImageBlocks()
  if (item && item.wireframe_image && !wireframe) {
    parts.push(`PAGE WIREFRAME: A wireframe image has been provided (see the image in this message). You MUST write content that matches the visual layout and design structure shown in that image exactly.`);
  }
  if (project.writer_voice) {
    parts.push(`WRITER VOICE / STYLE (MUST follow):
${project.writer_voice}
Adopt this writing style and perspective throughout. This defines HOW you write — sentence structure, vocabulary level, and how you address the reader.`);
  }
  if (project.customer_persona) {
    parts.push(`TARGET CUSTOMER PERSONA (MUST address):
${project.customer_persona}
Write directly to this persona. Address their pain points, needs, and language.`);
  }
  // Always add human writing rules
  parts.push(`WRITE LIKE A HUMAN — NOT AN AI (critical):
- BANNED PHRASES (never use): "In today's", "Whether you're", "Look no further", "When it comes to", "It's important to note", "At the end of the day", "Are you looking for", "In this comprehensive guide", "Navigate the complexities", "rest assured", "peace of mind", "top-notch", "cutting-edge", "state-of-the-art", "second to none", "one-stop shop", "hassle-free", "seamless experience", "don't hesitate to", "feel free to", "game-changer", "a wide range of", "take it to the next level", "dive into", "let's explore"
- BANNED TRANSITIONS: "Furthermore", "Moreover", "Additionally", "In addition", "It's worth noting", "Notably", "Importantly", "In conclusion", "Needless to say"
- VARY sentence length — mix short punchy (5-8 words) with longer ones. Never 3+ similar-length sentences in a row
- USE CONTRACTIONS — "we're", "you'll", "it's", "don't" — stiff formal writing sounds robotic
- START sentences differently — don't begin 2+ consecutive sentences the same way
- BE SPECIFIC — instead of "we provide quality services" say exactly what and why
- Write like explaining to a mate, then polish for a website
- NO empty filler paragraphs — every paragraph needs a concrete fact or specific detail
- AVOID generic superlatives — say what makes you different, not "best in Perth"`);

  return '\n\n=== COPYWRITER SETTINGS (these override general defaults) ===\n' + parts.join('\n\n') + '\n=== END COPYWRITER SETTINGS ===\n';
}

// Helper: get wireframe image content blocks for Anthropic vision API
function getWireframeImageBlocks(item) {
  if (!item || !item.wireframe_image) return [];
  // wireframe_image is base64 data (no data: prefix), wireframe_mime is e.g. 'image/png'
  const mime = item.wireframe_mime || 'image/png';
  // Strip data:...;base64, prefix if present
  const base64 = item.wireframe_image.replace(/^data:[^;]+;base64,/, '');
  return [
    { type: 'text', text: 'PAGE WIREFRAME IMAGE — You MUST write content that matches this visual layout and design structure exactly:' },
    { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } }
  ];
}

// Helper: build user message content array, optionally including wireframe image
function buildUserContent(textPrompt, item) {
  const imgBlocks = getWireframeImageBlocks(item);
  if (imgBlocks.length === 0) return textPrompt; // plain string — no image
  return [...imgBlocks, { type: 'text', text: textPrompt }];
}

// Helper: fetch live page content for Elementor or when WP REST content is thin
async function fetchLivePageContent(pageUrl, project, pageId) {
  let content = '';
  const wpBase = (project?.wordpress_url || '').replace(/\/$/, '');
  // Try WP REST API first
  if (wpBase && pageId) {
    const authHeaders = getWpAuthHeaders(project);
    for (const type of ['pages', 'posts']) {
      try {
        const wpRes = await fetch(`${wpBase}/wp-json/wp/v2/${type}/${pageId}`, {
          headers: { ...(authHeaders || {}), 'Accept': 'application/json' }
        });
        if (wpRes.ok) {
          const wpData = await wpRes.json();
          content = wpData.content?.rendered || '';
          break;
        }
      } catch (e) { /* try next */ }
    }
  }
  // If content is thin (Elementor), fetch live HTML
  const plainText = content.replace(/<[^>]+>/g, '').trim();
  const wc = plainText ? plainText.split(/\s+/).length : 0;
  if (wc < 50 && pageUrl) {
    try {
      const liveRes = await fetch(pageUrl, { signal: AbortSignal.timeout(15000) });
      if (liveRes.ok) {
        const liveHtml = await liveRes.text();
        // Try structured content areas first
        const mainMatch = liveHtml.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ||
                          liveHtml.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ||
                          liveHtml.match(/<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
        let extracted = mainMatch ? mainMatch[1] : '';
        // Fallback for Elementor: extract body, strip non-content elements
        if (!extracted || extracted.replace(/<[^>]+>/g, '').trim().split(/\s+/).length < 30) {
          const bodyMatch = liveHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i);
          if (bodyMatch) {
            extracted = bodyMatch[1]
              .replace(/<script[\s\S]*?<\/script>/gi, '')
              .replace(/<style[\s\S]*?<\/style>/gi, '')
              .replace(/<nav[\s\S]*?<\/nav>/gi, '')
              .replace(/<footer[\s\S]*?<\/footer>/gi, '')
              .replace(/<header[\s\S]*?<\/header>/gi, '')
              .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
              .replace(/<!--[\s\S]*?-->/g, '');
          }
        }
        if (extracted) {
          const liveText = extracted.replace(/<[^>]+>/g, '').trim();
          if (liveText.split(/\s+/).length > wc) {
            content = extracted;
          }
        }
      }
    } catch (e) { console.log('[fetchLivePageContent] Live fetch failed:', e.message); }
  }
  return content;
}

// Import current copy — fetch live WP content + meta for a content queue item
app.post('/api/projects/:projectId/content-queue/:id/import-current', async (req, res) => {
  try {
    const item = (await pool.query('SELECT * FROM content_queue WHERE id=$1 AND project_id=$2', [req.params.id, req.params.projectId])).rows[0];
    if (!item) return res.status(404).json({ error: 'Not found' });
    const project = (await pool.query('SELECT * FROM projects WHERE id=$1', [req.params.projectId])).rows[0];
    const force = req.body?.force === true;
    console.log('[import-current] Item:', { id: item.id, page_id: item.page_id, page_url: item.page_url, page_title: item.page_title, has_current: !!(item.current_content), force });

    // If current_content already stored and not forcing refresh, return it
    if (!force && item.current_content && item.current_content.replace(/<[^>]+>/g, '').trim().split(/\s+/).length > 20) {
      console.log('[import-current] Returning cached content, words:', item.current_content.replace(/<[^>]+>/g, '').trim().split(/\s+/).length);
      return res.json({
        content: item.current_content,
        meta_title: item.current_meta_title || '',
        meta_desc: item.current_meta_desc || '',
        focus_keyword: item.current_focus_keyword || ''
      });
    }

    // Otherwise fetch live from WP
    const pageUrl = (item.page_url || '').startsWith('http') ? item.page_url : ('https://' + (project?.domain || '') + item.page_url);
    console.log('[import-current] Fetching live from:', pageUrl, 'page_id:', item.page_id);
    const content = await fetchLivePageContent(pageUrl, project, item.page_id);
    console.log('[import-current] Got content length:', content ? content.length : 0, 'words:', content ? content.replace(/<[^>]+>/g, '').trim().split(/\s+/).length : 0);

    // Also try to get Yoast meta
    let meta = {};
    const wpBase = (project?.wordpress_url || '').replace(/\/$/, '');
    if (wpBase && item.page_id) {
      const authHeaders = getWpAuthHeaders(project);
      try {
        const m = await readWpYoastMeta(wpBase, item.page_id, authHeaders);
        if (m) { meta = m; }
      } catch (e) { /* no meta */ }
    }

    // Save to DB for future use
    if (content) {
      await pool.query(
        'UPDATE content_queue SET current_content=$1, current_meta_title=COALESCE($2, current_meta_title), current_meta_desc=COALESCE($3, current_meta_desc), current_focus_keyword=COALESCE($4, current_focus_keyword) WHERE id=$5',
        [content, meta.meta_title || null, meta.meta_description || null, meta.focus_keyword || null, req.params.id]
      );
    }

    res.json({
      content: content || '',
      meta_title: meta.meta_title || item.current_meta_title || '',
      meta_desc: meta.meta_description || item.current_meta_desc || '',
      focus_keyword: meta.focus_keyword || item.current_focus_keyword || ''
    });
  } catch (e) {
    console.error('[import-current] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Generate AI draft for a content queue item (enhanced with keyword context + internal linking)
app.post('/api/projects/:projectId/content-queue/:id/generate-draft', async (req, res) => {
  try {
    const { projectId, id } = req.params;
    const item = (await pool.query('SELECT * FROM content_queue WHERE id=$1 AND project_id=$2', [id, projectId])).rows[0];
    if (!item) return res.status(404).json({ error: 'Not found' });
    const project = (await pool.query('SELECT * FROM projects WHERE id=$1', [projectId])).rows[0];

    // Auto-fetch content if missing or thin
    let currentContent = item.current_content || '';
    const currentPlain = currentContent.replace(/<[^>]+>/g, '').trim();
    const currentWc = currentPlain ? currentPlain.split(/\s+/).length : 0;
    if (currentWc < 50 && item.page_url) {
      console.log(`[generate-draft] Content thin (${currentWc} words), fetching live content for ${item.page_url}`);
      currentContent = await fetchLivePageContent(item.page_url, project, item.page_id);
      const newWc = currentContent.replace(/<[^>]+>/g, '').trim().split(/\s+/).filter(Boolean).length;
      if (newWc > currentWc) {
        // Update stored content
        await pool.query('UPDATE content_queue SET current_content=$1, current_word_count=$2 WHERE id=$3', [currentContent, newWc, id]);
        console.log(`[generate-draft] Updated stored content: ${currentWc} → ${newWc} words`);
      }
    }

    // Get internal linking candidates
    const pagesRes = await pool.query(
      `SELECT DISTINCT page_url, page_title FROM content_queue
       WHERE project_id=$1 AND stage='published' AND id != $2 ORDER BY page_title LIMIT 30`,
      [projectId, id]
    );

    // Get target keywords if set
    const targetKeywords = item.target_keywords || [];

    // Build AI prompt based on content type
    let systemPrompt, userPrompt;
    if (item.content_type === 'rewrite') {
      systemPrompt = `You are an expert SEO copywriter for a local Australian business: "${project.business_name || project.name}" in ${project.location || 'Australia'}, industry: ${project.industry || 'services'}.
Your job is to rewrite thin/weak page content to be SEO-optimized, engaging, and locally relevant.

RULES:
- Write naturally — no keyword stuffing
- Include the focus keyword naturally in the first paragraph, at least one H2, and naturally throughout (3-8 times total)
- Target 800-1200 words for service pages, 500-800 for suburb pages
- Use H2 and H3 subheadings to structure content
- Include a clear call-to-action (CTA)
- Mention the suburb/location naturally
- Write in Australian English (optimise, colour, centre, specialise, organisation, behaviour, analyse, favour, labour — NEVER American spellings)
- Return valid HTML content (no full page, just the body content with headings)
- DO NOT change the page design or layout structure
- Include 2-3 internal links to other relevant pages naturally within the content
- If given target keywords, weave them in naturally throughout the content

Return JSON: {"content": "<html content>", "meta_title": "<50-60 chars>", "meta_description": "<140-155 chars>", "focus_keyword": "<primary keyword>", "word_count": <number>, "internal_links": ["url1", "url2", ...], "ai_notes": "Brief strategy summary"}
${buildCopywriterContext(project, item)}`;

      userPrompt = `Rewrite this page for better SEO performance:

Page: ${item.page_title} (${item.page_url})
Current word count: ${item.current_word_count}
Current focus keyword: ${item.current_focus_keyword || '(none)'}
Current meta title: ${item.current_meta_title || '(none)'}
Current meta description: ${item.current_meta_desc || '(none)'}
${targetKeywords.length > 0 ? `\nTarget keywords to include: ${targetKeywords.map(k => typeof k === 'string' ? k : k.keyword || k).join(', ')}` : ''}
${item.brief ? `\nBrief/Instructions: ${item.brief}` : ''}

Pages available for internal linking:
${pagesRes.rows.map(p => `- ${p.page_url} (${p.page_title})`).join('\n')}

Current content (first 3000 chars):
${(currentContent || '').slice(0, 3000)}`;
    } else if (item.content_type === 'meta_only') {
      systemPrompt = `You are an expert SEO copywriter. Write optimized meta tags for a local Australian business page.
Return JSON: {"meta_title": "<50-60 chars with keyword>", "meta_description": "<140-155 chars with CTA>", "focus_keyword": "<primary keyword>"}
${buildCopywriterContext(project, item)}`;
      userPrompt = `Write optimized meta tags for:
Page: ${item.page_title} (${item.page_url})
Business: ${project.business_name || project.name} in ${project.location || 'Australia'}
Industry: ${project.industry || 'services'}
Current meta title: ${item.current_meta_title || '(none)'}
Current meta description: ${item.current_meta_desc || '(none)'}
Current focus keyword: ${item.current_focus_keyword || '(none)'}
${item.brief ? `\nBrief: ${item.brief}` : ''}`;
    } else {
      // new_page
      systemPrompt = `You are an expert SEO copywriter for "${project.business_name || project.name}" in ${project.location || 'Australia'}.
Write a complete new page with SEO-optimized content.

RULES:
- Target 800-1200 words
- Use H2/H3 headings for structure
- Include a clear call-to-action
- Write in Australian English (optimise, colour, centre, specialise, organisation, behaviour, analyse, favour, labour — NEVER American spellings)
- Include 2-3 internal links to other relevant pages
- Use target keywords naturally throughout
- If any schema markup data is provided, include appropriate structured data

Return JSON: {"content": "<html content>", "meta_title": "<50-60 chars>", "meta_description": "<140-155 chars>", "focus_keyword": "<primary keyword>", "word_count": <number>, "internal_links": ["url1", "url2", ...], "schema_markup": {optional JSON-LD}, "ai_notes": "Strategy summary"}
${buildCopywriterContext(project, item)}`;
      userPrompt = `Write a new page:
Title: ${item.page_title}
Target URL: ${item.page_url || '(to be determined)'}
${targetKeywords.length > 0 ? `Target keywords: ${targetKeywords.map(k => typeof k === 'string' ? k : k.keyword || k).join(', ')}` : ''}
${item.brief ? `Brief: ${item.brief}` : 'Write comprehensive service/location content.'}

Pages available for internal linking:
${pagesRes.rows.map(p => `- ${p.page_url} (${p.page_title})`).join('\n')}`;
    }

    console.log(`[copywriter] Generating draft for item ${id}: ${item.page_title}`);
    const aiResp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      messages: [{ role: 'user', content: buildUserContent(userPrompt, item) }],
      system: systemPrompt,
    });
    const raw = aiResp.content[0].text;
    let parsed;
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      return res.status(500).json({ error: 'AI returned invalid JSON', raw: raw.slice(0, 500) });
    }

    // Save draft
    const plainText = (parsed.content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const wordCount = parsed.word_count || plainText.split(/\s+/).filter(Boolean).length;
    const updated = await pool.query(
      `UPDATE content_queue SET stage='drafts', draft_content=$1, draft_meta_title=$2, draft_meta_desc=$3,
       draft_focus_keyword=$4, draft_word_count=$5, ai_notes=$6, schema_markup=$7, updated_at=NOW() WHERE id=$8 RETURNING *`,
      [parsed.content || '', parsed.meta_title || '', parsed.meta_description || '', parsed.focus_keyword || '',
       wordCount, parsed.ai_notes || 'Generated draft', JSON.stringify(parsed.schema_markup || null), id]
    );
    console.log(`[copywriter] Draft generated: ${wordCount} words`);
    res.json(updated.rows[0]);
  } catch (e) {
    console.error('[copywriter] Draft error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Stage 1: Push approved content to WordPress as DRAFT for preview
app.post('/api/projects/:projectId/content-queue/:id/publish', async (req, res) => {
  try {
    const { projectId, id } = req.params;
    const item = (await pool.query('SELECT * FROM content_queue WHERE id=$1 AND project_id=$2', [id, projectId])).rows[0];
    if (!item) return res.status(404).json({ error: 'Not found' });
    if (item.stage !== 'approved') return res.status(400).json({ error: 'Item must be approved before publishing' });
    const project = (await pool.query('SELECT * FROM projects WHERE id=$1', [projectId])).rows[0];
    const wpUrl = project.wordpress_url?.replace(/\/$/, '');
    const authHeaders = getWpAuthHeaders(project);
    if (!wpUrl || !authHeaders) return res.status(400).json({ error: 'WordPress credentials not configured' });

    // Auto-resolve page_id from page_url if missing
    if (!item.page_id && item.page_url) {
      const slug = item.page_url.replace(/\/$/, '').split('/').filter(Boolean).pop();
      if (slug) {
        for (const type of ['pages', 'posts']) {
          try {
            const wpRes = await fetch(`${wpUrl}/wp-json/wp/v2/${type}?slug=${encodeURIComponent(slug)}&_fields=id`, { headers: { ...authHeaders, 'Accept': 'application/json' } });
            if (wpRes.ok) {
              const wpData = await wpRes.json();
              if (wpData.length > 0) {
                item.page_id = wpData[0].id;
                await pool.query('UPDATE content_queue SET page_id=$1 WHERE id=$2', [item.page_id, id]);
                console.log(`[copywriter] Auto-resolved page_id=${item.page_id} from slug "${slug}"`);
                break;
              }
            }
          } catch (e) { /* try next type */ }
        }
      }
    }
    if (!item.page_id) return res.status(400).json({ error: 'No WordPress page ID — cannot publish. Set the page URL first.' });

    // Snapshot current live values for rollback (DO NOT touch the live page)
    const currentMeta = await readWpYoastMeta(wpUrl, item.page_id, authHeaders);
    let currentContent = '';
    let currentStatus = 'publish';
    const pageResp = await fetch(`${wpUrl}/wp-json/wp/v2/pages/${item.page_id}?_fields=content,status`, { headers: authHeaders });
    if (pageResp.ok) {
      const pageData = await pageResp.json();
      currentContent = pageData.content?.rendered || '';
      currentStatus = pageData.status || 'publish';
    }

    // Check there are actual changes
    const changes = [];
    if (item.draft_content) {
      changes.push({ field: 'content', old: currentContent.slice(0, 5000), new: item.draft_content.slice(0, 5000) });
    }
    if (item.draft_meta_title) changes.push({ field: 'yoast_wpseo_title', old: currentMeta.yoast_wpseo_title || '', new: item.draft_meta_title });
    if (item.draft_meta_desc) changes.push({ field: 'yoast_wpseo_metadesc', old: currentMeta.yoast_wpseo_metadesc || '', new: item.draft_meta_desc });
    if (item.draft_focus_keyword) changes.push({ field: 'yoast_wpseo_focuskw', old: currentMeta.yoast_wpseo_focuskw || '', new: item.draft_focus_keyword });
    if (changes.length === 0) return res.status(400).json({ error: 'Nothing to publish' });

    // Save snapshot for rollback — DO NOT push anything to WP yet
    await pool.query(
      `UPDATE content_queue SET wp_previous_status=$1, wp_previous_content=$2, stage='staging', updated_at=NOW() WHERE id=$3`,
      [currentStatus, currentContent.slice(0, 50000), id]
    );

    console.log(`[copywriter] Item ${id} moved to staging (page ${item.page_id}) — live page NOT touched`);
    res.json({ success: true, stage: 'staging', page_id: item.page_id, changes: changes.length });
  } catch (e) {
    console.error('[copywriter] Publish-to-staging error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Stage 2: Go Live — push changes to WP and publish
app.post('/api/projects/:projectId/content-queue/:id/go-live', async (req, res) => {
  try {
    const { projectId, id } = req.params;
    const item = (await pool.query('SELECT * FROM content_queue WHERE id=$1 AND project_id=$2', [id, projectId])).rows[0];
    if (!item) return res.status(404).json({ error: 'Not found' });
    if (item.stage !== 'staging') return res.status(400).json({ error: 'Item must be in staging before going live' });
    if (!item.page_id) return res.status(400).json({ error: 'No WordPress page ID' });

    const project = (await pool.query('SELECT * FROM projects WHERE id=$1', [projectId])).rows[0];
    const wpUrl = project.wordpress_url?.replace(/\/$/, '');
    const authHeaders = getWpAuthHeaders(project);
    if (!wpUrl || !authHeaders) return res.status(400).json({ error: 'WordPress credentials not configured' });

    // Build payload with all changes — push directly as published
    const payload = {};
    const changes = [];

    // Always push draft_content if it exists — user explicitly wrote/edited this content
    if (item.draft_content) {
      // Strip leading H1 to avoid repetition — WP themes render page title as H1 already
      let cleanContent = item.draft_content.replace(/^\s*<h1[^>]*>.*?<\/h1>\s*/i, '');
      payload.content = cleanContent;
      changes.push({ field: 'content', old: (item.wp_previous_content || '').slice(0, 5000), new: cleanContent.slice(0, 5000) });
    }

    const metaPayload = {};
    if (item.draft_meta_title) {
      metaPayload._yoast_wpseo_title = item.draft_meta_title;
      changes.push({ field: 'yoast_wpseo_title', old: '', new: item.draft_meta_title });
    }
    if (item.draft_meta_desc) {
      metaPayload._yoast_wpseo_metadesc = item.draft_meta_desc;
      changes.push({ field: 'yoast_wpseo_metadesc', old: '', new: item.draft_meta_desc });
    }
    if (item.draft_focus_keyword) {
      metaPayload._yoast_wpseo_focuskw = item.draft_focus_keyword;
      changes.push({ field: 'yoast_wpseo_focuskw', old: '', new: item.draft_focus_keyword });
    }
    if (Object.keys(metaPayload).length > 0) payload.meta = metaPayload;

    // Push to WP — keep status as-is (published stays published)
    let writeResp = await fetch(`${wpUrl}/wp-json/wp/v2/pages/${item.page_id}`, {
      method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!writeResp.ok) {
      writeResp = await fetch(`${wpUrl}/wp-json/wp/v2/posts/${item.page_id}`, {
        method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }
    if (!writeResp.ok) {
      const errText = await writeResp.text();
      return res.status(500).json({ error: `WordPress publish failed: ${errText.slice(0, 300)}` });
    }

    // Save to wp_change_history for rollback
    for (const ch of changes) {
      await pool.query(
        `INSERT INTO wp_change_history (project_id, page_id, page_url, page_title, change_type, field_name, original_value, new_value)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [projectId, item.page_id, item.page_url, item.page_title, 'copywriter', ch.field, ch.old, ch.new]
      );
    }

    await pool.query(
      `UPDATE content_queue SET stage='published', published_at=NOW(), updated_at=NOW() WHERE id=$1`, [id]
    );

    console.log(`[copywriter] Item ${id} went LIVE on page ${item.page_id}`);
    res.json({ success: true, stage: 'published' });
  } catch (e) {
    console.error('[copywriter] Go-live error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Revert staging — just move back to approved (live page was never touched)
app.post('/api/projects/:projectId/content-queue/:id/revert-staging', async (req, res) => {
  try {
    const { projectId, id } = req.params;
    const item = (await pool.query('SELECT * FROM content_queue WHERE id=$1 AND project_id=$2', [id, projectId])).rows[0];
    if (!item) return res.status(404).json({ error: 'Not found' });
    if (item.stage !== 'staging') return res.status(400).json({ error: 'Item is not in staging' });

    await pool.query(`UPDATE content_queue SET stage='approved', updated_at=NOW() WHERE id=$1`, [id]);
    console.log(`[copywriter] Item ${id} reverted from staging to approved — no WP changes to undo`);
    res.json({ success: true, stage: 'approved' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Rollback published — restore original content from wp_change_history
app.post('/api/projects/:projectId/content-queue/:id/rollback', async (req, res) => {
  try {
    const { projectId, id } = req.params;
    const item = (await pool.query('SELECT * FROM content_queue WHERE id=$1 AND project_id=$2', [id, projectId])).rows[0];
    if (!item) return res.status(404).json({ error: 'Not found' });
    if (item.stage !== 'published') return res.status(400).json({ error: 'Item must be published to rollback' });
    if (!item.page_id) return res.status(400).json({ error: 'No WordPress page ID' });

    const project = (await pool.query('SELECT * FROM projects WHERE id=$1', [projectId])).rows[0];
    const wpUrl = project.wordpress_url?.replace(/\/$/, '');
    const authHeaders = getWpAuthHeaders(project);
    if (!wpUrl || !authHeaders) return res.status(400).json({ error: 'WordPress credentials not configured' });

    // Get all change history entries for this page from this copywriter item
    const historyRes = await pool.query(
      `SELECT * FROM wp_change_history WHERE project_id=$1 AND page_id=$2 AND change_type='copywriter' AND rolled_back_at IS NULL ORDER BY applied_at DESC`,
      [projectId, item.page_id]
    );
    if (historyRes.rows.length === 0) return res.status(400).json({ error: 'No change history found to rollback' });

    // Build restore payload from original values
    const payload = {};
    const metaPayload = {};
    const rolledBackIds = [];

    for (const ch of historyRes.rows) {
      rolledBackIds.push(ch.id);
      if (ch.field_name === 'content' && ch.original_value) {
        payload.content = ch.original_value;
      } else if (ch.field_name === 'yoast_wpseo_title') {
        metaPayload._yoast_wpseo_title = ch.original_value || '';
      } else if (ch.field_name === 'yoast_wpseo_metadesc') {
        metaPayload._yoast_wpseo_metadesc = ch.original_value || '';
      } else if (ch.field_name === 'yoast_wpseo_focuskw') {
        metaPayload._yoast_wpseo_focuskw = ch.original_value || '';
      }
    }
    if (Object.keys(metaPayload).length > 0) payload.meta = metaPayload;

    if (Object.keys(payload).length === 0) return res.status(400).json({ error: 'Nothing to rollback — no original values saved' });

    // Push original content back to WP
    let writeResp = await fetch(`${wpUrl}/wp-json/wp/v2/pages/${item.page_id}`, {
      method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!writeResp.ok) {
      writeResp = await fetch(`${wpUrl}/wp-json/wp/v2/posts/${item.page_id}`, {
        method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }
    if (!writeResp.ok) {
      const errText = await writeResp.text();
      return res.status(500).json({ error: `WordPress rollback failed: ${errText.slice(0, 300)}` });
    }

    // Mark history entries as rolled back
    await pool.query(
      `UPDATE wp_change_history SET rolled_back_at=NOW() WHERE id = ANY($1::int[])`,
      [rolledBackIds]
    );

    // Move item back to approved
    await pool.query(
      `UPDATE content_queue SET stage='approved', published_at=NULL, updated_at=NOW() WHERE id=$1`, [id]
    );

    console.log(`[copywriter] Item ${id} rolled back — ${rolledBackIds.length} changes restored on page ${item.page_id}`);
    res.json({ success: true, stage: 'approved', changes_rolled_back: rolledBackIds.length });
  } catch (e) {
    console.error('[copywriter] Rollback error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Emergency restore — fix any page that was accidentally set to draft
app.post('/api/projects/:projectId/content-queue/restore-page/:pageId', async (req, res) => {
  try {
    const { projectId, pageId } = req.params;
    // Try all projects to find one with WP credentials
    const allProjects = (await pool.query('SELECT * FROM projects ORDER BY id')).rows;
    console.log('[restore] Projects found:', allProjects.map(p => ({ id: p.id, wp: p.wordpress_url, user: p.wp_username ? 'SET' : 'EMPTY', pass: p.wp_app_password ? 'SET' : 'EMPTY' })));
    let project = allProjects.find(p => p.id == projectId && p.wp_username && p.wp_app_password);
    if (!project) project = allProjects.find(p => p.wp_username && p.wp_app_password);
    if (!project) {
      // Fallback: try project_integrations table
      const integ = (await pool.query(`SELECT value FROM project_integrations WHERE project_id=$1 AND type='wordpress'`, [projectId])).rows[0];
      if (integ) console.log('[restore] Found project_integrations wordpress entry');
      // Last resort: use the project's wordpress_url with creds from request body
      project = allProjects.find(p => p.id == projectId) || allProjects[0];
      if (!project) return res.status(400).json({ error: 'No projects found at all' });
    }
    const wpUrl = project.wordpress_url?.replace(/\/$/, '');
    let authHeaders = getWpAuthHeaders(project);
    // Accept creds from request body as emergency fallback
    if (!authHeaders && req.body && req.body.wp_username && req.body.wp_password) {
      const token = Buffer.from(`${req.body.wp_username}:${req.body.wp_password}`).toString('base64');
      authHeaders = { 'Authorization': `Basic ${token}`, 'Content-Type': 'application/json' };
    }
    if (!wpUrl || !authHeaders) return res.status(400).json({ error: 'WordPress credentials not configured', debug: { wpUrl: wpUrl || 'MISSING', hasAuth: !!authHeaders } });

    let writeResp = await fetch(`${wpUrl}/wp-json/wp/v2/pages/${pageId}`, {
      method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'publish' }),
    });
    if (!writeResp.ok) {
      writeResp = await fetch(`${wpUrl}/wp-json/wp/v2/posts/${pageId}`, {
        method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'publish' }),
      });
    }
    if (!writeResp.ok) {
      const errText = await writeResp.text();
      return res.status(500).json({ error: `Restore failed: ${errText.slice(0, 300)}` });
    }
    console.log(`[copywriter] Emergency restore: page ${pageId} set back to publish`);
    res.json({ success: true, message: `Page ${pageId} restored to published` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== COPYWRITER ADVANCED ENDPOINTS ====================

// Expand — add more content to existing draft
app.post('/api/projects/:projectId/content-queue/:id/expand', async (req, res) => {
  if (!anthropic) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });
  const { projectId, id } = req.params;
  const { target_words, target_keywords } = req.body;

  try {
    const item = (await pool.query('SELECT * FROM content_queue WHERE id=$1 AND project_id=$2', [id, projectId])).rows[0];
    if (!item) return res.status(404).json({ error: 'Not found' });

    const project = (await pool.query('SELECT * FROM projects WHERE id=$1', [projectId])).rows[0];

    // Get pages for internal linking
    const pagesRes = await pool.query(
      `SELECT page_url, page_title FROM (
        SELECT DISTINCT page_url, page_title FROM content_queue
        WHERE project_id=$1 AND stage='published' ORDER BY page_title
        LIMIT 30
      ) AS p`,
      [projectId]
    );

    const kwList = (target_keywords || item.target_keywords || []).map(k => typeof k === 'string' ? k : k.keyword || k);

    const systemPrompt = `You are an expert SEO copywriter for "${project.business_name || project.name}", a ${project.industry || 'service'} business in ${project.location || 'Australia'}.
You will be given existing page content and asked to expand it with more sections.

RULES:
- Write naturally in Australian English (optimise, colour, centre, specialise, organisation, behaviour, analyse, favour, labour — NEVER American spellings)
- Add NEW sections that complement the existing content (don't repeat existing content)
- Use H2 and H3 headings for structure
- Incorporate the target keywords naturally
- Include internal links where relevant
- Write engaging, informative content
- Target total page length: ${target_words || 1500} words

OUTPUT FORMAT (respond in valid JSON only):
{
  "additional_html": "<h2>New Section</h2><p>...</p>... (HTML to APPEND after existing content)",
  "ai_notes": "Brief summary of what was added and keywords used"
}
${buildCopywriterContext(project, item)}`;

    const currentHtml = item.draft_content || item.current_content || '';
    const currentWords = currentHtml.replace(/<[^>]+>/g, '').split(/\s+/).filter(Boolean).length;

    const userPrompt = `EXPAND this page with more content:
URL: ${item.page_url}
Title: ${item.page_title}
Focus keyword: ${item.draft_focus_keyword || item.current_focus_keyword}
Current word count: ${currentWords}
Target total words: ${target_words || 1500}

TARGET KEYWORDS TO INCLUDE:
${kwList.length > 0 ? kwList.map(k => `- "${k}"`).join('\n') : '- Use keywords related to the page topic'}

Pages available for internal linking:
${pagesRes.rows.map(p => `- ${p.page_url} (${p.page_title})`).join('\n')}

CURRENT CONTENT:
${currentHtml.slice(0, 4000)}

Add ${Math.max(300, (target_words || 1500) - currentWords)} more words of new content with new sections and headings.`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      system: systemPrompt,
      messages: [{ role: 'user', content: buildUserContent(userPrompt, item) }]
    });

    const text = response.content[0]?.text || '';
    let parsed;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch[0]);
    } catch (e) {
      return res.status(500).json({ error: 'Failed to parse AI response', raw: text.slice(0, 500) });
    }

    // Append new content to existing
    const newContent = currentHtml + '\n' + (parsed.additional_html || '');
    const newNotes = (item.ai_notes || '') + '\n--- Expanded ---\n' + (parsed.ai_notes || '');

    const updated = await pool.query(
      `UPDATE content_queue SET draft_content=$1, ai_notes=$2, updated_at=NOW() WHERE id=$3 AND project_id=$4 RETURNING *`,
      [newContent, newNotes, id, projectId]
    );

    console.log(`[copywriter] Expanded draft ${id}: ${currentWords} → ${(newContent.replace(/<[^>]+>/g, '').split(/\s+/).filter(Boolean).length)} words`);
    res.json(updated.rows[0]);
  } catch (e) {
    console.error('[copywriter] Expand error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Optimise — AI improve based on SEO tips (returns preview, doesn't save)
app.post('/api/projects/:projectId/content-queue/:id/optimise', async (req, res) => {
  if (!anthropic) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });
  req.setTimeout(120000);
  res.setTimeout(120000);
  const { projectId, id } = req.params;
  const { tips, missing_keywords, target_keywords, content_score, stats, current_meta } = req.body;

  try {
    const item = (await pool.query('SELECT * FROM content_queue WHERE id=$1 AND project_id=$2', [id, projectId])).rows[0];
    if (!item) return res.status(404).json({ error: 'Not found' });

    const project = (await pool.query('SELECT * FROM projects WHERE id=$1', [projectId])).rows[0];

    // Auto-fetch content if thin
    let contentToOptimise = item.draft_content || item.current_content || '';
    const contentPlain = contentToOptimise.replace(/<[^>]+>/g, '').trim();
    const contentWc = contentPlain ? contentPlain.split(/\s+/).length : 0;
    if (contentWc < 50 && item.page_url) {
      console.log(`[optimise] Content thin (${contentWc} words), fetching live content`);
      const liveContent = await fetchLivePageContent(item.page_url, project, item.page_id);
      const liveWc = liveContent.replace(/<[^>]+>/g, '').trim().split(/\s+/).filter(Boolean).length;
      if (liveWc > contentWc) {
        contentToOptimise = liveContent;
        // Store it for future use
        await pool.query('UPDATE content_queue SET current_content=$1, current_word_count=$2 WHERE id=$3', [liveContent, liveWc, id]);
        console.log(`[optimise] Fetched live content: ${contentWc} → ${liveWc} words`);
      }
    }

    // Get pages for internal linking — from content_queue and site_pages (exclude current page)
    let pagesRes = await pool.query(
      `SELECT DISTINCT page_url, page_title FROM (
        SELECT page_url, page_title FROM content_queue
        WHERE project_id=$1 AND page_url IS NOT NULL AND page_url != ''
        UNION
        SELECT COALESCE(published_url, '/' || slug || '/') AS page_url, page_name AS page_title FROM site_pages
        WHERE project_id=$1 AND (published_url IS NOT NULL OR slug IS NOT NULL)
      ) AS all_pages WHERE page_url != $2
      ORDER BY page_title LIMIT 30`,
      [projectId, item.page_url || '']
    ).catch(() => ({ rows: [] }));
    // Fallback: discover pages from WP if no pages found
    if (pagesRes.rows.length === 0 && project.wordpress_url) {
      try {
        const wpBase = project.wordpress_url.replace(/\/$/, '');
        const wpPages = await fetch(`${wpBase}/wp-json/wp/v2/pages?per_page=30&_fields=id,link,title`).then(r => r.ok ? r.json() : []);
        pagesRes = { rows: wpPages.filter(p => p.link !== item.page_url).map(p => ({ page_url: p.link, page_title: p.title?.rendered || '' })) };
      } catch(e) { /* WP not available */ }
    }

    const allMissing = (missing_keywords || []).map(k => typeof k === 'string' ? k : k.keyword || k);

    // Build numbered issue list from tips — filter out success items
    const issueItems = (tips || []).filter(t => {
      const type = t.type || '';
      const msg = t.msg || (typeof t === 'string' ? t : '');
      return type !== 'success' && type !== 'good' && !msg.startsWith('Great') && msg.length > 0;
    });
    const numberedIssues = issueItems.map((t, i) => `${i + 1}. [${(t.type || 'fix').toUpperCase()}] ${t.msg || t}`).join('\n');

    const systemPrompt = `You are an expert SEO copywriter for "${project.business_name || project.name}", a ${project.industry || 'service'} business in ${project.location || 'Australia'}.

You will receive page content, meta data, and SEO content score issues. Your SOLE objective is to MAXIMISE the content score to 90+. The score is calculated by these EXACT rules:

SCORING SYSTEM (100 points total — hit EVERY threshold):
1. WORDS: 20 points if 1,500+ words. You MUST write at least 2,000 words of content. This is the most important threshold — do NOT produce less than 1,800 words.
2. H2 HEADINGS: 8 points if 3+ H2s. You MUST include at least 4 <h2> tags.
3. H3 SUBHEADINGS: 2 points if 2+ H3s. Include at least 3 <h3> tags under your H2s.
3b. H1 TAG: 5 points if EXACTLY 1 H1. You MUST include exactly ONE <h1> tag (the page title). NEVER use more than one H1 — if you see multiple, keep only the first and demote the rest to <h2>.
4. INTERNAL LINKS: 8 points if 3+ links. You MUST include at least 4 <a href="URL"> tags linking to pages listed below.
5. IMAGES: 2 points if 1+ image. Add <img src="" alt="descriptive alt text"> placeholder where an image should go.
6. FOCUS KEYWORD IN CONTENT: 15 points if used 3-8 times. Count your usage — EXACTLY 5 times is ideal.
7. TARGET KEYWORDS: 15 points proportional to how many target keywords appear. Include EVERY one.
8. META TITLE: 10 points — MUST be 50-60 characters AND contain focus keyword near the start. No pipes/dashes (theme adds those).
9. META DESCRIPTION: 10 points — MUST be 120-155 characters AND contain focus keyword naturally. Include a call-to-action.
10. FOCUS KEYWORD: Must be set (if not provided, suggest one based on page content).

MANDATORY:
- Hit ALL thresholds above — this is how the score reaches 90+
- Keep existing good content, expand it substantially
- Australian English ONLY — use "optimise" not "optimize", "colour" not "color", "centre" not "center", "specialise" not "specialize", "organisation" not "organization", "behaviour" not "behavior", "analyse" not "analyze", "licence" (noun), "defence", "favour", "labour", "programme" (not "program" for plans/events). This is MANDATORY for every word in the output.
- Clean HTML: h2, h3, h4, p, ul, ol, li, a, strong, em, img, div, section
- NEW SECTIONS: If you add entirely new sections that did NOT exist in the original, wrap them in <section class="new-section">...</section> so they are visually marked. Do NOT wrap modified/expanded existing sections.
- Every <a> MUST have a real href from the linking pages provided
- Add an <img> tag with descriptive alt text where a relevant image should go

WRITE LIKE A HUMAN — NOT AN AI (this is critical):
- BANNED PHRASES (never use these): "In today's", "In the world of", "Whether you're", "Look no further", "When it comes to", "It's important to note", "At the end of the day", "Are you looking for", "Understanding the importance", "In this comprehensive guide", "Navigate the complexities", "rest assured", "peace of mind", "top-notch", "cutting-edge", "state-of-the-art", "second to none", "the right choice", "your trusted partner", "one-stop shop", "hassle-free", "seamless experience", "don't hesitate to", "feel free to", "game-changer", "unlock the power", "a wide range of", "take it to the next level", "dive into", "let's explore", "without further ado"
- BANNED TRANSITIONS (never start a sentence with): "Furthermore", "Moreover", "Additionally", "In addition", "It's worth noting", "Notably", "Importantly", "Consequently", "Subsequently", "In conclusion", "Ultimately", "Needless to say"
- VARY sentence length — mix short punchy sentences (5-8 words) with longer ones. Never write 3+ sentences of similar length in a row
- USE CONTRACTIONS naturally — "we're", "you'll", "it's", "don't", "won't", "can't" — stiff formal writing sounds robotic
- START sentences differently — don't begin 2+ consecutive sentences the same way (especially not with "We", "Our", "The", "This")
- BE SPECIFIC over generic — instead of "we provide quality services" say exactly what you do and why it matters
- WRITE like you're explaining to a mate over coffee, then polish it for a website — not the other way around
- NO empty filler paragraphs — every paragraph must contain a concrete fact, example, or specific detail
- AVOID over-promising superlatives — don't say "best in Perth" unless you can back it up. Say what makes you different instead

WIREFRAME MATCHING (if a page wireframe is provided):
- You MUST structure your content to match the wireframe sections
- Wrap each section in <!-- SECTION N: TYPE --> and <!-- /SECTION N --> comment markers
- For image-text-columns: use <div class="wf-columns"><div class="wf-col">text</div><div class="wf-col"><img ...></div></div>
- For hero-banner: use <div class="wf-hero"><h1>...</h1><p>...</p></div>
- For feature-list: use proper <ul>/<ol> lists
- For cta-bar: use <div class="wf-cta"><p>...</p><a href="..." class="wf-btn">CTA Text</a></div>
- The preview system will apply the original page's CSS to these sections

OUTPUT FORMAT (JSON only):
{
  "content_html": "<h2>...</h2><p>...</p>...",
  "meta_title": "EXACTLY 50-60 chars, focus keyword near start, compelling",
  "meta_description": "EXACTLY 120-155 chars, contains focus keyword, clear CTA",
  "focus_keyword": "the focus keyword (keep existing if good, suggest better if missing)",
  "ai_notes": "Score targets hit: X words, Y H2s, Z links, focus kw Nx, N/N keywords used, meta title Xch, meta desc Xch"
}
${buildCopywriterContext(project, item)}`;


    const actualWords = contentToOptimise.replace(/<[^>]+>/g, '').trim().split(/\s+/).filter(Boolean).length;

    const curMetaTitle = current_meta?.meta_title || item.draft_meta_title || item.current_meta_title || '';
    const curMetaDesc = current_meta?.meta_desc || item.draft_meta_desc || item.current_meta_desc || '';
    const curFocusKw = current_meta?.focus_keyword || item.draft_focus_keyword || item.current_focus_keyword || '';

    const userPrompt = `OPTIMISE this content. Current content score: ${content_score || 0}/100.

PAGE: ${item.page_url}
FOCUS KEYWORD: "${curFocusKw}" (currently used ${stats?.focus_keyword_count || 0}x — MUST be exactly 5 times, NOT more, NOT less)

CURRENT META TITLE: "${curMetaTitle}" (${curMetaTitle.length} chars — ${curMetaTitle.length >= 50 && curMetaTitle.length <= 60 ? 'OK' : curMetaTitle.length < 50 ? 'TOO SHORT, need 50-60' : 'TOO LONG, need 50-60'})
CURRENT META DESC: "${curMetaDesc}" (${curMetaDesc.length} chars — ${curMetaDesc.length >= 120 && curMetaDesc.length <= 155 ? 'OK' : curMetaDesc.length < 120 ? 'TOO SHORT, need 120-155' : 'TOO LONG, need 120-155'})
META TITLE HAS FOCUS KW: ${curFocusKw && curMetaTitle.toLowerCase().includes(curFocusKw.toLowerCase()) ? 'YES' : 'NO — MUST add it'}
META DESC HAS FOCUS KW: ${curFocusKw && curMetaDesc.toLowerCase().includes(curFocusKw.toLowerCase()) ? 'YES' : 'NO — MUST add it'}

CURRENT STATS:
- Words: ${actualWords} (target: 1500+)
- H2 headings: ${stats?.h2s || 0} (target: 3+)
- H3 subheadings: ${stats?.h3s || 0} (target: 2+)
- Internal links: ${stats?.links || 0} (target: 3+)
- Images: ${stats?.imgs || 0} (target: 1+)

ISSUES TO FIX (you MUST address ALL of these):
${numberedIssues || '1. General optimisation needed — expand content, improve structure, add keywords'}

TARGET KEYWORDS TO INCLUDE:
${(target_keywords || []).map(k => `- "${typeof k === 'string' ? k : k.keyword || k}"`).join('\n') || '- No target keywords set'}

MISSING KEYWORDS (MUST add naturally):
${allMissing.length > 0 ? allMissing.map(k => `- "${k}"`).join('\n') : '- All keywords present'}

PAGES FOR INTERNAL LINKING (add <a> tags linking to these):
${pagesRes.rows.slice(0, 20).map(p => `- ${p.page_url} (${p.page_title})`).join('\n') || '- No pages available yet'}

${contentToOptimise.includes('<!-- SECTION') || contentToOptimise.includes('[~') || contentToOptimise.includes('wf-columns') ? `SKELETON TEMPLATE — YOU MUST PRESERVE THIS EXACT HTML STRUCTURE:
${contentToOptimise.slice(0, 12000)}

===== SKELETON MODE RULES (OVERRIDE ALL OTHER INSTRUCTIONS) =====
1. OUTPUT the EXACT same HTML skeleton above — every <!-- SECTION comment, every <div class="wf-...">, every opening/closing tag MUST appear in your output
2. Replace ONLY the placeholder text inside brackets like "[~80 words about...]", "[HERO HEADING]", "[Section Heading]", "[CTA Button Text]" with real, compelling content
3. NEVER remove, merge, reorder, or flatten sections. NEVER strip wf-hero, wf-cta, wf-columns, wf-col, wf-features, wf-btn classes
4. NEVER convert the structured HTML into flat h2+p paragraphs. The div structure IS the page layout
5. Keep all <img src="" alt="[...]"> tags — fill in descriptive alt text only
6. Each [~N words] placeholder: write EXACTLY that many words (±20%)
7. The page wireframe/design depends on these CSS classes — removing them breaks the visual layout
8. Write 2,000+ words total across ALL sections combined
========================================================` : `CURRENT CONTENT (${actualWords} words):
${contentToOptimise.slice(0, 12000)}`}

CRITICAL REMINDERS:
- You MUST produce at least 2,000 words total. This is NON-NEGOTIABLE.
- Focus keyword "${item.draft_focus_keyword || item.current_focus_keyword}" must appear EXACTLY 5 times in the entire content. NOT 4, NOT 6, NOT 12. EXACTLY 5.
- After writing, mentally count every occurrence of the focus keyword. If you have more than 5, replace the extras with synonyms or rephrase those sentences.
${contentToOptimise.includes('<!-- SECTION') || contentToOptimise.includes('[~') || contentToOptimise.includes('wf-columns') ? '- SKELETON MODE: Fill in the skeleton placeholders. Do NOT rewrite or restructure. Keep ALL HTML tags, divs, classes, and section comments exactly as provided.' : '- Rewrite the FULL content fixing ALL numbered issues above.'}`;

    console.log(`[optimise] Starting AI optimisation for item ${id}, ${numberedIssues.split('\n').length} issues to fix`);

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 16000,
      system: systemPrompt,
      messages: [{ role: 'user', content: buildUserContent(userPrompt, item) }]
    });

    const text = response.content[0]?.text || '';
    let parsed;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch[0]);
    } catch (e) {
      return res.status(500).json({ error: 'Failed to parse AI response', raw: text.slice(0, 500) });
    }

    // Post-process: enforce focus keyword count (3-8 range, target 5)
    let finalHtml = parsed.content_html || '';
    const focusKw = (item.draft_focus_keyword || item.current_focus_keyword || '').toLowerCase().trim();
    if (focusKw && finalHtml) {
      const kwRegex = new RegExp(focusKw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      const matches = finalHtml.match(kwRegex) || [];
      if (matches.length > 8) {
        // Too many — replace excess with synonyms/variations
        let count = 0;
        const maxKeep = 5;
        finalHtml = finalHtml.replace(kwRegex, (match) => {
          count++;
          if (count <= maxKeep) return match; // Keep first 5
          // Replace with variation — just remove the match and use surrounding context
          const words = match.split(/\s+/);
          if (words.length > 2) {
            // Multi-word: use partial or rephrase
            return words.slice(0, Math.ceil(words.length / 2)).join(' ') + ' services';
          }
          return 'our services';
        });
        console.log(`[optimise] Post-process: reduced focus keyword from ${matches.length}x to ~${maxKeep}x`);
      } else if (matches.length < 3) {
        // Too few — inject keyword into content to reach ~5 uses
        const needed = 5 - matches.length;
        let injected = 0;

        // Strategy 1: inject into H2 headings that don't already contain it
        finalHtml = finalHtml.replace(/<h2([^>]*)>(.*?)<\/h2>/gi, (full, attrs, inner) => {
          if (injected >= needed) return full;
          if (inner.toLowerCase().includes(focusKw)) return full;
          injected++;
          return `<h2${attrs}>${inner} – ${focusKw.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}</h2>`;
        });

        // Strategy 2: inject into first paragraph that doesn't contain it
        if (injected < needed) {
          let pDone = false;
          finalHtml = finalHtml.replace(/<p([^>]*)>(.*?)<\/p>/gis, (full, attrs, inner) => {
            if (pDone || injected >= needed) return full;
            if (inner.toLowerCase().includes(focusKw)) return full;
            if (inner.length < 50) return full; // skip tiny paragraphs
            pDone = true;
            injected++;
            const titleCase = focusKw.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
            return `<p${attrs}>For those searching for ${focusKw} options, ${inner}</p>`;
          });
        }

        console.log(`[optimise] Post-process: boosted focus keyword from ${matches.length}x by +${injected} injections`);
      }
    }

    // Post-process: enforce single H1 (demote extras to H2)
    const h1Matches = finalHtml.match(/<h1[\s>]/gi) || [];
    if (h1Matches.length > 1) {
      let h1Count = 0;
      finalHtml = finalHtml.replace(/<h1([\s>])/gi, (match, after) => {
        h1Count++;
        if (h1Count === 1) return match; // keep first H1
        return '<h2' + after; // demote to H2
      });
      finalHtml = finalHtml.replace(/<\/h1>/gi, () => {
        // Need to track which closing tags to change — replace all after first
        return '</h1>';
      });
      // More precise: replace closing tags for demoted H1s
      let closeCount = 0;
      finalHtml = finalHtml.replace(/<\/h1>/gi, () => {
        closeCount++;
        if (closeCount === 1) return '</h1>';
        return '</h2>';
      });
      console.log(`[optimise] Post-process: demoted ${h1Matches.length - 1} extra H1(s) to H2`);
    }

    // Build proposed output
    let proposedTitle = (parsed.meta_title || curMetaTitle || '').trim();
    let proposedDesc = (parsed.meta_description || curMetaDesc || '').trim();
    let proposedFocusKw = (parsed.focus_keyword || curFocusKw || '').trim();
    const fkLower = proposedFocusKw.toLowerCase();

    // POST-PROCESS: validate meta against EXACT scoring rules and fix issues
    // Meta Title: must be 50-60 chars AND contain focus keyword
    if (proposedTitle) {
      // Fix: trim if too long
      if (proposedTitle.length > 60) {
        // Try to cut at a word boundary
        let trimmed = proposedTitle.substring(0, 60);
        const lastSpace = trimmed.lastIndexOf(' ');
        if (lastSpace > 40) trimmed = trimmed.substring(0, lastSpace);
        proposedTitle = trimmed;
        console.log(`[optimise] Meta title trimmed: ${parsed.meta_title?.length} → ${proposedTitle.length} chars`);
      }
      // Fix: pad if too short (append location/brand)
      if (proposedTitle.length < 50 && proposedTitle.length > 30) {
        const loc = project.location || '';
        const biz = project.business_name || '';
        if (loc && !proposedTitle.toLowerCase().includes(loc.toLowerCase())) {
          proposedTitle = proposedTitle + ' in ' + loc;
        } else if (biz && !proposedTitle.toLowerCase().includes(biz.toLowerCase())) {
          proposedTitle = proposedTitle + ' | ' + biz;
        }
        if (proposedTitle.length > 60) proposedTitle = proposedTitle.substring(0, 60).replace(/\s*\|?\s*$/, '');
      }
      // Fix: inject focus keyword if missing
      if (fkLower && !proposedTitle.toLowerCase().includes(fkLower)) {
        const titleCase = proposedFocusKw.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        proposedTitle = titleCase + ' — ' + proposedTitle;
        if (proposedTitle.length > 60) proposedTitle = proposedTitle.substring(0, 60).replace(/\s*—?\s*$/, '');
      }
    }

    // Meta Description: must be 120-155 chars AND contain focus keyword
    if (proposedDesc) {
      if (proposedDesc.length > 155) {
        let trimmed = proposedDesc.substring(0, 155);
        const lastPeriod = trimmed.lastIndexOf('.');
        const lastSpace = trimmed.lastIndexOf(' ');
        if (lastPeriod > 100) trimmed = trimmed.substring(0, lastPeriod + 1);
        else if (lastSpace > 100) trimmed = trimmed.substring(0, lastSpace);
        proposedDesc = trimmed;
        console.log(`[optimise] Meta desc trimmed: ${parsed.meta_description?.length} → ${proposedDesc.length} chars`);
      }
      if (proposedDesc.length < 120 && proposedDesc.length > 60) {
        proposedDesc = proposedDesc.replace(/\.\s*$/, '') + '. Contact us today for a free quote.';
        if (proposedDesc.length > 155) proposedDesc = proposedDesc.substring(0, 155).replace(/\s*$/, '');
      }
      if (fkLower && !proposedDesc.toLowerCase().includes(fkLower)) {
        proposedDesc = proposedDesc.replace(/\.\s*$/, '') + '. Expert ' + proposedFocusKw + ' services.';
        if (proposedDesc.length > 155) proposedDesc = proposedDesc.substring(0, 155).replace(/\s*$/, '');
      }
    }

    // Score the proposed output using the EXACT same algorithm as ContentScorePanel
    const proposedText = finalHtml.replace(/<[^>]+>/g, '');
    const proposedWords = proposedText.trim() ? proposedText.trim().split(/\s+/).length : 0;
    const proposedH2s = (finalHtml.match(/<h2/gi) || []).length;
    const proposedH3s = (finalHtml.match(/<h3/gi) || []).length;
    const proposedLinks = (finalHtml.match(/<a[\s>]/gi) || []).length;
    const proposedImgs = (finalHtml.match(/<img/gi) || []).length;
    const proposedTextLower = proposedText.toLowerCase();
    let fkCount = 0;
    if (fkLower) { let pos = 0; while ((pos = proposedTextLower.indexOf(fkLower, pos)) !== -1) { fkCount++; pos += fkLower.length; } }
    const mtHasKw = fkLower && proposedTitle.toLowerCase().includes(fkLower);
    const mdHasKw = fkLower && proposedDesc.toLowerCase().includes(fkLower);

    let projectedScore = 0;
    const wordTarget = parseInt(stats?.word_target) || 1500;
    projectedScore += proposedWords >= wordTarget ? 20 : proposedWords >= wordTarget * 0.5 ? 12 : proposedWords >= wordTarget * 0.25 ? 6 : 0;
    projectedScore += proposedH2s >= 3 ? 8 : proposedH2s >= 1 ? 4 : 0;
    projectedScore += proposedH3s >= 2 ? 2 : 0;
    projectedScore += proposedLinks >= 3 ? 8 : proposedLinks >= 1 ? 4 : 0;
    projectedScore += proposedImgs >= 1 ? 2 : 0;
    projectedScore += (fkCount >= 3 && fkCount <= 8) ? 15 : fkCount > 8 ? 10 : fkCount >= 1 ? 7 : 0;
    // Target keywords — estimate (can't perfectly replicate client-side without full keyword list)
    projectedScore += 12; // assume most keywords present after optimisation
    // Meta title scoring
    const mtLen = proposedTitle.length;
    if (mtLen >= 50 && mtLen <= 60 && mtHasKw) projectedScore += 10;
    else if (mtLen >= 40 && mtLen <= 65 && mtHasKw) projectedScore += 7;
    else projectedScore += 3;
    // Meta desc scoring
    const mdLen = proposedDesc.length;
    if (mdLen >= 120 && mdLen <= 155 && mdHasKw) projectedScore += 10;
    else if (mdLen >= 100 && mdLen <= 160 && mdHasKw) projectedScore += 7;
    else projectedScore += 3;

    console.log(`[optimise] Projected score: ${projectedScore}/100 | words:${proposedWords} h2:${proposedH2s} h3:${proposedH3s} links:${proposedLinks} imgs:${proposedImgs} fk:${fkCount}x mt:${mtLen}ch md:${mdLen}ch mtKw:${mtHasKw} mdKw:${mdHasKw}`);

    const proposed = {
      content_html: finalHtml,
      meta_title: proposedTitle,
      meta_description: proposedDesc,
      focus_keyword: proposedFocusKw,
      ai_notes: (parsed.ai_notes || 'Content improved') + ` | Projected score: ${Math.min(100, projectedScore)}/100`,
    };

    const currentText2 = contentToOptimise.replace(/<[^>]+>/g, '');
    const currentWords = currentText2.trim() ? currentText2.trim().split(/\s+/).length : 0;

    console.log(`[optimise] Preview ready: ${currentWords} → ${proposedWords} words`);
    res.json({
      preview: true,
      proposed,
      stats: {
        current: { words: currentWords },
        proposed: { words: proposedWords, h2s: proposedH2s, h3s: proposedH3s, links: proposedLinks, imgs: proposedImgs, focus_kw_count: fkCount, projected_score: Math.min(100, projectedScore) }
      },
      item_id: id
    });
  } catch (e) {
    console.error('[optimise] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Apply Optimise — user approved, save the proposed changes
app.post('/api/projects/:projectId/content-queue/:id/apply-optimise', async (req, res) => {
  const { projectId, id } = req.params;
  const { proposed } = req.body;
  if (!proposed) return res.status(400).json({ error: 'No proposed changes' });

  try {
    // Merge AI-suggested target keywords with existing
    let mergedKws = [];
    if (proposed.target_keywords?.length) {
      const existing = (await pool.query('SELECT target_keywords FROM content_queue WHERE id=$1', [id])).rows[0]?.target_keywords || [];
      const existingSet = new Set(existing.map(k => typeof k === 'string' ? k : k.keyword || k));
      mergedKws = [...existing, ...proposed.target_keywords.filter(k => !existingSet.has(k))];
    }

    const updated = await pool.query(
      `UPDATE content_queue SET
        draft_content=COALESCE($1, draft_content),
        draft_meta_title=COALESCE($2, draft_meta_title),
        draft_meta_desc=COALESCE($3, draft_meta_desc),
        draft_focus_keyword=COALESCE($4, draft_focus_keyword),
        ${mergedKws.length ? 'target_keywords=$8,' : ''}
        ai_notes=$5,
        updated_at=NOW()
       WHERE id=$6 AND project_id=$7 RETURNING *`,
      mergedKws.length
        ? [proposed.content_html, proposed.meta_title, proposed.meta_description,
           proposed.focus_keyword || null,
           `AI Optimised: ${proposed.ai_notes || 'Content improved'}`, id, projectId,
           JSON.stringify(mergedKws)]
        : [proposed.content_html, proposed.meta_title, proposed.meta_description,
           proposed.focus_keyword || null,
           `AI Optimised: ${proposed.ai_notes || 'Content improved'}`, id, projectId]
    );
    if (updated.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    console.log(`[apply-optimise] Applied optimisation to item ${id}`);
    res.json(updated.rows[0]);
  } catch (e) {
    console.error('[apply-optimise] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Chat — Claude conversation about draft with optional edits
app.post('/api/projects/:projectId/content-queue/:id/chat', async (req, res) => {
  if (!anthropic) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });
  const { projectId, id } = req.params;
  const { message, history } = req.body; // history = [{role, content}, ...]

  try {
    const item = (await pool.query('SELECT * FROM content_queue WHERE id=$1 AND project_id=$2', [id, projectId])).rows[0];
    if (!item) return res.status(404).json({ error: 'Not found' });

    const project = (await pool.query('SELECT * FROM projects WHERE id=$1', [projectId])).rows[0];

    // Get pages for internal linking context
    const pagesRes = await pool.query(
      `SELECT page_url, page_title FROM (
        SELECT DISTINCT page_url, page_title FROM content_queue
        WHERE project_id=$1 AND stage='published' ORDER BY page_title LIMIT 20
      ) AS p`,
      [projectId]
    );

    const htmlContent = item.draft_content || item.current_content || '';
    const plainText = htmlContent.replace(/<[^>]+>/g, '');
    const wordCount = plainText.trim() ? plainText.trim().split(/\s+/).length : 0;
    const focusKw = (item.draft_focus_keyword || item.current_focus_keyword || '').toLowerCase();

    // Compute SEO score
    const h2s = (htmlContent.match(/<h2[\s>]/gi) || []).length;
    const h3s = (htmlContent.match(/<h3[\s>]/gi) || []).length;
    const links = (htmlContent.match(/<a[\s>]/gi) || []).length;
    const imgs = (htmlContent.match(/<img[\s>]/gi) || []).length;
    let focusCount = 0;
    if (focusKw) {
      const textLower = plainText.toLowerCase();
      let pos = 0;
      while ((pos = textLower.indexOf(focusKw, pos)) !== -1) {
        focusCount++;
        pos += focusKw.length;
      }
    }

    let score = 0;
    const scoreTips = [];
    if (wordCount >= 800) score += 15; else scoreTips.push(`Add words (have ${wordCount}, need 800+)`);
    if (h2s >= 2) score += 15; else scoreTips.push(`Add H2s (have ${h2s}, need 2+)`);
    if (h3s >= 1) score += 5; else scoreTips.push('Add H3s for structure');
    if (links >= 2) score += 10; else scoreTips.push(`Add internal links (have ${links}, need 2+)`);
    if (imgs >= 1) score += 5; else scoreTips.push('Add images');
    if (focusCount >= 3 && focusCount <= 8) score += 20; else if (focusCount >= 1) score += 10; else if (focusKw) scoreTips.push(`Use focus keyword "${focusKw}" more`);
    score = Math.min(100, Math.max(0, score + 20));

    const systemPrompt = `You are an SEO copywriter assistant for "${item.page_title}" (${project.business_name || project.name}).

PAGE STATS: ${wordCount} words | ${h2s} H2s | ${h3s} H3s | ${links} links | ${imgs} images | Focus keyword "${focusKw}" used ${focusCount}x | Score: ${score}/100
${scoreTips.length > 0 ? 'ISSUES: ' + scoreTips.join('. ') : 'Score looks good.'}
Available internal links: ${pagesRes.rows.slice(0, 8).map(p => p.page_url + ' (' + p.page_title + ')').join(', ')}

YOUR JOB: When the user asks you to edit, rewrite, or change content, you MUST return your changes as JSON so they can be applied to the editor. Always respond with a brief explanation PLUS a JSON block.

RESPONSE FORMAT — always use this when making changes:
\`\`\`json
{
  "revised_html": "<the complete rewritten HTML for the section or selected text>",
  "find_text": "<the original text to find and replace — use plain text, not HTML>",
  "meta_title": "optional new meta title",
  "meta_description": "optional new meta description"
}
\`\`\`

RULES:
- "find_text" = the original plain text (no HTML tags) that should be replaced. Copy it EXACTLY from what the user selected or from the content.
- "revised_html" = your rewritten version in clean HTML
- If the user selected specific text ([SELECTED TEXT: "..."]), use that as find_text and rewrite only that portion
- If the user asks to add new content (e.g. "add a section about X"), set find_text to "" and revised_html to the new HTML to append
- If no content changes needed (just answering a question), skip the JSON block entirely
- Australian English ONLY (optimise, colour, centre, favour, labour — NEVER American spellings)
- Write like a human, not an AI. No filler phrases, no "Furthermore", no "In today's"
- Keep existing formatting (h2, h3, p, ul, a tags)

CURRENT CONTENT (first 4000 chars):
${htmlContent.slice(0, 4000)}
${buildCopywriterContext(project, item)}`;

    // Build conversation history
    const messages = [];
    if (history && history.length > 0) {
      for (const h of history.slice(-4)) {
        messages.push({ role: h.role, content: h.content });
      }
    }
    messages.push({ role: 'user', content: message });

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      system: systemPrompt,
      messages
    });

    const text = response.content[0]?.text || '';
    console.log('[chat] Response length:', text.length);

    // Check if response contains JSON update
    let updates = null;
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      try {
        updates = JSON.parse(jsonMatch[1]);
        console.log('[chat] Parsed updates, keys:', Object.keys(updates));
      } catch (e) {
        console.error('[chat] JSON parse failed:', e.message);
      }
    }

    // Return proposed changes WITHOUT applying
    if (updates) {
      const pendingChanges = { itemId: id };
      // New simple format: find_text + revised_html
      if (updates.revised_html) {
        pendingChanges.revised_html = updates.revised_html;
        pendingChanges.find_text = updates.find_text || '';
      }
      // Legacy ops format
      if (updates.ops) pendingChanges.ops = updates.ops;
      if (updates.content_html) pendingChanges.content_html = updates.content_html;
      if (updates.meta_title) pendingChanges.meta_title = updates.meta_title;
      if (updates.meta_description) pendingChanges.meta_description = updates.meta_description;
      if (updates.focus_keyword) pendingChanges.focus_keyword = updates.focus_keyword;

      // Build human-readable change summary
      const changeSummary = [];
      if (updates.revised_html) {
        if (updates.find_text) changeSummary.push('Rewrite: "' + updates.find_text.slice(0, 60) + '..."');
        else changeSummary.push('Add new content section');
      }
      if (updates.meta_title) changeSummary.push('Update meta title');
      if (updates.meta_description) changeSummary.push('Update meta description');

      return res.json({ reply: text, applied: false, pending: pendingChanges, change_summary: changeSummary });
    }

    res.json({ reply: text, applied: false });
  } catch (e) {
    console.error('[chat] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Apply Chat — user approved chat-suggested changes
app.post('/api/projects/:projectId/content-queue/:id/apply-chat', async (req, res) => {
  const { projectId, id } = req.params;
  const { pending } = req.body;
  if (!pending) return res.status(400).json({ error: 'No pending changes' });

  try {
    const item = (await pool.query('SELECT * FROM content_queue WHERE id=$1 AND project_id=$2', [id, projectId])).rows[0];
    if (!item) return res.status(404).json({ error: 'Not found' });

    let currentHtml = item.draft_content || item.current_content || '';
    let contentChanged = false;

    // New simple format: find_text + revised_html
    if (pending.revised_html) {
      if (pending.find_text && pending.find_text.trim()) {
        // Find and replace — try plain text match first, then try matching within HTML
        const plainContent = currentHtml.replace(/<[^>]+>/g, '');
        if (plainContent.includes(pending.find_text)) {
          // Find the HTML that contains this plain text and replace it
          // Strategy: find the text in plain content, locate surrounding HTML tags, replace that chunk
          const escFind = pending.find_text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          // Build a regex that matches the find_text with possible HTML tags interspersed
          const flexRegex = new RegExp(escFind.split(/\s+/).map(w => w).join('[\\s\\S]{0,50}?'), 'i');
          const htmlMatch = currentHtml.match(flexRegex);
          if (htmlMatch) {
            currentHtml = currentHtml.replace(htmlMatch[0], pending.revised_html);
            contentChanged = true;
          } else {
            // Fallback: just append
            currentHtml += '\n' + pending.revised_html;
            contentChanged = true;
          }
        } else if (currentHtml.includes(pending.find_text)) {
          // Direct HTML match
          currentHtml = currentHtml.replace(pending.find_text, pending.revised_html);
          contentChanged = true;
        } else {
          // Can't find — append instead
          currentHtml += '\n' + pending.revised_html;
          contentChanged = true;
        }
      } else {
        // No find_text — append new content
        currentHtml += '\n' + pending.revised_html;
        contentChanged = true;
      }
    }

    // Legacy ops format
    if (pending.ops && Array.isArray(pending.ops)) {
      for (const op of pending.ops) {
        if (op.op === 'append' && op.html) {
          currentHtml += '\n' + op.html;
          contentChanged = true;
        } else if (op.op === 'replace' && op.find && op.html) {
          if (currentHtml.includes(op.find)) {
            currentHtml = currentHtml.replace(op.find, op.html);
            contentChanged = true;
          }
        }
      }
    }
    if (pending.content_html) {
      currentHtml = pending.content_html;
      contentChanged = true;
    }

    const setClauses = [];
    const params = [];
    let paramIdx = 1;
    if (contentChanged) {
      setClauses.push(`draft_content=$${paramIdx++}`);
      params.push(currentHtml);
    }
    if (pending.meta_title) {
      setClauses.push(`draft_meta_title=$${paramIdx++}`);
      params.push(pending.meta_title);
    }
    if (pending.meta_description) {
      setClauses.push(`draft_meta_desc=$${paramIdx++}`);
      params.push(pending.meta_description);
    }
    if (pending.focus_keyword) {
      setClauses.push(`draft_focus_keyword=$${paramIdx++}`);
      params.push(pending.focus_keyword);
    }

    let result = item;
    if (setClauses.length > 0) {
      setClauses.push('updated_at=NOW()');
      params.push(id, projectId);
      const updated = await pool.query(
        `UPDATE content_queue SET ${setClauses.join(', ')} WHERE id=$${paramIdx++} AND project_id=$${paramIdx++} RETURNING *`,
        params
      );
      result = updated.rows[0];
    }

    // Add keywords if provided
    if (pending.add_keywords && Array.isArray(pending.add_keywords)) {
      const currentKws = result.target_keywords || [];
      const newKws = [...new Set([...currentKws, ...pending.add_keywords])];
      const updated = await pool.query(
        'UPDATE content_queue SET target_keywords=$1, updated_at=NOW() WHERE id=$2 RETURNING *',
        [JSON.stringify(newKws), id]
      );
      result = updated.rows[0];
    }

    console.log(`[apply-chat] Applied chat changes to item ${id}`);
    res.json({ item: result, applied: true });
  } catch (e) {
    console.error('[apply-chat] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Competitor word count analysis — check top SERP results for a keyword
app.post('/api/projects/:projectId/competitor-wordcount', async (req, res) => {
  const { keyword, location } = req.body;
  if (!keyword) return res.status(400).json({ error: 'Missing keyword' });
  if (!SERPAPI_KEY) return res.status(503).json({ error: 'SERPAPI_KEY not configured' });

  try {
    const project = (await pool.query('SELECT * FROM projects WHERE id=$1', [req.params.projectId])).rows[0];
    let loc = location || project?.location || 'Perth, Western Australia, Australia';
    // Normalize location for SerpAPI — fix common issues
    loc = loc.replace(/\s+,/g, ',').replace(/,\s+/g, ', ').trim();
    // SerpAPI needs state as full name, not abbreviation
    loc = loc.replace(/\bWA\b/, 'Western Australia').replace(/\bNSW\b/, 'New South Wales')
             .replace(/\bVIC\b/, 'Victoria').replace(/\bQLD\b/, 'Queensland')
             .replace(/\bSA\b/, 'South Australia').replace(/\bTAS\b/, 'Tasmania')
             .replace(/\bNT\b/, 'Northern Territory').replace(/\bACT\b/, 'Australian Capital Territory');
    // If location has suburb + city, use just the city/state for SERP (e.g. "Bayswater, Perth, WA" → "Perth, Western Australia, Australia")
    const locParts = loc.split(',').map(p => p.trim());
    if (locParts.length >= 3) {
      // Try: city, state, country (skip suburb)
      loc = locParts.slice(1).join(', ');
    }
    if (!loc.includes('Australia')) loc += ', Australia';

    console.log(`[competitor-wordcount] Checking: "${keyword}" in ${loc}`);
    const serpData = await serpApiSearch({
      engine: 'google', q: keyword, location: loc, num: 10, gl: 'au', hl: 'en'
    });

    const organicResults = (serpData.organic_results || []).slice(0, 10);
    const competitors = [];
    const ownDomain = (project?.domain || '').replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();

    // Fetch each competitor page and count words (parallel, 10s timeout each)
    const fetchPromises = organicResults.map(async (result, idx) => {
      const url = result.link;
      if (!url) return null;
      const domain = url.replace(/^https?:\/\//, '').split('/')[0].toLowerCase();
      const isOwn = ownDomain && domain.includes(ownDomain.replace('www.', ''));

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const resp = await fetch(url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SEORoomBot/1.0)' }
        });
        clearTimeout(timeout);

        if (!resp.ok) return { position: idx + 1, url, domain, title: result.title, words: null, error: 'HTTP ' + resp.status, isOwn };

        const html = await resp.text();
        // Extract main content — strip scripts, styles, nav, header, footer
        let body = html.replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<nav[\s\S]*?<\/nav>/gi, '')
          .replace(/<header[\s\S]*?<\/header>/gi, '')
          .replace(/<footer[\s\S]*?<\/footer>/gi, '')
          .replace(/<aside[\s\S]*?<\/aside>/gi, '');
        const text = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const words = text.split(' ').filter(w => w.length > 0).length;
        const h2s = (html.match(/<h2[\s>]/gi) || []).length;
        const h3s = (html.match(/<h3[\s>]/gi) || []).length;

        return { position: idx + 1, url, domain, title: result.title, words, h2s, h3s, isOwn };
      } catch (e) {
        return { position: idx + 1, url, domain, title: result.title, words: null, error: e.message?.includes('abort') ? 'Timeout' : e.message, isOwn };
      }
    });

    const results = (await Promise.all(fetchPromises)).filter(Boolean);
    const withWords = results.filter(r => r.words && !r.isOwn);
    // Sort by position (ranking order) for top 3 calc, then by word count for stats
    const byPosition = [...withWords].sort((a, b) => a.position - b.position);
    const wordCounts = withWords.map(r => r.words).sort((a, b) => a - b);

    const avg = wordCounts.length ? Math.round(wordCounts.reduce((a, b) => a + b, 0) / wordCounts.length) : 0;
    const median = wordCounts.length ? wordCounts[Math.floor(wordCounts.length / 2)] : 0;
    // Top 3 = top 3 ranking pages (by SERP position), not lowest word count
    const top3Words = byPosition.slice(0, 3).map(r => r.words);
    const top3Avg = top3Words.length ? Math.round(top3Words.reduce((a, b) => a + b, 0) / top3Words.length) : 0;
    // Recommended: aim for 10-20% more than top 3 average
    const recommended = top3Avg ? Math.round(top3Avg * 1.15 / 50) * 50 : 1500;

    console.log(`[competitor-wordcount] "${keyword}": avg=${avg}, median=${median}, top3avg=${top3Avg}, recommended=${recommended}`);
    res.json({
      keyword,
      location: loc,
      results,
      summary: {
        avg,
        median,
        min: wordCounts.length ? wordCounts[0] : 0,
        max: wordCounts.length ? wordCounts[wordCounts.length - 1] : 0,
        top3_avg: top3Avg,
        recommended,
        competitors_checked: withWords.length
      }
    });
  } catch (e) {
    console.error('[competitor-wordcount] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Re-optimise — refine with user feedback after initial optimise
app.post('/api/projects/:projectId/content-queue/:id/re-optimise', async (req, res) => {
  if (!anthropic) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });
  req.setTimeout(120000);
  res.setTimeout(120000);
  const { projectId, id } = req.params;
  const { feedback, current_proposed, stats, content_score, tips, target_keywords, competitor_data, word_target } = req.body;
  if (!feedback || !current_proposed) return res.status(400).json({ error: 'Missing feedback or proposed content' });

  try {
    const item = (await pool.query('SELECT * FROM content_queue WHERE id=$1 AND project_id=$2', [id, projectId])).rows[0];
    if (!item) return res.status(404).json({ error: 'Not found' });

    const project = (await pool.query('SELECT * FROM projects WHERE id=$1', [projectId])).rows[0];

    const pagesRes = await pool.query(
      `SELECT page_url, page_title FROM (
        SELECT DISTINCT page_url, page_title FROM content_queue
        WHERE project_id=$1 AND stage='published' ORDER BY page_title LIMIT 20
      ) AS p`,
      [projectId]
    );

    console.log(`[re-optimise] Feedback for item ${id}: "${feedback}"`);

    // Fast path: detect questions/comments — no need to process full content
    const feedbackLower = feedback.replace(/\[HIGHLIGHTED TEXT:.*?\]\s*/is, '').trim().toLowerCase();
    // Action commands should go to revision path, not question path
    const isAction = /^(do it|fix it|go|yes|ok|make it|expand|increase|add more|write|rewrite|update|change|improve|optimise|optimize|longer|shorter|beef)/i.test(feedbackLower);
    const isQuestion = !isAction && (feedbackLower.includes('?') ||
      /^(what|how much|how many|why|where|when|which|who|is |are |does |can |could |will |would |should |did |has |have |tell me|explain|show me|list|count|check)/i.test(feedbackLower));

    let response;
    if (isQuestion) {
      // FAST PATH: lightweight prompt with accurate stats, no content return
      const html = current_proposed.content_html || '';
      const plainText = html.replace(/<[^>]+>/g, '');
      const wordCount = plainText.trim() ? plainText.trim().split(/\s+/).length : 0;
      const h2Matches = html.match(/<h2[^>]*>(.*?)<\/h2>/gi) || [];
      const h3Matches = html.match(/<h3[^>]*>(.*?)<\/h3>/gi) || [];
      const linkMatches = html.match(/<a[\s>]/gi) || [];
      const imgMatches = html.match(/<img[\s>]/gi) || [];
      const headings = h2Matches.map(h => h.replace(/<[^>]+>/g, '')).join(' | ');
      const subheadings = h3Matches.map(h => h.replace(/<[^>]+>/g, '')).join(' | ');
      const fk = item.draft_focus_keyword || item.current_focus_keyword || '';
      let fkCount = 0;
      if (fk) { const lower = plainText.toLowerCase(); const fkLower = fk.toLowerCase(); let p = 0; while ((p = lower.indexOf(fkLower, p)) !== -1) { fkCount++; p += fkLower.length; } }

      const tipsStr = (tips || []).join('\n');
      const tkwStr = (target_keywords || []).join(', ');

      response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system: `You are an SEO copywriter assistant. Answer the question in 2-3 sentences MAX. Be direct — numbers first, then one actionable suggestion. No fluff, no repetition. Australian English.
Respond with ONLY a JSON object: {"ai_notes": "your answer", "changed": false}`,
        messages: [{ role: 'user', content: `Question: ${feedback}

ACTUAL CONTENT STATS (these are accurate — use these numbers):
- Word count: ${wordCount}
- H2 headings (${h2Matches.length}): ${headings}
- H3 subheadings (${h3Matches.length}): ${subheadings}
- Internal links: ${linkMatches.length}
- Images: ${imgMatches.length}
- Focus keyword "${fk}": appears ${fkCount} times
- Meta title (${(current_proposed.meta_title || '').length} chars): ${current_proposed.meta_title || ''}
- Meta description (${(current_proposed.meta_description || '').length} chars): ${current_proposed.meta_description || ''}
- Current SEO score: ${content_score || 'unknown'}/100
- Word target: ${word_target || 1500}
- Target keywords: ${tkwStr || 'none set'}
${competitor_data ? `
COMPETITOR ANALYSIS (from "${competitor_data.keyword}" SERP):
- Competitors checked: ${competitor_data.competitors_checked || 0}
- Top 3 average word count: ${competitor_data.top3_avg || 'N/A'}
- All competitors average: ${competitor_data.avg || 'N/A'}
- Recommended word target: ${competitor_data.recommended || 'N/A'}
${(competitor_data.results || []).map((r, i) => `  #${r.position || i+1}: ${r.title} — ${r.words} words`).join('\n')}
` : 'COMPETITOR ANALYSIS: Not yet checked — user should click "Check Competitors" in the score panel.'}

SEO SCORE TIPS:
${tipsStr || 'No tips available'}

CONTENT EXCERPT (first 3000 chars): ${plainText.slice(0, 3000)}

Respond with ONLY JSON.` }]
      });
    } else {
      // FULL PATH: revision with complete content
      response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 8000,
        system: `You are an expert SEO copywriter for "${project.business_name || project.name}". Revise the content based on user feedback while keeping all SEO improvements.

RULES:
- Apply the user's feedback precisely — this is the MOST IMPORTANT thing
- Keep Australian English (optimise, colour, centre, specialise, organisation, behaviour, analyse, favour, labour — NEVER American spellings)
- Keep all existing SEO improvements (keywords, headings, links)
- Output clean HTML: h2, h3, h4, p, ul, ol, li, a, strong, em — NO literal \\n characters
- Focus keyword must appear 3-8 times naturally in the content
- Write like a human, not AI — no banned phrases
- ALWAYS return focus_keyword in the JSON — pick the best primary keyword for the page
- ALWAYS return target_keywords — 3-5 secondary keywords/phrases relevant to the page
- Focus keyword must appear EXACTLY 3-8 times in content (not more, not less — 17x is way too many)
- Use target keywords naturally 1-2 times each in the content

SCORING SYSTEM (how the dashboard calculates score — predict accurately):
- Words >= target: 25 pts | >= 50%: 15 pts | >= 25%: 8 pts
- H2 >= 3: 15 pts | >= 1: 8 pts
- H3 >= 2: 5 pts
- Links >= 3: 10 pts | >= 1: 5 pts
- Images >= 1: 5 pts
- Focus keyword 3-8x in content: 20 pts | >8x: only 12 pts (overused!)
- Target keywords coverage: up to 20 pts (each keyword found = points)
Max 100. Without focus_keyword + target_keywords, score CAPS at 60.

YOU MUST RESPOND WITH ONLY A JSON OBJECT:
{"content_html": "<h2>...</h2><p>...</p>...", "meta_title": "title", "meta_description": "desc", "focus_keyword": "primary keyword", "target_keywords": ["kw1", "kw2", "kw3"], "ai_notes": "1-2 sentence max summary", "changed": true}

CRITICAL: ai_notes must be SHORT — max 2 sentences. Do NOT list every change.${buildCopywriterContext(project, item)}`,
        messages: [{ role: 'user', content: buildUserContent(`USER INSTRUCTION: ${feedback}

CURRENT SEO SCORE: ${content_score || 'unknown'}/100
TARGET KEYWORDS: ${(target_keywords || []).join(', ') || 'none'}
SEO TIPS:
${(tips || []).join('\n')}

CURRENT CONTENT (revise this):
${current_proposed.content_html}

CURRENT META TITLE: ${current_proposed.meta_title || ''}
CURRENT META DESCRIPTION: ${current_proposed.meta_description || ''}

PAGES FOR INTERNAL LINKING:
${pagesRes.rows.map(p => `- ${p.page_url} (${p.page_title})`).join('\n')}

Respond with ONLY the JSON object.`, item) }]
      });
    }

    const text = response.content[0]?.text || '';
    let parsed;
    try {
      // Try parsing directly first (we asked for raw JSON)
      const trimmed = text.trim();
      if (trimmed.startsWith('{')) {
        // Find matching closing brace
        let depth = 0, end = -1;
        for (let i = 0; i < trimmed.length; i++) {
          if (trimmed[i] === '{') depth++;
          else if (trimmed[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
        parsed = JSON.parse(trimmed.slice(0, end + 1));
      } else {
        // Try markdown code block
        const codeMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (codeMatch) {
          parsed = JSON.parse(codeMatch[1]);
        } else {
          // Find first { and match braces
          const start = trimmed.indexOf('{');
          if (start === -1) throw new Error('No JSON');
          let depth2 = 0, end2 = -1;
          for (let i = start; i < trimmed.length; i++) {
            if (trimmed[i] === '{') depth2++;
            else if (trimmed[i] === '}') { depth2--; if (depth2 === 0) { end2 = i; break; } }
          }
          parsed = JSON.parse(trimmed.slice(start, end2 + 1));
        }
      }
    } catch (e) {
      console.error('[re-optimise] Parse failed:', e.message, 'Raw start:', text.slice(0, 200));
      // Last resort: if there's HTML in the response, use it as content
      if (text.includes('<h2') || text.includes('<p>')) {
        const htmlStart = text.indexOf('<');
        parsed = { content_html: text.slice(htmlStart), ai_notes: 'Revised (raw extraction)', meta_title: current_proposed.meta_title, meta_description: current_proposed.meta_description };
      } else {
        return res.status(500).json({ error: 'AI response format issue. Try shorter feedback.' });
      }
    }

    // If AI said no changes, return content unchanged with just the answer
    const noChange = parsed.changed === false;

    // Clean literal \n from content_html
    let cleanHtml = (parsed.content_html || current_proposed.content_html || '');
    cleanHtml = cleanHtml.replace(/\\n/g, '').replace(/\n(?!<)/g, '');

    const proposed = {
      content_html: noChange ? current_proposed.content_html : cleanHtml,
      meta_title: noChange ? current_proposed.meta_title : (parsed.meta_title || current_proposed.meta_title),
      meta_description: noChange ? current_proposed.meta_description : (parsed.meta_description || current_proposed.meta_description),
      focus_keyword: parsed.focus_keyword || current_proposed.focus_keyword || '',
      target_keywords: parsed.target_keywords || [],
      ai_notes: parsed.ai_notes || (noChange ? 'No changes made.' : 'Revised based on feedback'),
    };

    const proposedText = (proposed.content_html || '').replace(/<[^>]+>/g, '');
    const proposedWords = proposedText.trim() ? proposedText.trim().split(/\s+/).length : 0;
    const proposedH2s = ((proposed.content_html || '').match(/<h2/gi) || []).length;
    const proposedH3s = ((proposed.content_html || '').match(/<h3/gi) || []).length;
    const proposedLinks = ((proposed.content_html || '').match(/<a[\s>]/gi) || []).length;

    const currentText = (item.draft_content || item.current_content || '').replace(/<[^>]+>/g, '');
    const currentWords = currentText.trim() ? currentText.trim().split(/\s+/).length : 0;

    console.log(`[re-optimise] ${noChange ? 'Question' : 'Revised'} item ${id}: ${currentWords} → ${proposedWords} words`);
    res.json({
      preview: true,
      proposed,
      changed: !noChange,
      stats: {
        current: { words: currentWords },
        proposed: { words: proposedWords, h2s: proposedH2s, h3s: proposedH3s, links: proposedLinks }
      },
      item_id: id
    });
  } catch (e) {
    console.error('[re-optimise] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Re-optimise for site_pages — same as content-queue re-optimise but queries site_pages table
app.post('/api/projects/:projectId/site-pages/:id/re-optimise', async (req, res) => {
  if (!anthropic) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });
  req.setTimeout(120000);
  res.setTimeout(120000);
  const { projectId, id } = req.params;
  const { feedback, current_proposed, stats, content_score, tips, target_keywords, competitor_data, word_target } = req.body;
  if (!feedback || !current_proposed) return res.status(400).json({ error: 'Missing feedback or proposed content' });

  try {
    const item = (await pool.query('SELECT * FROM site_pages WHERE id=$1 AND project_id=$2', [id, projectId])).rows[0];
    if (!item) return res.status(404).json({ error: 'Not found' });

    const project = (await pool.query('SELECT * FROM projects WHERE id=$1', [projectId])).rows[0];

    // Get published pages for internal linking context
    const pagesRes = await pool.query(
      `SELECT COALESCE(published_url, '/' || slug || '/') as page_url, page_name as page_title FROM site_pages WHERE project_id=$1 AND stage='published' ORDER BY page_name LIMIT 20`,
      [projectId]
    );

    console.log(`[re-optimise-sp] Feedback for site_page ${id}: "${feedback}", competitor_data: ${competitor_data ? 'YES (' + competitor_data.competitors_checked + ' checked)' : 'NONE'}, word_target: ${word_target}`);

    const feedbackLower = feedback.replace(/\[HIGHLIGHTED TEXT:.*?\]\s*/is, '').trim().toLowerCase();
    // Action commands should go to revision path, not question path
    const isAction = /^(do it|fix it|go|yes|ok|make it|expand|increase|add more|write|rewrite|update|change|improve|optimise|optimize|longer|shorter|beef)/i.test(feedbackLower);
    const isQuestion = !isAction && (feedbackLower.includes('?') ||
      /^(what|how much|how many|why|where|when|which|who|is |are |does |can |could |will |would |should |did |has |have |tell me|explain|show me|list|count|check)/i.test(feedbackLower));

    let response;
    if (isQuestion) {
      const html = current_proposed.content_html || '';
      const plainText = html.replace(/<[^>]+>/g, '');
      const wordCount = plainText.trim() ? plainText.trim().split(/\s+/).length : 0;
      const h2Matches = html.match(/<h2[^>]*>(.*?)<\/h2>/gi) || [];
      const h3Matches = html.match(/<h3[^>]*>(.*?)<\/h3>/gi) || [];
      const linkMatches = html.match(/<a[\s>]/gi) || [];
      const imgMatches = html.match(/<img[\s>]/gi) || [];
      const headings = h2Matches.map(h => h.replace(/<[^>]+>/g, '')).join(' | ');
      const subheadings = h3Matches.map(h => h.replace(/<[^>]+>/g, '')).join(' | ');
      const fk = item.focus_keyword || '';
      let fkCount = 0;
      if (fk) { const lower = plainText.toLowerCase(); const fkLower = fk.toLowerCase(); let p = 0; while ((p = lower.indexOf(fkLower, p)) !== -1) { fkCount++; p += fkLower.length; } }

      const tipsStr = (tips || []).join('\n');
      const tkwStr = (target_keywords || []).join(', ');

      response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system: `You are an SEO copywriter assistant. Answer the question in 2-3 sentences MAX. Be direct — numbers first, then one actionable suggestion. No fluff, no repetition. Australian English.
Respond with ONLY a JSON object: {"ai_notes": "your answer", "changed": false}`,
        messages: [{ role: 'user', content: `Question: ${feedback}

ACTUAL CONTENT STATS (these are accurate — use these numbers):
- Word count: ${wordCount}
- H2 headings (${h2Matches.length}): ${headings}
- H3 subheadings (${h3Matches.length}): ${subheadings}
- Internal links: ${linkMatches.length}
- Images: ${imgMatches.length}
- Focus keyword "${fk}": appears ${fkCount} times
- Meta title (${(current_proposed.meta_title || '').length} chars): ${current_proposed.meta_title || ''}
- Meta description (${(current_proposed.meta_description || '').length} chars): ${current_proposed.meta_description || ''}
- Current SEO score: ${content_score || 'unknown'}/100
- Word target: ${word_target || 1500}
- Target keywords: ${tkwStr || 'none set'}
${competitor_data ? `
COMPETITOR ANALYSIS (from "${competitor_data.keyword}" SERP):
- Competitors checked: ${competitor_data.competitors_checked || 0}
- Top 3 average word count: ${competitor_data.top3_avg || 'N/A'}
- All competitors average: ${competitor_data.avg || 'N/A'}
- Recommended word target: ${competitor_data.recommended || 'N/A'}
${(competitor_data.results || []).map((r, i) => `  #${r.position || i+1}: ${r.title} — ${r.words} words`).join('\n')}
` : 'COMPETITOR ANALYSIS: Not yet checked — user should click "Check Competitors" in the score panel.'}

SEO SCORE TIPS:
${tipsStr || 'No tips available'}

CONTENT EXCERPT (first 3000 chars): ${plainText.slice(0, 3000)}

Respond with ONLY JSON.` }]
      });
    } else {
      response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 8000,
        system: `You are an expert SEO copywriter for "${project.business_name || project.name}". Revise the content based on user feedback while keeping all SEO improvements.

RULES:
- Apply the user's feedback precisely — this is the MOST IMPORTANT thing
- Keep Australian English (optimise, colour, centre, specialise, organisation, behaviour, analyse, favour, labour — NEVER American spellings)
- Keep all existing SEO improvements (keywords, headings, links)
- Output clean HTML: h2, h3, h4, p, ul, ol, li, a, strong, em — NO literal \\n characters
- Focus keyword must appear 3-8 times naturally in the content
- Write like a human, not AI — no banned phrases
- ALWAYS return focus_keyword in the JSON — pick the best primary keyword for the page
- ALWAYS return target_keywords — 3-5 secondary keywords/phrases relevant to the page
- Focus keyword must appear EXACTLY 3-8 times in content (not more, not less — 17x is way too many)
- Use target keywords naturally 1-2 times each in the content

SCORING SYSTEM (how the dashboard calculates score — predict accurately):
- Words >= target: 25 pts | >= 50%: 15 pts | >= 25%: 8 pts
- H2 >= 3: 15 pts | >= 1: 8 pts
- H3 >= 2: 5 pts
- Links >= 3: 10 pts | >= 1: 5 pts
- Images >= 1: 5 pts
- Focus keyword 3-8x in content: 20 pts | >8x: only 12 pts (overused!)
- Target keywords coverage: up to 20 pts (each keyword found = points)
Max 100. Without focus_keyword + target_keywords, score CAPS at 60.

YOU MUST RESPOND WITH ONLY A JSON OBJECT:
{"content_html": "<h2>...</h2><p>...</p>...", "meta_title": "title", "meta_description": "desc", "focus_keyword": "primary keyword", "target_keywords": ["kw1", "kw2", "kw3"], "ai_notes": "1-2 sentence max summary", "changed": true}

CRITICAL: ai_notes must be SHORT — max 2 sentences. Do NOT list every change.${buildCopywriterContext(project, item)}`,
        messages: [{ role: 'user', content: `USER INSTRUCTION: ${feedback}

CURRENT SEO SCORE: ${content_score || 'unknown'}/100
TARGET KEYWORDS: ${(target_keywords || []).join(', ') || 'none'}
SEO TIPS:
${(tips || []).join('\n')}

CURRENT CONTENT (revise this):
${current_proposed.content_html}

CURRENT META TITLE: ${current_proposed.meta_title || ''}
CURRENT META DESCRIPTION: ${current_proposed.meta_description || ''}

PAGES FOR INTERNAL LINKING:
${pagesRes.rows.map(p => `- ${p.page_url || p.page_title} (${p.page_title})`).join('\n')}

Respond with ONLY the JSON object.` }]
      });
    }

    const text = response.content[0]?.text || '';
    let parsed;
    try {
      const trimmed = text.trim();
      if (trimmed.startsWith('{')) {
        let depth = 0, end = -1;
        for (let i = 0; i < trimmed.length; i++) {
          if (trimmed[i] === '{') depth++;
          else if (trimmed[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
        parsed = JSON.parse(trimmed.slice(0, end + 1));
      } else {
        const codeMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (codeMatch) {
          parsed = JSON.parse(codeMatch[1]);
        } else {
          const start = trimmed.indexOf('{');
          if (start === -1) throw new Error('No JSON');
          let depth2 = 0, end2 = -1;
          for (let i = start; i < trimmed.length; i++) {
            if (trimmed[i] === '{') depth2++;
            else if (trimmed[i] === '}') { depth2--; if (depth2 === 0) { end2 = i; break; } }
          }
          parsed = JSON.parse(trimmed.slice(start, end2 + 1));
        }
      }
    } catch (e) {
      console.error('[re-optimise-sp] Parse failed:', e.message);
      if (text.includes('<h2') || text.includes('<p>')) {
        const htmlStart = text.indexOf('<');
        parsed = { content_html: text.slice(htmlStart), ai_notes: 'Revised (raw extraction)', meta_title: current_proposed.meta_title, meta_description: current_proposed.meta_description };
      } else {
        return res.status(500).json({ error: 'AI response format issue. Try shorter feedback.' });
      }
    }

    const noChange = parsed.changed === false;
    let cleanHtml = (parsed.content_html || current_proposed.content_html || '');
    cleanHtml = cleanHtml.replace(/\\n/g, '').replace(/\n(?!<)/g, '');

    const proposed = {
      content_html: noChange ? current_proposed.content_html : cleanHtml,
      meta_title: noChange ? current_proposed.meta_title : (parsed.meta_title || current_proposed.meta_title),
      meta_description: noChange ? current_proposed.meta_description : (parsed.meta_description || current_proposed.meta_description),
      focus_keyword: parsed.focus_keyword || current_proposed.focus_keyword || '',
      target_keywords: parsed.target_keywords || [],
      ai_notes: parsed.ai_notes || (noChange ? 'No changes made.' : 'Revised based on feedback'),
    };

    const proposedText = (proposed.content_html || '').replace(/<[^>]+>/g, '');
    const proposedWords = proposedText.trim() ? proposedText.trim().split(/\s+/).length : 0;
    const proposedH2s = ((proposed.content_html || '').match(/<h2/gi) || []).length;
    const proposedH3s = ((proposed.content_html || '').match(/<h3/gi) || []).length;
    const proposedLinks = ((proposed.content_html || '').match(/<a[\s>]/gi) || []).length;

    const currentText = (item.draft_content || '').replace(/<[^>]+>/g, '');
    const currentWords = currentText.trim() ? currentText.trim().split(/\s+/).length : 0;

    console.log(`[re-optimise-sp] ${noChange ? 'Question' : 'Revised'} site_page ${id}: ${currentWords} → ${proposedWords} words`);
    res.json({
      preview: true,
      proposed,
      changed: !noChange,
      stats: {
        current: { words: currentWords },
        proposed: { words: proposedWords, h2s: proposedH2s, h3s: proposedH3s, links: proposedLinks }
      },
      item_id: id
    });
  } catch (e) {
    console.error('[re-optimise-sp] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Live preview ��� fetch live page, extract header/hero/footer, inject draft content
// AI rewrite a single meta field (title or description)
app.post('/api/projects/:projectId/rewrite-meta', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { field, meta_title, meta_desc, focus_keyword, content_snippet, score_tips } = req.body;
    const project = (await pool.query('SELECT * FROM projects WHERE id=$1', [projectId])).rows[0];

    const currentTitle = meta_title || '';
    const currentDesc = meta_desc || '';
    const focusKw = focus_keyword || '';
    const bizName = project.business_name || project.name || '';
    const location = project.location || '';
    const industry = project.industry || '';
    const contentSnippet = (content_snippet || '').slice(0, 500);

    // Build score context from tips
    const metaIssues = (score_tips || []).filter(t => t.msg && (t.msg.toLowerCase().includes('meta') || t.msg.toLowerCase().includes('title') || t.msg.toLowerCase().includes('desc'))).map(t => `- ${t.msg}`).join('\n');

    let prompt;
    if (field === 'title') {
      prompt = `You are an SEO expert. Rewrite this meta title to score maximum points on the content score panel.

Current meta title: "${currentTitle}" (${currentTitle.length} chars)
Focus keyword: "${focusKw}"
Business: ${bizName}, ${location}
Industry: ${industry}
Page content preview: ${contentSnippet}

SCORE ISSUES TO FIX:
${metaIssues || '- No specific issues, but optimise for maximum score'}

SCORING RULES (you MUST hit these for 10/10 points):
- EXACTLY 50-60 characters (currently ${currentTitle.length} — ${currentTitle.length >= 50 && currentTitle.length <= 60 ? 'OK' : currentTitle.length < 50 ? 'TOO SHORT' : 'TOO LONG'})
- MUST contain the focus keyword "${focusKw}" near the start
- Compelling with a clear value proposition
- Include location for local service pages
- No pipes or dashes (theme adds brand name)

Return ONLY the new title text, nothing else. Count your characters carefully.`;
    } else {
      prompt = `You are an SEO expert. Rewrite this meta description to score maximum points on the content score panel.

Current meta description: "${currentDesc}" (${currentDesc.length} chars)
Meta title: "${currentTitle}"
Focus keyword: "${focusKw}"
Business: ${bizName}, ${location}
Industry: ${industry}
Page content preview: ${contentSnippet}

SCORE ISSUES TO FIX:
${metaIssues || '- No specific issues, but optimise for maximum score'}

SCORING RULES (you MUST hit these for 10/10 points):
- EXACTLY 120-155 characters (currently ${currentDesc.length} — ${currentDesc.length >= 120 && currentDesc.length <= 155 ? 'OK' : currentDesc.length < 120 ? 'TOO SHORT' : 'TOO LONG'})
- MUST contain the focus keyword "${focusKw}" naturally
- Include a clear call-to-action (call, book, visit, get a quote)
- Compelling for Google search results
- Mention unique selling points from the content

Return ONLY the new description text, nothing else. Count your characters carefully.`;
    }

    const aiResp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }]
    });
    const result = aiResp.content[0].text.trim().replace(/^["']|["']$/g, '');
    res.json({ [field]: result });
  } catch (e) {
    console.error('[rewrite-meta] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/projects/:projectId/content-queue/:id/preview', async (req, res) => {
  req.setTimeout(30000);
  res.setTimeout(30000);
  const { projectId, id } = req.params;
  try {
    const item = (await pool.query('SELECT * FROM content_queue WHERE id=$1 AND project_id=$2', [id, projectId])).rows[0];
    if (!item) return res.status(404).send('Not found');
    const project = (await pool.query('SELECT * FROM projects WHERE id=$1', [projectId])).rows[0];

    // Strip leading H1 from draft content — WP themes render page title as H1 already
    const rawDraftContent = item.draft_content || item.current_content || '';
    const draftContent = rawDraftContent.replace(/^\s*<h1[^>]*>.*?<\/h1>\s*/i, '');
    const draftTitle = item.draft_meta_title || item.page_title || '';
    const draftDesc = item.draft_meta_desc || '';

    // Build the page URL
    let pageUrl = item.page_url || '';
    if (pageUrl && !pageUrl.startsWith('http')) {
      pageUrl = 'https://' + (project.domain || '') + pageUrl;
    }

    if (!pageUrl) {
      // No live page — render standalone preview
      res.setHeader('Content-Type', 'text/html');
      return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${draftTitle}</title>
        <style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:800px;margin:40px auto;padding:0 20px;line-height:1.8;color:#333}
        h1,h2,h3{color:#1a1a1a}img{max-width:100%;height:auto;border-radius:8px}a{color:#2563eb}</style>
        </head><body><h1>${draftTitle}</h1>${draftContent}</body></html>`);
    }

    // === PREVIEW STRATEGY ===
    // Iframe-based split view. Left = live page in iframe (fully working JS/CSS).
    // Right = draft content rendered cleanly. 100% generic — any CMS/builder.
    const escapedDraft = JSON.stringify(draftContent);
    const escapedTitle = JSON.stringify(draftTitle || item.page_title || '');
    const escapedDesc = JSON.stringify(draftDesc || '');
    const escapedUrl = JSON.stringify(pageUrl);

    const splitHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Preview: ${(draftTitle || item.page_title || '').replace(/"/g, '&quot;')}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
.split-container{display:flex;width:100vw;height:100vh}
.panel{flex:1;display:flex;flex-direction:column;overflow:hidden}
.panel-left{border-right:3px solid #6366f1}
.panel-label{padding:10px 20px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;text-align:center;flex-shrink:0}
.panel-left .panel-label{background:linear-gradient(135deg,#1e293b,#334155);color:#94a3b8}
.panel-right .panel-label{background:linear-gradient(135deg,#6366f1,#a855f7);color:#fff}
.panel-left iframe{flex:1;width:100%;border:none}
.panel-right-scroll{flex:1;overflow-y:auto;background:#fff}
.dp-meta{background:#f8fafc;padding:16px 24px;border-bottom:1px solid #e2e8f0}
.dp-meta-label{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#94a3b8;font-weight:700;margin-bottom:6px}
.dp-meta-title{font-size:18px;color:#1e40af;font-weight:600;line-height:1.3;margin-bottom:4px}
.dp-meta-url{font-size:13px;color:#16a34a;margin-bottom:6px}
.dp-meta-desc{font-size:14px;color:#475569;line-height:1.5}
.dp-content{padding:32px 40px;color:#1a1a1a;font-size:16px;line-height:1.8}
.dp-content h1{font-size:28px;margin:0 0 16px;color:#111;font-weight:800}
.dp-content h2{font-size:22px;margin:28px 0 12px;color:#1e293b;font-weight:700;border-bottom:2px solid #e2e8f0;padding-bottom:8px}
.dp-content h3{font-size:18px;margin:22px 0 10px;color:#334155;font-weight:600}
.dp-content p{margin:0 0 16px;color:#374151}
.dp-content ul,.dp-content ol{margin:0 0 16px;padding-left:24px}
.dp-content li{margin:0 0 6px;color:#374151}
.dp-content a{color:#2563eb;text-decoration:underline}
.dp-content img{max-width:100%;height:auto;border-radius:8px;margin:16px 0}
.dp-content strong{color:#111}
.dp-content .new-section{border-left:4px solid #22c55e;padding-left:16px;margin:24px 0;background:#f0fdf4;padding:16px 16px 16px 20px;border-radius:0 8px 8px 0}
.dp-content .new-section::before{content:'NEW SECTION';display:block;font-size:10px;font-weight:700;color:#16a34a;letter-spacing:1px;margin-bottom:8px}
</style>
</head><body>
<div class="split-container">
  <div class="panel panel-left">
    <div class="panel-label">Current Live Page</div>
    <iframe src="${pageUrl.replace(/"/g, '&quot;')}" sandbox="allow-same-origin allow-scripts allow-popups" onerror="this.style.display='none';this.parentElement.querySelector('.iframe-fallback').style.display='flex'"></iframe>
    <div class="iframe-fallback" style="display:none;flex:1;align-items:center;justify-content:center;flex-direction:column;padding:40px;text-align:center;color:#64748b">
      <p style="font-size:16px;margin-bottom:12px">Live page cannot be embedded (site blocks iframes)</p>
      <a href="${pageUrl.replace(/"/g, '&quot;')}" target="_blank" style="color:#6366f1;font-weight:600">Open live page in new tab</a>
    </div>
  </div>
  <div class="panel panel-right">
    <div class="panel-label">Proposed Draft</div>
    <div class="panel-right-scroll">
      <div class="dp-meta">
        <div class="dp-meta-label">Google Search Preview</div>
        <div class="dp-meta-title" id="meta-title"></div>
        <div class="dp-meta-url" id="meta-url"></div>
        <div class="dp-meta-desc" id="meta-desc"></div>
      </div>
      <div class="dp-content" id="dp-body"></div>
    </div>
  </div>
</div>
<script>
document.getElementById('meta-title').textContent = ${escapedTitle};
document.getElementById('meta-url').textContent = ${escapedUrl};
document.getElementById('meta-desc').textContent = ${escapedDesc};
document.getElementById('dp-body').innerHTML = ${escapedDraft};
</script>
</body></html>`;

    console.log(`[preview] Serving iframe split-view for "${item.page_title}"`);
    res.setHeader('Content-Type', 'text/html');
    res.send(splitHtml);
  } catch (e) {
    console.error('[preview] Error:', e.message);
    res.status(500).send('Preview error: ' + e.message);
  }
});

// Preview for site_pages (New Website) — standalone preview since no live URL
app.get('/api/projects/:projectId/site-pages/:id/preview', async (req, res) => {
  try {
    const item = (await pool.query('SELECT * FROM site_pages WHERE id=$1 AND project_id=$2', [req.params.id, req.params.projectId])).rows[0];
    if (!item) return res.status(404).send('Not found');
    const project = (await pool.query('SELECT * FROM projects WHERE id=$1', [req.params.projectId])).rows[0];

    const draftContent = item.draft_content || '';
    const draftTitle = item.meta_title || item.page_name || '';
    const draftDesc = item.meta_description || '';
    const domain = project?.domain || '';
    const slug = item.slug || '';

    // Try to fetch the live site for header/footer
    let headerBlock = '', footerBlock = '', headContent = '', bodyClasses = '', base = '';
    try {
      const siteUrl = domain.startsWith('http') ? domain : ('https://' + domain);
      base = new URL(siteUrl).origin;
      const resp = await fetch(siteUrl, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' } });
      if (resp.ok) {
        const html = await resp.text();
        const headMatch = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
        headContent = headMatch ? headMatch[1] : '';
        const headerMatch = html.match(/<header[^>]*>[\s\S]*?<\/header>/i);
        if (headerMatch) headerBlock = headerMatch[0];
        const footerMatch = html.match(/<footer[^>]*>[\s\S]*?<\/footer>/i);
        if (footerMatch) footerBlock = footerMatch[0];
        const bodyClassMatch = html.match(/<body[^>]*class="([^"]*)"/i);
        bodyClasses = bodyClassMatch ? bodyClassMatch[1] : '';
        // Replace meta title
        if (draftTitle) headContent = headContent.replace(/<title>[^<]*<\/title>/i, '<title>' + draftTitle + '</title>');
        const fixUrls = (s) => s.replace(/(href|src|action)=["']\//g, '$1="' + base + '/');
        headContent = fixUrls(headContent);
        headerBlock = fixUrls(headerBlock);
        footerBlock = fixUrls(footerBlock);
      }
    } catch (e) { console.log('[preview-sp] Could not fetch site for header/footer:', e.message); }

    const previewHtml = `<!DOCTYPE html><html lang="en-AU"><head>
      ${base ? '<base href="' + base + '/">' : ''}
      ${headContent || '<meta charset="utf-8"><title>' + draftTitle + '</title>'}
      <style>
        .seo-preview-banner { position:fixed;top:0;left:0;right:0;z-index:99999;background:linear-gradient(135deg,#a855f7,#6366f1);color:#fff;padding:10px 20px;font-family:-apple-system,sans-serif;font-size:14px;font-weight:600;display:flex;align-items:center;justify-content:space-between;box-shadow:0 2px 20px rgba(0,0,0,0.3); }
        .seo-preview-spacer { height:44px; }
        .seo-draft-content { max-width:900px;margin:40px auto;padding:40px 30px;font-size:16px;line-height:1.9; }
        .seo-draft-content h1,.seo-draft-content h2,.seo-draft-content h3,.seo-draft-content h4 { margin-top:1.5em;margin-bottom:0.5em; }
        .seo-draft-content h2 { font-size:28px; } .seo-draft-content h3 { font-size:22px; }
        .seo-draft-content p { margin-bottom:1em; } .seo-draft-content img { max-width:100%;height:auto;border-radius:8px;margin:20px 0; }
        .seo-draft-content a { color:#2563eb;text-decoration:underline; }
        .seo-draft-content ul,.seo-draft-content ol { margin:1em 0;padding-left:2em; } .seo-draft-content li { margin-bottom:0.5em; }
        .seo-draft-meta { max-width:900px;margin:20px auto 0;padding:16px 30px;background:#f0f4ff;border:1px solid #d0d8f0;border-radius:8px;font-size:14px; }
        .seo-draft-meta .meta-title { font-size:20px;color:#1a0dab;font-weight:600;margin-bottom:4px; }
        .seo-draft-meta .meta-url { font-size:13px;color:#006621;margin-bottom:4px; }
        .seo-draft-meta .meta-desc { font-size:14px;color:#545454; }
        .seo-draft-meta .meta-label { font-size:11px;color:#888;text-transform:uppercase;font-weight:600;margin-bottom:8px; }
      </style></head><body class="${bodyClasses}">
      <div class="seo-preview-banner"><span>\u{1F4CB} NEW PAGE PREVIEW — ${headerBlock ? 'Header & footer from live site' : 'Standalone preview'}</span><span style="opacity:0.7;font-size:12px">${item.page_name}</span></div>
      <div class="seo-preview-spacer"></div>
      ${headerBlock}
      <div class="seo-draft-meta"><div class="meta-label">Google Search Preview</div><div class="meta-title">${draftTitle}</div><div class="meta-url">${domain}/${slug}/</div><div class="meta-desc">${draftDesc}</div></div>
      <div id="content" class="site-content"><div class="seo-draft-content entry-content"><div class="container" style="max-width:900px;margin:0 auto;padding:40px 30px">${draftContent}</div></div></div>
      ${footerBlock}
      <script>document.addEventListener('click',function(e){if(e.target.closest('a')){e.preventDefault();e.stopPropagation();}},true);</script>
    </body></html>`;

    res.setHeader('Content-Type', 'text/html');
    res.send(previewHtml);
  } catch (e) {
    console.error('[preview-sp] Error:', e.message);
    res.status(500).send('Preview error: ' + e.message);
  }
});

// Generate content skeleton — HTML-first: fetch real page DOM, strip text content, keep structure
app.post('/api/projects/:projectId/content-queue/:id/generate-skeleton', async (req, res) => {
  req.setTimeout(60000);
  res.setTimeout(60000);
  const { projectId, id } = req.params;
  try {
    const item = (await pool.query('SELECT * FROM content_queue WHERE id=$1 AND project_id=$2', [id, projectId])).rows[0];
    if (!item) return res.status(404).json({ error: 'Not found' });
    const project = (await pool.query('SELECT * FROM projects WHERE id=$1', [projectId])).rows[0];

    // Build page URL
    let pageUrl = item.page_url || '';
    if (pageUrl && !pageUrl.startsWith('http')) pageUrl = 'https://' + (project?.domain || '') + pageUrl;
    if (!pageUrl) return res.status(400).json({ error: 'No page URL set' });

    console.log(`[skeleton] Fetching live page: ${pageUrl}`);
    const resp = await fetch(pageUrl, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
    });
    if (!resp.ok) return res.status(502).json({ error: `Failed to fetch page: ${resp.status}` });
    const html = await resp.text();

    // Extract content between </header> and <footer>
    const headerEnd = html.search(/<\/header>/i);
    const footerStart = html.search(/<footer/i);
    const middleHtml = html.slice(
      headerEnd !== -1 ? headerEnd + '</header>'.length : 0,
      footerStart !== -1 ? footerStart : html.length
    );

    // Parse top-level blocks (section, div, main, article) with depth tracking
    const blockRegex = /<(section|div|main|article)([^>]*)>/gi;
    const blocks = [];
    let match;
    while ((match = blockRegex.exec(middleHtml)) !== null) {
      const tag = match[1].toLowerCase();
      const attrs = match[2];
      const blockStart = match.index;
      let depth = 1, pos = match.index + match[0].length;
      const openRe = new RegExp(`<${tag}[\\s>]`, 'gi');
      const closeRe = new RegExp(`</${tag}\\s*>`, 'gi');
      while (depth > 0 && pos < middleHtml.length) {
        openRe.lastIndex = pos; closeRe.lastIndex = pos;
        const nO = openRe.exec(middleHtml);
        const nC = closeRe.exec(middleHtml);
        if (!nC) break;
        if (nO && nO.index < nC.index) { depth++; pos = nO.index + nO[0].length; }
        else {
          depth--;
          if (depth === 0) {
            const blockEnd = nC.index + nC[0].length;
            const blockContent = middleHtml.slice(blockStart, blockEnd);
            const textContent = blockContent.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
            if (textContent.length >= 10) {
              blocks.push({ html: blockContent, attrs, tag, textLen: textContent.length, text: textContent });
              blockRegex.lastIndex = blockEnd;
            }
            break;
          }
          pos = nC.index + nC[0].length;
        }
      }
    }

    console.log(`[skeleton] Found ${blocks.length} top-level blocks`);

    // If a single block contains most of the text, drill into its children instead
    // This handles pages like Gold PC where DIV#content wraps all sections
    const totalText = blocks.reduce((sum, b) => sum + b.textLen, 0);
    const bigBlock = blocks.find(b => b.textLen > totalText * 0.7 && blocks.length <= 5);
    if (bigBlock) {
      console.log(`[skeleton] Block "${bigBlock.tag}" has ${bigBlock.textLen}/${totalText} chars — drilling into children`);
      const innerHtml = bigBlock.html;
      // Re-parse inside this block: find direct children (section, div, main, article)
      // Skip the outer tag itself by starting after the first >
      const innerStart = innerHtml.indexOf('>') + 1;
      const innerEnd = innerHtml.lastIndexOf('</');
      const innerContent = innerHtml.slice(innerStart, innerEnd > innerStart ? innerEnd : innerHtml.length);

      const innerBlocks = [];
      const innerRegex = /<(section|div|main|article)([^>]*)>/gi;
      let im;
      while ((im = innerRegex.exec(innerContent)) !== null) {
        const itag = im[1].toLowerCase();
        const iattrs = im[2];
        const iStart = im.index;
        let idepth = 1, ipos = im.index + im[0].length;
        const ioRe = new RegExp(`<${itag}[\\s>]`, 'gi');
        const icRe = new RegExp(`</${itag}\\s*>`, 'gi');
        while (idepth > 0 && ipos < innerContent.length) {
          ioRe.lastIndex = ipos; icRe.lastIndex = ipos;
          const inO = ioRe.exec(innerContent);
          const inC = icRe.exec(innerContent);
          if (!inC) break;
          if (inO && inO.index < inC.index) { idepth++; ipos = inO.index + inO[0].length; }
          else {
            idepth--;
            if (idepth === 0) {
              const iEnd = inC.index + inC[0].length;
              const iBlock = innerContent.slice(iStart, iEnd);
              const iText = iBlock.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
              if (iText.length >= 10) {
                innerBlocks.push({ html: iBlock, attrs: iattrs, tag: itag, textLen: iText.length, text: iText });
                innerRegex.lastIndex = iEnd;
              }
              break;
            }
            ipos = inC.index + inC[0].length;
          }
        }
      }

      if (innerBlocks.length > blocks.length) {
        // Also keep non-big blocks (like hero banner) that came before/after
        const heroBlocks = blocks.filter(b => b !== bigBlock);
        // Put hero blocks first, then inner blocks
        const heroBefore = heroBlocks.filter(b => blocks.indexOf(b) < blocks.indexOf(bigBlock));
        const heroAfter = heroBlocks.filter(b => blocks.indexOf(b) > blocks.indexOf(bigBlock));
        blocks.length = 0;
        blocks.push(...heroBefore, ...innerBlocks, ...heroAfter);
        console.log(`[skeleton] Drilled into ${innerBlocks.length} inner blocks (+ ${heroBlocks.length} outer blocks)`);
      }
    }

    console.log(`[skeleton] Final: ${blocks.length} content blocks`);

    // Helper: strip text from HTML but keep structure, images, links, headings
    function stripToSkeleton(blockHtml, sectionNum) {
      let skeleton = blockHtml;

      // Extract all images with their src and alt for preservation
      const imgSrcs = [];
      skeleton.replace(/<img[^>]*src=["']([^"']+)["'][^>]*>/gi, (m, src) => {
        const altMatch = m.match(/alt=["']([^"']*?)["']/i);
        imgSrcs.push({ src, alt: altMatch ? altMatch[1] : '' });
        return m;
      });

      // Classify block type
      const h1s = (skeleton.match(/<h1[^>]*>/gi) || []).length;
      const h2s = (skeleton.match(/<h2[^>]*>/gi) || []).length;
      const h3s = (skeleton.match(/<h3[^>]*>/gi) || []).length;
      const imgs = (skeleton.match(/<img[^>]*>/gi) || []).length;
      const lists = (skeleton.match(/<(ul|ol)[^>]*>/gi) || []).length;
      const forms = (skeleton.match(/<form[^>]*>/gi) || []).length;
      const hasBgImage = /background.*url|bg-img|ban-img|hero|banner/i.test(skeleton.slice(0, 500));
      const hasColumns = /col-\w+-\d|col-\d|column|wp-block-columns/i.test(skeleton);
      const text = skeleton.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      const wordCount = text.split(/\s+/).length;

      // Detect inner columns (child divs that are side-by-side)
      const innerDivs = skeleton.match(/<div[^>]*class="[^"]*col[^"]*"[^>]*>/gi) || [];
      const colCount = innerDivs.length || (hasColumns ? 2 : 1);

      // Determine section type
      let sectionType = 'content';
      if (hasBgImage && wordCount < 100) sectionType = 'hero-banner';
      else if (forms) sectionType = 'form-cta';
      else if (imgs > 0 && (hasColumns || colCount > 1)) sectionType = 'image-text-columns';
      else if (hasColumns && wordCount < 150) sectionType = 'multi-column-cta';
      else if (imgs > 2 && wordCount < 100) sectionType = 'image-gallery';
      else if (lists && wordCount > 50) sectionType = 'feature-list';
      else if (wordCount < 80 && (skeleton.match(/<a[^>]*>/gi) || []).length > 0) sectionType = 'cta-bar';
      else if (wordCount > 200) sectionType = 'long-content';
      else sectionType = 'short-content';

      // Extract heading text (keep original)
      const headings = [];
      skeleton.replace(/<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/gi, (m, level, attrs, inner) => {
        headings.push({ level, text: inner.replace(/<[^>]+>/g, '').trim() });
        return m;
      });

      // Build the skeleton HTML based on type
      let out = `<!-- SECTION ${sectionNum}: ${sectionType.toUpperCase()} -->\n`;

      if (sectionType === 'hero-banner') {
        out += `<div class="wf-hero">\n`;
        if (headings.length) out += `  <h${headings[0].level}>${headings[0].text}</h${headings[0].level}>\n`;
        else out += `  <h1>[HERO HEADING]</h1>\n`;
        out += `  <p>[~30 words hero subtext — brief intro or tagline]</p>\n`;
        if (imgs > 0) out += `  <img src="${imgSrcs[0]?.src || ''}" alt="${imgSrcs[0]?.alt || '[hero image]'}">\n`;
        out += `</div>\n`;
      } else if (sectionType === 'image-text-columns') {
        out += `<div class="wf-columns">\n`;
        // Determine if image is left or right by checking order in HTML
        const firstImgPos = skeleton.search(/<img/i);
        const firstTextPos = skeleton.search(/<(p|h[2-6])/i);
        const imgFirst = firstImgPos < firstTextPos;

        if (imgFirst) {
          out += `  <div class="wf-col">\n`;
          out += `    <img src="${imgSrcs[0]?.src || ''}" alt="${imgSrcs[0]?.alt || '[section image]'}">\n`;
          out += `  </div>\n`;
          out += `  <div class="wf-col">\n`;
          headings.forEach(h => { out += `    <h${h.level}>${h.text}</h${h.level}>\n`; });
          out += `    <p>[~${Math.max(60, Math.round(wordCount * 0.8))} words — describe this section's content]</p>\n`;
          out += `  </div>\n`;
        } else {
          out += `  <div class="wf-col">\n`;
          headings.forEach(h => { out += `    <h${h.level}>${h.text}</h${h.level}>\n`; });
          out += `    <p>[~${Math.max(60, Math.round(wordCount * 0.8))} words — describe this section's content]</p>\n`;
          out += `  </div>\n`;
          out += `  <div class="wf-col">\n`;
          out += `    <img src="${imgSrcs[0]?.src || ''}" alt="${imgSrcs[0]?.alt || '[section image]'}">\n`;
          out += `  </div>\n`;
        }
        out += `</div>\n`;
      } else if (sectionType === 'feature-list') {
        headings.forEach(h => { out += `<h${h.level}>${h.text}</h${h.level}>\n`; });
        // Count list items
        const liCount = (skeleton.match(/<li/gi) || []).length;
        out += `<ul>\n`;
        for (let i = 0; i < Math.max(3, liCount); i++) {
          out += `  <li>[Feature/benefit ${i + 1} — ~15 words]</li>\n`;
        }
        out += `</ul>\n`;
      } else if (sectionType === 'cta-bar') {
        out += `<div class="wf-cta">\n`;
        if (headings.length) out += `  <h${headings[0].level}>${headings[0].text}</h${headings[0].level}>\n`;
        out += `  <p>[~20 words CTA text]</p>\n`;
        out += `  <a href="#" class="wf-btn">[CTA Button Text]</a>\n`;
        out += `</div>\n`;
      } else if (sectionType === 'form-cta') {
        out += `<div class="wf-cta">\n`;
        headings.forEach(h => { out += `  <h${h.level}>${h.text}</h${h.level}>\n`; });
        out += `  <p>[~20 words — form intro text]</p>\n`;
        out += `  <p><em>[Contact form / enquiry form appears here — not editable]</em></p>\n`;
        out += `</div>\n`;
      } else if (sectionType === 'multi-column-cta') {
        // Multi-column CTA section (e.g. 3-column with images)
        const colMatches = skeleton.match(/col-\w+-(\d+)/gi) || [];
        const colSizes = colMatches.map(c => parseInt(c.match(/\d+$/)[0]));
        const numCols = colSizes.length || 3;
        out += `<div class="wf-columns">\n`;
        for (let ci = 0; ci < Math.min(numCols, 6); ci++) {
          out += `  <div class="wf-col">\n`;
          if (imgSrcs[ci]) out += `    <img src="${imgSrcs[ci].src}" alt="${imgSrcs[ci].alt || '[image]'}">\n`;
          if (headings[ci]) out += `    <h${headings[ci].level}>${headings[ci].text}</h${headings[ci].level}>\n`;
          out += `    <p>[~20 words — column ${ci + 1} content]</p>\n`;
          out += `  </div>\n`;
        }
        out += `</div>\n`;
      } else {
        // long-content or short-content — keep headings, replace body text
        headings.forEach(h => { out += `<h${h.level}>${h.text}</h${h.level}>\n`; });
        if (headings.length === 0 && h2s === 0) out += `<h2>[Section Heading]</h2>\n`;

        // Estimate paragraph count
        const pCount = Math.max(1, (skeleton.match(/<p[^>]*>/gi) || []).length);
        const wordsPerP = Math.max(40, Math.round(wordCount / pCount));
        for (let i = 0; i < pCount; i++) {
          out += `<p>[~${wordsPerP} words — paragraph ${i + 1} content]</p>\n`;
        }
        // Keep images in position
        imgSrcs.forEach(img => {
          out += `<img src="${img.src}" alt="${img.alt || '[image]'}">\n`;
        });
      }

      out += `<!-- /SECTION ${sectionNum} -->\n`;
      return out;
    }

    // Build the full skeleton
    let skeleton = '';
    blocks.forEach((block, i) => {
      skeleton += stripToSkeleton(block.html, i + 1) + '\n';
    });

    // Build wireframe description for AI context
    const sectionSummary = (skeleton.match(/<!-- SECTION \d+: .+-->/g) || []).join('\n');

    console.log(`[skeleton] Built skeleton: ${skeleton.length} chars, ${blocks.length} sections`);

    // Save as draft content + wireframe description
    await pool.query(
      'UPDATE content_queue SET draft_content=$1, page_wireframe=$2 WHERE id=$3',
      [skeleton, `PAGE SKELETON (${blocks.length} sections from live HTML):\n${sectionSummary}`, id]
    );

    res.json({ skeleton, sections: blocks.length });
  } catch (e) {
    console.error('[skeleton] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===== PAGE TEMPLATES =====

// List templates for a project
app.get('/api/projects/:projectId/templates', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, page_type, source_url, section_count, is_default, created_at, updated_at FROM page_templates WHERE project_id=$1 ORDER BY page_type, name',
      [req.params.projectId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get single template (with full HTML)
app.get('/api/projects/:projectId/templates/:id', async (req, res) => {
  try {
    const row = (await pool.query('SELECT * FROM page_templates WHERE id=$1 AND project_id=$2', [req.params.id, req.params.projectId])).rows[0];
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create template manually
app.post('/api/projects/:projectId/templates', async (req, res) => {
  const { name, page_type, skeleton_html, source_url } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  try {
    const html = skeleton_html || '';
    const sections = (html.match(/<!-- SECTION/gi) || []).length;
    const { rows } = await pool.query(
      'INSERT INTO page_templates (project_id, name, page_type, skeleton_html, source_url, section_count) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [req.params.projectId, name, page_type || 'service', html, source_url || null, sections]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update template
app.put('/api/projects/:projectId/templates/:id', async (req, res) => {
  const { name, page_type, skeleton_html, source_url } = req.body;
  try {
    const sets = []; const vals = []; let n = 1;
    if (name !== undefined) { sets.push(`name=$${n++}`); vals.push(name); }
    if (page_type !== undefined) { sets.push(`page_type=$${n++}`); vals.push(page_type); }
    if (skeleton_html !== undefined) {
      sets.push(`skeleton_html=$${n++}`); vals.push(skeleton_html);
      sets.push(`section_count=$${n++}`); vals.push((skeleton_html.match(/<!-- SECTION/gi) || []).length);
    }
    if (source_url !== undefined) { sets.push(`source_url=$${n++}`); vals.push(source_url); }
    sets.push(`updated_at=NOW()`);
    vals.push(req.params.id, req.params.projectId);
    const row = (await pool.query(
      `UPDATE page_templates SET ${sets.join(',')} WHERE id=$${n++} AND project_id=$${n++} RETURNING *`, vals
    )).rows[0];
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete template
app.delete('/api/projects/:projectId/templates/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM page_templates WHERE id=$1 AND project_id=$2', [req.params.id, req.params.projectId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Import template from URL — fetches page, strips to skeleton, saves as template
app.post('/api/projects/:projectId/templates/import', async (req, res) => {
  req.setTimeout(60000);
  res.setTimeout(60000);
  const { url, name, page_type } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  try {
    const pageUrl = url.startsWith('http') ? url : 'https://' + url;
    console.log(`[templates] Importing from: ${pageUrl}`);
    const resp = await fetch(pageUrl, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
    });
    if (!resp.ok) return res.status(502).json({ error: `Failed to fetch: ${resp.status}` });
    const html = await resp.text();

    // Extract content between </header> and <footer>
    const headerEnd = html.search(/<\/header>/i);
    const footerStart = html.search(/<footer/i);
    const middleHtml = html.slice(
      headerEnd !== -1 ? headerEnd + '</header>'.length : 0,
      footerStart !== -1 ? footerStart : html.length
    );

    // Parse top-level blocks
    function parseBlocks(sourceHtml) {
      const blockRegex = /<(section|div|main|article)([^>]*)>/gi;
      const results = [];
      let match;
      while ((match = blockRegex.exec(sourceHtml)) !== null) {
        const tag = match[1].toLowerCase();
        const attrs = match[2];
        const blockStart = match.index;
        let depth = 1, pos = match.index + match[0].length;
        const openRe = new RegExp(`<${tag}[\\s>]`, 'gi');
        const closeRe = new RegExp(`</${tag}\\s*>`, 'gi');
        while (depth > 0 && pos < sourceHtml.length) {
          openRe.lastIndex = pos; closeRe.lastIndex = pos;
          const nO = openRe.exec(sourceHtml);
          const nC = closeRe.exec(sourceHtml);
          if (!nC) break;
          if (nO && nO.index < nC.index) { depth++; pos = nO.index + nO[0].length; }
          else {
            depth--;
            if (depth === 0) {
              const blockEnd = nC.index + nC[0].length;
              const blockContent = sourceHtml.slice(blockStart, blockEnd);
              const textContent = blockContent.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
              if (textContent.length >= 10) {
                results.push({ html: blockContent, attrs, tag, textLen: textContent.length, text: textContent });
                blockRegex.lastIndex = blockEnd;
              }
              break;
            }
            pos = nC.index + nC[0].length;
          }
        }
      }
      return results;
    }

    let blocks = parseBlocks(middleHtml);

    // Drill into wrapper divs if one block has >70% of text
    const totalText = blocks.reduce((sum, b) => sum + b.textLen, 0);
    const bigBlock = blocks.find(b => b.textLen > totalText * 0.7 && blocks.length <= 5);
    if (bigBlock) {
      const innerStart = bigBlock.html.indexOf('>') + 1;
      const innerEnd = bigBlock.html.lastIndexOf('</');
      const innerContent = bigBlock.html.slice(innerStart, innerEnd > innerStart ? innerEnd : bigBlock.html.length);
      const innerBlocks = parseBlocks(innerContent);
      if (innerBlocks.length > blocks.length) {
        const heroBefore = blocks.filter(b => b !== bigBlock && blocks.indexOf(b) < blocks.indexOf(bigBlock));
        const heroAfter = blocks.filter(b => b !== bigBlock && blocks.indexOf(b) > blocks.indexOf(bigBlock));
        blocks = [...heroBefore, ...innerBlocks, ...heroAfter];
      }
    }

    // Strip each block to skeleton
    function stripBlock(blockHtml, sectionNum) {
      const imgSrcs = [];
      blockHtml.replace(/<img[^>]*src=["']([^"']+)["'][^>]*>/gi, (m, src) => {
        const altMatch = m.match(/alt=["']([^"']*?)["']/i);
        imgSrcs.push({ src, alt: altMatch ? altMatch[1] : '' });
        return m;
      });

      const h2s = (blockHtml.match(/<h2[^>]*>/gi) || []).length;
      const imgs = (blockHtml.match(/<img[^>]*>/gi) || []).length;
      const lists = (blockHtml.match(/<(ul|ol)[^>]*>/gi) || []).length;
      const forms = (blockHtml.match(/<form[^>]*>/gi) || []).length;
      const hasBgImage = /background.*url|bg-img|ban-img|hero|banner/i.test(blockHtml.slice(0, 500));
      const hasColumns = /col-\w+-\d|col-\d|column|wp-block-columns/i.test(blockHtml);
      const text = blockHtml.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      const wordCount = text.split(/\s+/).length;

      const headings = [];
      blockHtml.replace(/<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/gi, (m, level, attrs, inner) => {
        headings.push({ level, text: inner.replace(/<[^>]+>/g, '').trim() });
        return m;
      });

      let sectionType = 'content';
      if (hasBgImage && wordCount < 100) sectionType = 'hero-banner';
      else if (forms) sectionType = 'form-cta';
      else if (imgs > 0 && hasColumns) sectionType = 'image-text-columns';
      else if (hasColumns && wordCount < 150) sectionType = 'multi-column-cta';
      else if (imgs > 2 && wordCount < 100) sectionType = 'image-gallery';
      else if (lists && wordCount > 50) sectionType = 'feature-list';
      else if (wordCount < 80 && (blockHtml.match(/<a[^>]*>/gi) || []).length > 0) sectionType = 'cta-bar';
      else if (wordCount > 200) sectionType = 'long-content';
      else sectionType = 'short-content';

      let out = `<!-- SECTION ${sectionNum}: ${sectionType.toUpperCase()} -->\n`;

      if (sectionType === 'hero-banner') {
        out += `<div class="wf-hero">\n`;
        out += headings.length ? `  <h${headings[0].level}>[HERO HEADING — page title with keyword]</h${headings[0].level}>\n` : `  <h1>[HERO HEADING]</h1>\n`;
        out += `  <p>[~30 words hero subtext — brief intro or tagline]</p>\n`;
        if (imgs > 0) out += `  <img src="" alt="[hero image alt text]">\n`;
        out += `</div>\n`;
      } else if (sectionType === 'image-text-columns') {
        const firstImgPos = blockHtml.search(/<img/i);
        const firstTextPos = blockHtml.search(/<(p|h[2-6])/i);
        const imgFirst = firstImgPos < firstTextPos;
        out += `<div class="wf-columns">\n`;
        if (imgFirst) {
          out += `  <div class="wf-col"><img src="" alt="[section image]"></div>\n`;
          out += `  <div class="wf-col">\n`;
          out += `    <h2>[Section Heading]</h2>\n`;
          out += `    <p>[~${Math.max(60, Math.round(wordCount * 0.8))} words — section content]</p>\n`;
          out += `  </div>\n`;
        } else {
          out += `  <div class="wf-col">\n`;
          out += `    <h2>[Section Heading]</h2>\n`;
          out += `    <p>[~${Math.max(60, Math.round(wordCount * 0.8))} words — section content]</p>\n`;
          out += `  </div>\n`;
          out += `  <div class="wf-col"><img src="" alt="[section image]"></div>\n`;
        }
        out += `</div>\n`;
      } else if (sectionType === 'multi-column-cta') {
        const colMatches = blockHtml.match(/col-\w+-(\d+)/gi) || [];
        const numCols = Math.max(2, Math.min(colMatches.length, 6));
        out += `<div class="wf-columns">\n`;
        for (let ci = 0; ci < numCols; ci++) {
          out += `  <div class="wf-col">\n`;
          if (imgs > ci) out += `    <img src="" alt="[column ${ci + 1} image]">\n`;
          out += `    <p>[~20 words — column ${ci + 1} content]</p>\n`;
          out += `  </div>\n`;
        }
        out += `</div>\n`;
      } else if (sectionType === 'feature-list') {
        out += `<h2>[Features/Benefits Heading]</h2>\n`;
        const liCount = Math.max(3, (blockHtml.match(/<li/gi) || []).length);
        out += `<ul>\n`;
        for (let i = 0; i < liCount; i++) out += `  <li>[Feature/benefit ${i + 1} — ~15 words]</li>\n`;
        out += `</ul>\n`;
      } else if (sectionType === 'form-cta') {
        out += `<div class="wf-cta">\n`;
        out += `  <h2>[Form Heading — e.g. "Get a Free Quote"]</h2>\n`;
        out += `  <p>[~20 words — form intro]</p>\n`;
        out += `  <p><em>[Contact form appears here — not editable]</em></p>\n`;
        out += `</div>\n`;
      } else if (sectionType === 'cta-bar') {
        out += `<div class="wf-cta">\n`;
        if (headings.length) out += `  <h2>[CTA Heading]</h2>\n`;
        out += `  <p>[~20 words CTA text]</p>\n`;
        out += `  <a href="#" class="wf-btn">[CTA Button Text]</a>\n`;
        out += `</div>\n`;
      } else {
        // Long or short content
        const pCount = Math.max(1, (blockHtml.match(/<p[^>]*>/gi) || []).length);
        const wordsPerP = Math.max(40, Math.round(wordCount / pCount));
        // Use generic heading placeholders instead of original text
        const hCount = Math.max(1, headings.length);
        for (let hi = 0; hi < hCount; hi++) {
          out += `<h2>[Section ${sectionNum} Heading ${hi > 0 ? hi + 1 : ''}]</h2>\n`;
          const parasForH = Math.max(1, Math.ceil(pCount / hCount));
          for (let pi = 0; pi < parasForH; pi++) {
            out += `<p>[~${wordsPerP} words — paragraph content]</p>\n`;
          }
        }
        if (imgs > 0) out += `<img src="" alt="[relevant image]">\n`;
      }

      out += `<!-- /SECTION ${sectionNum} -->\n`;
      return out;
    }

    let skeleton = '';
    blocks.forEach((block, i) => { skeleton += stripBlock(block.html, i + 1) + '\n'; });

    const templateName = name || (page_type ? page_type.charAt(0).toUpperCase() + page_type.slice(1) + ' Page' : 'Imported Template');
    const sectionCount = (skeleton.match(/<!-- SECTION/gi) || []).length;

    const { rows } = await pool.query(
      'INSERT INTO page_templates (project_id, name, page_type, skeleton_html, source_url, section_count) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [req.params.projectId, templateName, page_type || 'service', skeleton, pageUrl, sectionCount]
    );

    console.log(`[templates] Imported "${templateName}" from ${pageUrl}: ${sectionCount} sections, ${skeleton.length} chars`);
    res.json(rows[0]);
  } catch (e) {
    console.error('[templates] Import error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Apply template to a content queue item
app.post('/api/projects/:projectId/content-queue/:id/apply-template', async (req, res) => {
  const { template_id } = req.body;
  if (!template_id) return res.status(400).json({ error: 'template_id required' });
  try {
    const template = (await pool.query('SELECT * FROM page_templates WHERE id=$1 AND project_id=$2', [template_id, req.params.projectId])).rows[0];
    if (!template) return res.status(404).json({ error: 'Template not found' });

    await pool.query(
      'UPDATE content_queue SET draft_content=$1, page_wireframe=$2, updated_at=NOW() WHERE id=$3 AND project_id=$4',
      [template.skeleton_html, `Template: ${template.name} (${template.section_count} sections)`, req.params.id, req.params.projectId]
    );

    res.json({ ok: true, skeleton: template.skeleton_html, sections: template.section_count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Apply template to a site_page item
app.post('/api/projects/:projectId/site-pages/:id/apply-template', async (req, res) => {
  const { template_id } = req.body;
  if (!template_id) return res.status(400).json({ error: 'template_id required' });
  try {
    const template = (await pool.query('SELECT * FROM page_templates WHERE id=$1 AND project_id=$2', [template_id, req.params.projectId])).rows[0];
    if (!template) return res.status(404).json({ error: 'Template not found' });

    const updated = await pool.query(
      'UPDATE site_pages SET draft_content=$1, updated_at=NOW() WHERE id=$2 AND project_id=$3 RETURNING *',
      [template.skeleton_html, req.params.id, req.params.projectId]
    );

    res.json({ ok: true, skeleton: template.skeleton_html, sections: template.section_count, page: updated.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Analyze page wireframe — fetches live page, extracts section structure for AI copywriting
app.post('/api/projects/:projectId/analyze-wireframe', async (req, res) => {
  req.setTimeout(30000);
  res.setTimeout(30000);
  const { projectId } = req.params;
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  try {
    const pageUrl = url.startsWith('http') ? url : 'https://' + url;
    console.log(`[wireframe] Analyzing page structure: ${pageUrl}`);
    const resp = await fetch(pageUrl, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
    });
    if (!resp.ok) return res.status(502).json({ error: `Failed to fetch: ${resp.status}` });
    const html = await resp.text();

    // Parse the page into sections
    // Find all top-level sections/divs between header and footer
    const headerEnd = html.search(/<\/header>/i);
    const footerStart = html.search(/<footer/i);
    const middleHtml = html.slice(
      headerEnd !== -1 ? headerEnd + '</header>'.length : 0,
      footerStart !== -1 ? footerStart : html.length
    );

    // Extract sections with their content details
    const sections = [];
    const sectionRegex = /<(section|div)([^>]*)>/gi;
    let match;
    while ((match = sectionRegex.exec(middleHtml)) !== null) {
      const tag = match[1];
      const attrs = match[2];
      const blockStart = match.index;
      // Quick depth scan
      let depth = 1, pos = match.index + match[0].length;
      const oRe = new RegExp(`<${tag}[\\s>]`, 'gi');
      const cRe = new RegExp(`</${tag}\\s*>`, 'gi');
      while (depth > 0 && pos < middleHtml.length) {
        oRe.lastIndex = pos; cRe.lastIndex = pos;
        const nO = oRe.exec(middleHtml);
        const nC = cRe.exec(middleHtml);
        if (!nC) break;
        if (nO && nO.index < nC.index) { depth++; pos = nO.index + nO[0].length; }
        else { depth--; if (depth === 0) {
          const blockEnd = nC.index + nC[0].length;
          const blockHtml = middleHtml.slice(blockStart, blockEnd);
          const text = blockHtml.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
          if (text.length < 10) { sectionRegex.lastIndex = blockEnd; break; } // skip empty

          // Analyze section content
          const h1s = (blockHtml.match(/<h1[^>]*>/gi) || []).length;
          const h2s = (blockHtml.match(/<h2[^>]*>/gi) || []).length;
          const h3s = (blockHtml.match(/<h3[^>]*>/gi) || []).length;
          const imgs = (blockHtml.match(/<img[^>]*>/gi) || []).length;
          const links = (blockHtml.match(/<a[^>]*>/gi) || []).length;
          const lists = (blockHtml.match(/<(ul|ol)[^>]*>/gi) || []).length;
          const forms = (blockHtml.match(/<form[^>]*>/gi) || []).length;
          const buttons = (blockHtml.match(/<button[^>]*>/gi) || []).length + (blockHtml.match(/class="[^"]*btn[^"]*"/gi) || []).length;

          // Detect layout type
          const hasColumns = /col-|column|grid|flex|row/i.test(attrs + blockHtml.slice(0, 500));
          const hasBgImage = /background.*url|bg-img|ban-img/i.test(blockHtml.slice(0, 500));
          const headings = [];
          const hMatches = blockHtml.matchAll(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi);
          for (const hm of hMatches) headings.push(hm[2].replace(/<[^>]+>/g, '').trim().slice(0, 80));

          // Classify section type
          let sectionType = 'content';
          if (hasBgImage && (h1s || h2s) && text.length < 300) sectionType = 'hero-banner';
          else if (forms) sectionType = 'form/cta';
          else if (imgs > 0 && hasColumns) sectionType = 'image-text-columns';
          else if (imgs > 1 && text.length < 200) sectionType = 'image-gallery';
          else if (lists && text.length > 200) sectionType = 'feature-list';
          else if (buttons > 1 || (text.length < 150 && links > 2)) sectionType = 'cta-bar';
          else if (text.length > 500) sectionType = 'long-content';
          else if (text.length < 150) sectionType = 'short-content';

          const cls = (attrs.match(/class="([^"]*)"/i) || [])[1] || '';
          sections.push({
            type: sectionType,
            className: cls.split(' ').filter(c => c && !c.match(/^(col|row|d-|p-|m-|w-)/)).slice(0, 3).join(' '),
            headings,
            wordCount: text.split(/\s+/).length,
            images: imgs,
            links,
            lists,
            hasColumns,
            textPreview: text.slice(0, 120)
          });
          sectionRegex.lastIndex = blockEnd;
          break;
        }
        pos = nC.index + nC[0].length; }
      }
    }

    // Build a human-readable wireframe description
    const wireframeLines = sections.map((s, i) => {
      let desc = `SECTION ${i + 1}: ${s.type.toUpperCase()}`;
      if (s.headings.length) desc += `\n  Headings: ${s.headings.map(h => `"${h}"`).join(', ')}`;
      desc += `\n  Layout: ${s.hasColumns ? 'Multi-column' : 'Full-width'}`;
      if (s.images) desc += ` | ${s.images} image(s)`;
      if (s.links) desc += ` | ${s.links} link(s)`;
      if (s.lists) desc += ` | ${s.lists} list(s)`;
      desc += `\n  Content: ~${s.wordCount} words`;
      desc += `\n  Preview: "${s.textPreview}"`;
      return desc;
    });

    const wireframeText = `PAGE WIREFRAME STRUCTURE (${sections.length} sections):\n\n` + wireframeLines.join('\n\n');
    console.log(`[wireframe] Analyzed ${pageUrl}: ${sections.length} sections found`);
    res.json({ wireframe: wireframeText, sections });
  } catch (e) {
    console.error('[wireframe] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Full-page screenshot capture — uses Google PageSpeed API (returns screenshot in response)
app.post('/api/projects/:projectId/screenshot', async (req, res) => {
  req.setTimeout(90000);
  res.setTimeout(90000);
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  try {
    const apiKey = process.env.PAGESPEED_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'PageSpeed API key not configured' });
    const psiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&category=PERFORMANCE&strategy=MOBILE&key=${apiKey}`;
    console.log(`[screenshot] Capturing via PageSpeed API: ${url}`);
    const resp = await fetch(psiUrl, { signal: AbortSignal.timeout(75000) });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.error(`[screenshot] PageSpeed API error ${resp.status}:`, errText);
      return res.status(500).json({ error: `PageSpeed API failed: ${resp.status}` });
    }
    const data = await resp.json();
    // Extract final screenshot from Lighthouse audits
    const screenshot = data?.lighthouseResult?.audits?.['final-screenshot']?.details?.data;
    if (!screenshot) {
      // Try full-page-screenshot audit
      const fullPage = data?.lighthouseResult?.audits?.['full-page-screenshot']?.details?.screenshot?.data;
      if (!fullPage) return res.status(500).json({ error: 'No screenshot in PageSpeed response' });
      const base64 = fullPage.replace(/^data:[^;]+;base64,/, '');
      console.log(`[screenshot] Captured full-page ${url}: ${Math.round(base64.length * 0.75 / 1024)}KB`);
      return res.json({ image: base64, mime: 'image/jpeg' });
    }
    const base64 = screenshot.replace(/^data:[^;]+;base64,/, '');
    console.log(`[screenshot] Captured ${url}: ${Math.round(base64.length * 0.75 / 1024)}KB`);
    res.json({ image: base64, mime: 'image/jpeg' });
  } catch (e) {
    console.error('[screenshot] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==================== CONTENT KEYWORDS ====================

// List all keywords for a project
app.get('/api/projects/:projectId/content-keywords', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM content_keywords WHERE project_id=$1 ORDER BY page_type, keyword', [req.params.projectId]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Bulk add keywords (from CSV, paste, or manual)
app.post('/api/projects/:projectId/content-keywords/bulk', async (req, res) => {
  try {
    const { keywords, search_volumes } = req.body; // keywords: array of string or { keyword, page_type?, page_name? }, search_volumes: { keyword: volume } optional
    if (!Array.isArray(keywords) || keywords.length === 0) return res.status(400).json({ error: 'No keywords provided' });
    const projectId = req.params.projectId;
    const volMap = search_volumes || {};
    const added = [];
    for (const kw of keywords) {
      const keyword = (kw.keyword || kw).toString().trim();
      if (!keyword) continue;
      // Skip duplicates
      const exists = await pool.query('SELECT id FROM content_keywords WHERE project_id=$1 AND LOWER(keyword)=LOWER($2)', [projectId, keyword]);
      if (exists.rows.length > 0) continue;
      const vol = volMap[keyword] || volMap[keyword.toLowerCase()] || (kw.search_volume != null ? kw.search_volume : null);
      const r = await pool.query(
        `INSERT INTO content_keywords (project_id, keyword, page_type, page_name, search_volume) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [projectId, keyword, kw.page_type || 'unassigned', kw.page_name || null, vol]
      );
      added.push(r.rows[0]);
    }
    res.json({ success: true, added: added.length, keywords: added });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Bulk update keywords (assign multiple to a page type) — MUST be before :id route
app.put('/api/projects/:projectId/content-keywords/bulk-assign', async (req, res) => {
  try {
    const { keyword_ids, page_type, page_name } = req.body;
    if (!Array.isArray(keyword_ids) || keyword_ids.length === 0) return res.status(400).json({ error: 'No keyword IDs' });
    await pool.query(
      `UPDATE content_keywords SET page_type=$1, page_name=$2 WHERE id = ANY($3) AND project_id=$4`,
      [page_type, page_name || null, keyword_ids, req.params.projectId]
    );
    res.json({ success: true, updated: keyword_ids.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update keyword (assign to page type, rename, etc.)
app.put('/api/projects/:projectId/content-keywords/:id', async (req, res) => {
  try {
    const { keyword, page_type, page_name, search_volume } = req.body;
    const fields = []; const vals = []; let idx = 1;
    if (keyword !== undefined) { fields.push(`keyword=$${idx++}`); vals.push(keyword); }
    if (page_type !== undefined) { fields.push(`page_type=$${idx++}`); vals.push(page_type); }
    if (page_name !== undefined) { fields.push(`page_name=$${idx++}`); vals.push(page_name); }
    if (search_volume !== undefined) { fields.push(`search_volume=$${idx++}`); vals.push(search_volume); }
    if (fields.length === 0) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(req.params.id, req.params.projectId);
    const r = await pool.query(`UPDATE content_keywords SET ${fields.join(',')} WHERE id=$${idx++} AND project_id=$${idx} RETURNING *`, vals);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Keyword not found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete keyword
app.delete('/api/projects/:projectId/content-keywords/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM content_keywords WHERE id=$1 AND project_id=$2', [req.params.id, req.params.projectId]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Bulk delete keywords
app.post('/api/projects/:projectId/content-keywords/bulk-delete', async (req, res) => {
  try {
    const { keyword_ids } = req.body;
    if (!Array.isArray(keyword_ids) || keyword_ids.length === 0) return res.status(400).json({ error: 'No keyword IDs' });
    await pool.query('DELETE FROM content_keywords WHERE id = ANY($1) AND project_id=$2', [keyword_ids, req.params.projectId]);
    res.json({ success: true, deleted: keyword_ids.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== KEYWORD RESEARCH (DataForSEO + SerpAPI) ====================

// Australian location codes for DataForSEO (Google Ads location IDs)
const AU_LOCATIONS = {
  country: { name: 'Australia', code: 2036 },
  states: {
    'New South Wales': { code: 20532, cities: { 'Sydney': 1003854, 'Newcastle': 1003821, 'Wollongong': 1003871, 'Central Coast': 9069149, 'Coffs Harbour': 1003799, 'Wagga Wagga': 1003865, 'Albury': 1003783, 'Tamworth': 1003860, 'Orange': 1003825, 'Dubbo': 1003803, 'Bathurst': 1003788, 'Lismore': 1003817, 'Port Macquarie': 1003833 } },
    'Victoria': { code: 20533, cities: { 'Melbourne': 1003819, 'Geelong': 1003806, 'Ballarat': 1003787, 'Bendigo': 1003789, 'Shepparton': 1003847, 'Mildura': 1003820, 'Warrnambool': 1003867, 'Wodonga': 1003870, 'Traralgon': 1003862 } },
    'Queensland': { code: 20534, cities: { 'Brisbane': 1003793, 'Gold Coast': 1003808, 'Sunshine Coast': 1003857, 'Townsville': 1003861, 'Cairns': 1003795, 'Toowoomba': 1003858, 'Mackay': 1003818, 'Rockhampton': 1003841, 'Bundaberg': 1003794, 'Hervey Bay': 1003811, 'Gladstone': 1003807 } },
    'Western Australia': { code: 20535, cities: { 'Perth': 1003829, 'Mandurah': 9069155, 'Bunbury': 1003792, 'Geraldton': 1003805, 'Kalgoorlie': 1003813, 'Albany': 1003782, 'Broome': 1003791, 'Karratha': 1003814 } },
    'South Australia': { code: 20536, cities: { 'Adelaide': 1003781, 'Mount Gambier': 1003822, 'Whyalla': 1003869, 'Murray Bridge': 1003823, 'Port Augusta': 1003831, 'Port Lincoln': 1003832 } },
    'Tasmania': { code: 20537, cities: { 'Hobart': 1003812, 'Launceston': 1003816, 'Devonport': 1003801, 'Burnie': 1003796 } },
    'Northern Territory': { code: 20538, cities: { 'Darwin': 1003800, 'Alice Springs': 1003784 } },
    'Australian Capital Territory': { code: 20539, cities: { 'Canberra': 1003797 } },
  }
};

// City/state populations for local volume estimation (ABS 2024 estimates)
const AU_POPULATION = 26500000;
const AU_CITY_POP = {
  'Sydney': 5450000, 'Melbourne': 5150000, 'Brisbane': 2600000, 'Perth': 2200000,
  'Adelaide': 1420000, 'Gold Coast': 720000, 'Newcastle': 510000, 'Canberra': 470000,
  'Sunshine Coast': 370000, 'Wollongong': 310000, 'Geelong': 270000, 'Hobart': 250000,
  'Townsville': 195000, 'Cairns': 160000, 'Toowoomba': 170000, 'Darwin': 150000,
  'Ballarat': 115000, 'Bendigo': 100000, 'Launceston': 90000, 'Mackay': 85000,
  'Rockhampton': 80000, 'Bunbury': 75000, 'Bundaberg': 75000, 'Hervey Bay': 70000,
  'Wagga Wagga': 65000, 'Coffs Harbour': 55000, 'Shepparton': 55000, 'Mildura': 55000,
  'Gladstone': 45000, 'Tamworth': 45000, 'Albury': 55000, 'Orange': 42000,
  'Dubbo': 40000, 'Bathurst': 40000, 'Lismore': 30000, 'Port Macquarie': 50000,
  'Central Coast': 340000, 'Mandurah': 100000, 'Geraldton': 40000, 'Kalgoorlie': 32000,
  'Albany': 38000, 'Broome': 16000, 'Karratha': 22000, 'Mount Gambier': 30000,
  'Whyalla': 21000, 'Murray Bridge': 22000, 'Port Augusta': 14000, 'Port Lincoln': 15000,
  'Devonport': 30000, 'Burnie': 20000, 'Alice Springs': 25000, 'Warrnambool': 35000,
  'Wodonga': 42000, 'Traralgon': 28000,
};
const AU_STATE_POP = {
  'New South Wales': 8350000, 'Victoria': 6750000, 'Queensland': 5450000,
  'Western Australia': 2900000, 'South Australia': 1850000, 'Tasmania': 570000,
  'Northern Territory': 250000, 'Australian Capital Territory': 470000,
};

app.post('/api/projects/:projectId/keyword-research', async (req, res) => {
  const { projectId } = req.params;
  const { seeds, country, state, city, is_local, package_size, exclude_keywords, min_volume } = req.body;
  // seeds: string[] of seed keywords
  // country: 'Australia' (future: others)
  // state: e.g. 'Western Australia'
  // city: e.g. 'Perth'
  // is_local: boolean — if true, append city/state to keywords
  // package_size: 10|20|30|40|50
  // exclude_keywords: string[] — keywords to exclude (for "Fetch More")
  // min_volume: number — minimum search volume filter

  if (!Array.isArray(seeds) || seeds.length === 0) return res.status(400).json({ error: 'Provide at least one seed keyword' });
  if (!DATAFORSEO_AUTH) return res.status(400).json({ error: 'DataForSEO not configured. Add DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD.' });

  const cap = package_size || 20;
  const locationCity = city || null;
  const locationState = state || null;

  // Use the most specific location code available: city > state > country
  let locationCode = AU_LOCATIONS.country.code; // 2036 = Australia
  let locationName = 'Australia';
  if (locationCity && locationState && AU_LOCATIONS.states[locationState]?.cities?.[locationCity]) {
    locationCode = AU_LOCATIONS.states[locationState].cities[locationCity];
    locationName = locationCity + ', ' + locationState + ', Australia';
  } else if (locationState && AU_LOCATIONS.states[locationState]) {
    locationCode = AU_LOCATIONS.states[locationState].code;
    locationName = locationState + ', Australia';
  }

  console.log(`[kw-research] Seeds: ${seeds.join(', ')} | Location: ${locationName} (code: ${locationCode}) | Cap: ${cap}`);

  try {
    // Step 1: Expand seeds with SerpAPI autocomplete
    let expandedSeeds = [...seeds];
    if (SERPAPI_KEY) {
      for (const seed of seeds.slice(0, 5)) { // cap seed expansion to 5 seeds
        try {
          const acUrl = `https://serpapi.com/search.json?engine=google_autocomplete&q=${encodeURIComponent(seed)}&gl=au&api_key=${SERPAPI_KEY}`;
          const acResp = await fetch(acUrl, { signal: AbortSignal.timeout(8000) });
          if (acResp.ok) {
            const acData = await acResp.json();
            const suggestions = (acData.suggestions || []).map(s => s.value).filter(Boolean);
            expandedSeeds.push(...suggestions.slice(0, 5));
          }
        } catch (e) { console.log(`[kw-research] Autocomplete error for "${seed}": ${e.message}`); }
      }
    }

    // No need to append city/state to keywords — DataForSEO location_code handles geo-targeting

    // Deduplicate
    expandedSeeds = [...new Set(expandedSeeds.map(s => s.trim().toLowerCase()))].filter(Boolean);
    console.log(`[kw-research] Expanded to ${expandedSeeds.length} seed keywords`);

    // Step 2: DataForSEO Labs — keyword suggestions (clickstream-adjusted, like Ahrefs)
    let allKeywords = [];
    for (const seed of expandedSeeds.slice(0, 10)) { // Labs takes one seed at a time
      try {
        const dfsResp = await fetch('https://api.dataforseo.com/v3/dataforseo_labs/google/keyword_suggestions/live', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': DATAFORSEO_AUTH },
          body: JSON.stringify([{
            keyword: seed,
            location_code: locationCode,
            language_name: 'English',
            limit: Math.min(cap * 2, 100),
            include_seed_keyword: true,
            include_serp_info: false,
          }]),
          signal: AbortSignal.timeout(20000),
        });
        if (dfsResp.ok) {
          const dfsData = await dfsResp.json();
          const items = dfsData?.tasks?.[0]?.result?.[0]?.items || [];
          for (const item of items) {
            const kd = item.keyword_data || item;
            const ki = kd.keyword_info || {};
            if (kd.keyword && ki.search_volume != null) {
              allKeywords.push({
                keyword: kd.keyword,
                volume: ki.search_volume || 0,
                competition: ki.competition != null ? (ki.competition > 0.66 ? 'HIGH' : ki.competition > 0.33 ? 'MEDIUM' : 'LOW') : null,
                competition_index: ki.competition != null ? Math.round(ki.competition * 100) : null,
                cpc: ki.cpc || null,
                intent: ki.keyword_properties?.keyword_intent || null,
                difficulty: kd.keyword_properties?.keyword_difficulty || null,
              });
            }
          }
        } else {
          const errText = await dfsResp.text();
          console.log(`[kw-research] DFS Labs error: ${dfsResp.status} ${errText.substring(0, 300)}`);
        }
      } catch (e) { console.log(`[kw-research] DFS Labs error for "${seed}": ${e.message}`); }
    }

    // Fallback: if Labs returned nothing, try Google Ads search_volume on the seeds
    if (allKeywords.length === 0) {
      console.log(`[kw-research] Labs returned nothing, falling back to google_ads search_volume`);
      try {
        const dfsResp = await fetch('https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': DATAFORSEO_AUTH },
          body: JSON.stringify([{
            keywords: expandedSeeds.slice(0, 100),
            location_code: locationCode,
            language_name: 'English',
          }]),
          signal: AbortSignal.timeout(20000),
        });
        if (dfsResp.ok) {
          const dfsData = await dfsResp.json();
          const results = dfsData?.tasks?.[0]?.result || [];
          for (const r of results) {
            if (r.keyword && r.search_volume != null) {
              allKeywords.push({
                keyword: r.keyword,
                volume: r.search_volume || 0,
                competition: r.competition || null,
                competition_index: r.competition_index != null ? r.competition_index : null,
                cpc: r.cpc || null,
                intent: null,
              });
            }
          }
        }
      } catch (e) { console.log(`[kw-research] search_volume fallback error: ${e.message}`); }
    }

    // Deduplicate by keyword (keep highest volume)
    const kwMap = {};
    for (const kw of allKeywords) {
      const key = kw.keyword.toLowerCase();
      if (!kwMap[key] || (kw.volume || 0) > (kwMap[key].volume || 0)) {
        kwMap[key] = kw;
      }
    }
    let final = Object.values(kwMap);

    // Collapse Google Ads "near me" clusters — when multiple keywords share the exact same
    // volume AND are "near me" variants, keep only the shortest (most generic) one.
    // Google Ads groups these into one cluster with identical volumes.
    const volumeGroups = {};
    for (const kw of final) {
      const v = kw.volume || 0;
      if (!volumeGroups[v]) volumeGroups[v] = [];
      volumeGroups[v].push(kw);
    }
    const collapsed = [];
    for (const [vol, group] of Object.entries(volumeGroups)) {
      if (group.length > 3) {
        // Likely a Google Ads cluster — keep the 2 shortest (most generic) keywords
        group.sort((a, b) => a.keyword.length - b.keyword.length);
        collapsed.push(group[0], group[1]);
      } else {
        collapsed.push(...group);
      }
    }
    final = collapsed;

    // Exclude already-shown keywords (for "Fetch More")
    if (Array.isArray(exclude_keywords) && exclude_keywords.length > 0) {
      const excludeSet = new Set(exclude_keywords.map(k => k.toLowerCase()));
      final = final.filter(kw => !excludeSet.has(kw.keyword.toLowerCase()));
    }

    // Filter by minimum volume
    if (min_volume && min_volume > 0) {
      final = final.filter(kw => (kw.volume || 0) >= min_volume);
    }

    // Volume is already location-specific from DataForSEO — no ratio needed

    // Sort by volume descending
    final.sort((a, b) => (b.volume || 0) - (a.volume || 0));

    // Cap to package size
    final = final.slice(0, cap);

    console.log(`[kw-research] Returning ${final.length} keywords (cap: ${cap}, location_code: ${locationCode})`);
    res.json({
      keywords: final,
      total_found: Object.keys(kwMap).length,
      location: locationName,
      location_code: locationCode,
    });
  } catch (e) {
    console.error('[kw-research] Error:', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

// ==================== SITE PAGES (Staging Zone) ====================

// Generate site map from Page Setup — cluster, detect cornerstones, plan internal links
app.post('/api/projects/:projectId/site-pages/generate', async (req, res) => {
  const { projectId } = req.params;
  try {
    // Get all assigned keywords from content_keywords
    const kwResult = await pool.query(
      `SELECT * FROM content_keywords WHERE project_id=$1 AND page_type IS NOT NULL AND page_type != 'unassigned' ORDER BY page_type, page_name`,
      [projectId]
    );
    const keywords = kwResult.rows;
    if (keywords.length === 0) return res.status(400).json({ error: 'No keywords assigned to pages yet. Go to Page Setup first.' });

    // Get project info
    const projResult = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    const project = projResult.rows[0];
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // Group keywords by page_type + page_name
    const pageMap = {};
    keywords.forEach(kw => {
      const key = kw.page_type + '::' + (kw.page_name || 'unnamed');
      if (!pageMap[key]) pageMap[key] = { type: kw.page_type, name: kw.page_name || 'unnamed', keywords: [] };
      pageMap[key].keywords.push({ keyword: kw.keyword, volume: kw.search_volume || 0 });
    });
    const pages = Object.values(pageMap);

    // Also include empty pages from nw_page_labels or project settings
    // (empty pages are tracked in frontend state — they'll appear if they have keywords)

    // Send to Haiku for clustering, cornerstone detection, and internal linking plan
    const pagesSummary = pages.map((p, i) => `Page ${i + 1}: [${p.type}] "${p.name}" — Keywords: ${p.keywords.map(k => k.keyword + ' (' + k.volume + ')').join(', ')}`).join('\n');

    const aiResponse = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: `You are an SEO content strategist. Analyze these pages for a ${project.industry || 'business'} website (${project.business_name || project.name}) in ${project.location || 'Australia'}.

PAGES:
${pagesSummary}

Return a JSON object with this exact structure:
{
  "pages": [
    {
      "page_index": 0,
      "is_cornerstone": true/false,
      "cluster_id": "cluster-name",
      "focus_keyword": "best keyword for this page",
      "suggested_slug": "/page-slug",
      "suggested_meta_title": "Page Title | Brand (max 60 chars)",
      "suggested_meta_description": "Description (max 155 chars)",
      "internal_links": [
        { "target_index": 2, "anchor_text": "anchor text to use", "context": "where in the content to place this link" }
      ]
    }
  ],
  "clusters": [
    { "id": "cluster-name", "label": "Cluster Display Name", "cornerstone_index": 0 }
  ]
}

Rules:
- Cornerstone pages are broad topic hubs (e.g., main service pages). Cluster pages are specific subtopics that link to the cornerstone.
- Every cluster page should link to its cornerstone. Cornerstones should link to their cluster pages.
- Home page links to all cornerstones.
- Focus keyword should be the most relevant keyword to the page name/topic AND have good volume. It MUST relate to the page name.
- Meta title and meta description MUST be specifically about the page name/topic, not generic.
- Slugs should be SEO-friendly, lowercase, hyphenated, derived from the page name.
- Internal links should form a logical silo structure.
- Return ONLY the JSON, no markdown.`
      }]
    });

    let aiPlan;
    try {
      const text = aiResponse.content[0].text.trim();
      aiPlan = JSON.parse(text.replace(/^```json?\n?/, '').replace(/\n?```$/, ''));
    } catch (e) {
      console.error('[site-pages] AI parse error:', e.message);
      return res.status(500).json({ error: 'Failed to parse AI response' });
    }

    // Delete existing site_pages for this project
    await pool.query('DELETE FROM site_pages WHERE project_id=$1', [projectId]);

    // Insert pages from AI plan
    const insertedPages = [];
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const plan = aiPlan.pages[i] || {};
      const result = await pool.query(
        `INSERT INTO site_pages (project_id, page_type, page_name, slug, is_cornerstone, cluster_id, keywords, internal_links, meta_title, meta_description, focus_keyword, stage)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'draft')
         RETURNING *`,
        [
          projectId, page.type, page.name,
          plan.suggested_slug || '/' + page.name.toLowerCase().replace(/\s+/g, '-'),
          plan.is_cornerstone || false,
          plan.cluster_id || null,
          JSON.stringify(page.keywords),
          JSON.stringify(plan.internal_links || []),
          plan.suggested_meta_title || page.name,
          plan.suggested_meta_description || '',
          plan.focus_keyword || (page.keywords[0] ? page.keywords[0].keyword : '')
        ]
      );
      insertedPages.push(result.rows[0]);
    }

    // Now resolve internal_links target_index → actual page IDs
    for (const sp of insertedPages) {
      if (sp.internal_links && sp.internal_links.length > 0) {
        const resolved = sp.internal_links.map(link => ({
          target_page_id: insertedPages[link.target_index] ? insertedPages[link.target_index].id : null,
          target_page_name: insertedPages[link.target_index] ? insertedPages[link.target_index].page_name : '',
          anchor_text: link.anchor_text,
          context: link.context
        })).filter(l => l.target_page_id);
        await pool.query('UPDATE site_pages SET internal_links=$1 WHERE id=$2', [JSON.stringify(resolved), sp.id]);
        sp.internal_links = resolved;
      }
    }

    // Build inbound links (reverse of internal_links)
    for (const sp of insertedPages) {
      const inbound = [];
      for (const other of insertedPages) {
        if (other.id === sp.id) continue;
        const linksToMe = (other.internal_links || []).filter(l => l.target_page_id === sp.id);
        linksToMe.forEach(l => inbound.push({ source_page_id: other.id, source_page_name: other.page_name, anchor_text: l.anchor_text }));
      }
      if (inbound.length > 0) {
        await pool.query('UPDATE site_pages SET inbound_links=$1 WHERE id=$2', [JSON.stringify(inbound), sp.id]);
        sp.inbound_links = inbound;
      }
    }

    res.json({ pages: insertedPages, clusters: aiPlan.clusters || [] });
  } catch (e) {
    console.error('[site-pages] Error:', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

// ==================== OPTIMISE WEBSITE — SITE GRAPH ====================

// Helper: run the actual site graph crawl
async function crawlSiteGraph(project) {
  const siteUrl = (project.domain || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const fullUrl = 'https://' + siteUrl;
  const wpUrl = project.wordpress_url || null;

  const pages = await discoverPages(fullUrl, wpUrl, getWpAuthHeaders(project));

  // Resolve slug-based page_ids to numeric WordPress IDs
  const authHeaders = getWpAuthHeaders(project);
  const slugToModified = {};
  if (wpUrl && authHeaders) {
    const wpBase = wpUrl.replace(/\/$/, '');
    const slugToId = {};
    try {
      for (const type of ['pages', 'posts']) {
        let page = 1;
        while (page <= 5) {
          const resp = await fetch(`${wpBase}/wp-json/wp/v2/${type}?per_page=100&page=${page}&status=publish&_fields=id,slug,link,modified`, { headers: authHeaders, signal: AbortSignal.timeout(15000) });
          if (!resp.ok) break;
          const items = await resp.json();
          if (!Array.isArray(items) || items.length === 0) break;
          items.forEach(item => {
            slugToId[item.slug] = item.id;
            if (item.modified) slugToModified[item.slug] = item.modified;
            if (item.link) {
              const linkSlug = item.link.replace(fullUrl, '').replace(/^\/|\/$/g, '') || 'home';
              slugToId[linkSlug] = item.id;
              if (item.modified) slugToModified[linkSlug] = item.modified;
            }
          });
          if (items.length < 100) break;
          page++;
        }
      }
    } catch (e) { console.log('[site-graph] WP ID resolution failed:', e.message); }

    // Update pages with numeric IDs
    for (const p of pages) {
      if (isNaN(Number(p.page_id))) {
        const wpId = slugToId[p.slug] || slugToId[p.page_id];
        if (wpId) p.page_id = String(wpId);
      }
    }
  }

  const nodes = [];
  const edges = [];
  const urlToIdx = {};
  pages.forEach((p, i) => { urlToIdx[p.url] = i; urlToIdx[p.url.replace(/\/$/, '')] = i; });

  const batchSize = 5;
  for (let b = 0; b < pages.length; b += batchSize) {
    const batch = pages.slice(b, b + batchSize);
    const results = await Promise.allSettled(batch.map(async (p) => {
      const node = { id: p.page_id, title: p.title, slug: p.slug, url: p.url, meta_title: '', meta_description: '', word_count: 0, h1: '', internal_links: [], external_links: 0, inbound_count: 0, issues: [], last_modified: slugToModified[p.slug] || null };
      try {
        const resp = await fetch(p.url, { headers: { 'User-Agent': 'SEORoomBot/1.0' }, signal: AbortSignal.timeout(10000) });
        if (resp.ok) {
          const html = await resp.text();
          const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
          node.meta_title = titleMatch ? titleMatch[1].trim() : '';
          const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i);
          node.meta_description = descMatch ? descMatch[1].trim() : '';
          const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
          node.h1 = h1Match ? h1Match[1].replace(/<[^>]+>/g, '').trim() : '';
          if (!node.last_modified) {
            const modMatch = html.match(/<meta[^>]*property=["']article:modified_time["'][^>]*content=["']([^"']*)["']/i);
            if (modMatch) node.last_modified = modMatch[1];
          }
          const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
          if (bodyMatch) {
            const text = bodyMatch[1].replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ');
            node.word_count = text.split(/\s+/).filter(w => w.length > 0).length;
          }
          const linkRegex = /href=["'](https?:\/\/[^"']*|\/[^"']*)/gi;
          let lm;
          const seenLinks = new Set();
          while ((lm = linkRegex.exec(html)) !== null) {
            let href = lm[1];
            if (href.startsWith('/')) href = fullUrl + href;
            const clean = href.replace(/\/$/, '').replace(/#.*$/, '').replace(/\?.*$/, '');
            if (clean.includes(siteUrl) && !seenLinks.has(clean)) {
              seenLinks.add(clean);
              node.internal_links.push(clean);
              const targetIdx = urlToIdx[clean] || urlToIdx[clean + '/'];
              if (targetIdx !== undefined && targetIdx !== (b + batch.indexOf(p))) {
                edges.push({ source: p.page_id, target: pages[targetIdx].page_id });
              }
            } else if (!clean.includes(siteUrl) && clean.startsWith('http')) {
              node.external_links++;
            }
          }
        }
      } catch (e) { /* timeout or fetch error */ }
      return node;
    }));
    for (const r of results) {
      if (r.status === 'fulfilled') nodes.push(r.value);
    }
  }

  const inboundMap = {};
  edges.forEach(e => { inboundMap[e.target] = (inboundMap[e.target] || 0) + 1; });
  nodes.forEach(n => { n.inbound_count = inboundMap[n.id] || 0; });

  nodes.forEach(n => {
    // Meta title/desc checks removed — On-Page Audit handles those via Yoast REST API (more accurate)
    if (!n.h1) n.issues.push('Missing H1 tag');
    if (n.word_count < 300) n.issues.push('Thin content (' + n.word_count + ' words)');
    if (n.internal_links.length === 0) n.issues.push('No outbound internal links');
    if (n.inbound_count === 0) n.issues.push('Orphan page — no inbound links');
  });

  const orphans = nodes.filter(n => n.inbound_count === 0 && n.slug !== 'home' && n.slug !== '');
  const issueCount = nodes.reduce((sum, n) => sum + n.issues.length, 0);

  return { nodes, edges, stats: { total: nodes.length, orphans: orphans.length, issues: issueCount } };
}

// GET — return cached site graph if exists
app.get('/api/projects/:projectId/site-graph', async (req, res) => {
  try {
    const cached = await pool.query(
      `SELECT audit_data, completed_at FROM audits WHERE project_id=$1 AND pillar='site_graph' AND status='completed' ORDER BY completed_at DESC LIMIT 1`,
      [req.params.projectId]
    );
    if (cached.rows.length > 0) {
      const data = cached.rows[0].audit_data;
      // Auto-strip meta issues from cached data (On-Page Audit handles those now)
      const metaPrefixes = ['Missing or short meta', 'Meta title too long', 'Meta description too long'];
      let cleaned = false;
      if (data && data.nodes) {
        for (const n of data.nodes) {
          const before = (n.issues || []).length;
          n.issues = (n.issues || []).filter(i => !metaPrefixes.some(p => i.startsWith(p)));
          if (n.issues.length !== before) cleaned = true;
        }
        if (cleaned) {
          data.stats.issues = data.nodes.reduce((sum, n) => sum + n.issues.length, 0);
          pool.query(`UPDATE audits SET audit_data = $1 WHERE id = $2`, [JSON.stringify(data), cached.rows[0].id]).catch(() => {});
        }
      }
      return res.json({ ...data, scanned_at: cached.rows[0].completed_at });
    }
    res.json({ nodes: null, edges: null, stats: null, scanned_at: null });
  } catch (e) {
    console.error('[site-graph] GET Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST — fresh crawl, save to DB, return results
app.post('/api/projects/:projectId/site-graph', async (req, res) => {
  try {
    const proj = await pool.query('SELECT * FROM projects WHERE id=$1', [req.params.projectId]);
    if (proj.rows.length === 0) return res.status(404).json({ error: 'Project not found' });

    const data = await crawlSiteGraph(proj.rows[0]);

    // Save to audits table
    await pool.query(
      `INSERT INTO audits (project_id, pillar, status, audit_data, started_at, completed_at)
       VALUES ($1, 'site_graph', 'completed', $2, NOW(), NOW())`,
      [req.params.projectId, JSON.stringify(data)]
    );

    res.json({ ...data, scanned_at: new Date().toISOString() });
  } catch (e) {
    console.error('[site-graph] POST Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Quick-create a single site page (e.g. from Maps advice)
app.post('/api/projects/:projectId/site-pages/quick-create', async (req, res) => {
  try {
    const { page_name, page_type, keyword, location } = req.body;
    if (!page_name) return res.status(400).json({ error: 'page_name required' });
    const slug = '/' + page_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const keywords = keyword ? JSON.stringify([{ keyword, location: location || '' }]) : '[]';
    const result = await pool.query(
      `INSERT INTO site_pages (project_id, page_type, page_name, slug, is_cornerstone, keywords, meta_title, meta_description, focus_keyword, stage)
       VALUES ($1, $2, $3, $4, false, $5, $6, '', $7, 'draft') RETURNING *`,
      [req.params.projectId, page_type || 'suburb', page_name, slug, keywords, page_name, keyword || '']
    );
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get all site pages for a project
app.get('/api/projects/:projectId/site-pages', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM site_pages WHERE project_id=$1 ORDER BY is_cornerstone DESC, page_type, page_name',
      [req.params.projectId]
    );
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update a site page (edit meta, content, stage)
app.put('/api/projects/:projectId/site-pages/:pageId', async (req, res) => {
  try {
    const { meta_title, meta_description, focus_keyword, draft_content, word_count, stage, slug, is_cornerstone, page_name } = req.body;
    const result = await pool.query(
      `UPDATE site_pages SET
        meta_title=COALESCE($3, meta_title), meta_description=COALESCE($4, meta_description),
        focus_keyword=COALESCE($5, focus_keyword), draft_content=COALESCE($6, draft_content),
        word_count=COALESCE($7, word_count), stage=COALESCE($8, stage), slug=COALESCE($9, slug),
        is_cornerstone=COALESCE($10, is_cornerstone), page_name=COALESCE($11, page_name),
        updated_at=NOW()
       WHERE id=$1 AND project_id=$2 RETURNING *`,
      [req.params.pageId, req.params.projectId, meta_title, meta_description, focus_keyword, draft_content, word_count, stage, slug, is_cornerstone, page_name]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Page not found' });
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Generate content for a site page
app.post('/api/projects/:projectId/site-pages/:pageId/generate-content', async (req, res) => {
  const { projectId, pageId } = req.params;
  try {
    const pageResult = await pool.query('SELECT * FROM site_pages WHERE id=$1 AND project_id=$2', [pageId, projectId]);
    if (pageResult.rows.length === 0) return res.status(404).json({ error: 'Page not found' });
    const page = pageResult.rows[0];

    // Get all pages for linking context
    const allPages = await pool.query('SELECT id, page_name, slug, is_cornerstone, cluster_id, focus_keyword FROM site_pages WHERE project_id=$1', [projectId]);
    const project = (await pool.query('SELECT * FROM projects WHERE id=$1', [projectId])).rows[0];

    // Get content settings for this page type
    const settingsResult = await pool.query('SELECT * FROM content_settings WHERE project_id=$1 AND page_type=$2', [projectId, page.page_type]);
    const settings = settingsResult.rows[0] || { target_word_count: 1500, tone: 'professional', style: 'informative' };

    const linksContext = (page.internal_links || []).map(l => {
      const target = allPages.rows.find(p => p.id === l.target_page_id);
      return target ? `Link to "${target.page_name}" (${target.slug}) with anchor text "${l.anchor_text}" — ${l.context || 'naturally in context'}` : '';
    }).filter(Boolean).join('\n');

    const aiResponse = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8192,
      messages: [{
        role: 'user',
        content: `Write a complete webpage for a ${project.industry || 'business'} website (${project.business_name || project.name}) in ${project.location || 'Australia'}.

CRITICAL: The page topic is "${page.page_name}". ALL content, the H1, meta title, and meta description MUST be specifically about "${page.page_name}". Do NOT write generic content about the business — write specifically about this topic.

PAGE TOPIC: "${page.page_name}" (${page.page_type})
FOCUS KEYWORD: ${page.focus_keyword || 'N/A'}
TARGET KEYWORDS: ${(page.keywords || []).map(k => k.keyword).join(', ')}
${page.is_cornerstone ? 'This is a CORNERSTONE page — it should be comprehensive and link to subtopic pages.' : 'This is a cluster page — it should link back to the cornerstone.'}

SUGGESTED META (update to match "${page.page_name}" topic):
META TITLE: ${page.meta_title}
META DESCRIPTION: ${page.meta_description}

INTERNAL LINKS TO INCLUDE:
${linksContext || 'No internal links planned.'}

REQUIREMENTS:
- The H1 MUST include "${page.page_name}" or a close variation
- Target word count: ${settings.target_word_count} words
- Tone: ${settings.tone}
- Style: ${settings.style}
${settings.tone_of_voice ? '- Brand voice: ' + settings.tone_of_voice : ''}
- Include the focus keyword in the H1 and first paragraph
- Use H2 and H3 subheadings naturally
- Include internal links as HTML <a> tags with the specified anchor text and href
- Write for SEO but make it read naturally for humans
- Include a clear call to action
- Do NOT include the <html>, <head>, or <body> tags — just the page content HTML starting with <h1>
- Do NOT include any placeholder text — all content must be real and specific to this business

Return ONLY the HTML content, no markdown wrapping.`
      }]
    });

    const content = aiResponse.content[0].text.trim().replace(/^```html?\n?/, '').replace(/\n?```$/, '');
    const wordCount = content.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;

    // Save to DB
    await pool.query(
      'UPDATE site_pages SET draft_content=$1, word_count=$2, stage=$3, updated_at=NOW() WHERE id=$4',
      [content, wordCount, page.stage === 'draft' ? 'written' : page.stage, pageId]
    );

    res.json({ content, word_count: wordCount });
  } catch (e) {
    console.error('[site-pages] Content gen error:', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

// Publish a site page to WordPress
app.post('/api/projects/:projectId/site-pages/:pageId/publish', async (req, res) => {
  const { projectId, pageId } = req.params;
  try {
    const pageResult = await pool.query('SELECT * FROM site_pages WHERE id=$1 AND project_id=$2', [pageId, projectId]);
    if (pageResult.rows.length === 0) return res.status(404).json({ error: 'Page not found' });
    const page = pageResult.rows[0];
    if (!page.draft_content) return res.status(400).json({ error: 'No content to publish. Generate content first.' });

    const project = (await pool.query('SELECT * FROM projects WHERE id=$1', [projectId])).rows[0];
    const wpUrl = project.wordpress_url;
    if (!wpUrl) return res.status(400).json({ error: 'WordPress URL not configured in project settings.' });

    const authHeaders = getWpAuthHeaders(project);
    if (!authHeaders) return res.status(400).json({ error: 'WordPress credentials not configured.' });

    // Create page on WordPress
    const wpType = page.page_type === 'blog' ? 'posts' : 'pages';
    const wpResponse = await fetch(`${wpUrl}/wp-json/wp/v2/${wpType}`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: page.page_name,
        content: page.draft_content,
        status: 'publish',
        slug: (page.slug || '').replace(/^\//, ''),
        meta: {
          _yoast_wpseo_title: page.meta_title || '',
          _yoast_wpseo_metadesc: page.meta_description || '',
          _yoast_wpseo_focuskw: page.focus_keyword || ''
        }
      })
    });

    if (!wpResponse.ok) {
      const err = await wpResponse.text();
      return res.status(500).json({ error: 'WordPress publish failed: ' + err });
    }
    const wpPage = await wpResponse.json();

    // Update stage and published URL
    await pool.query(
      'UPDATE site_pages SET stage=$1, published_url=$2, published_at=NOW(), updated_at=NOW() WHERE id=$3',
      ['published', wpPage.link || wpUrl + page.slug, pageId]
    );

    // Record in wp_change_history for rollback
    await pool.query(
      `INSERT INTO wp_change_history (project_id, page_id, page_url, page_title, change_type, field_name, original_value, new_value)
       VALUES ($1, $2, $3, $4, 'create', 'new_page', '', $5)`,
      [projectId, wpPage.id, wpPage.link, page.page_name, 'Created via Site Staging']
    );

    res.json({ success: true, url: wpPage.link, wp_id: wpPage.id });
  } catch (e) {
    console.error('[site-pages] Publish error:', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

// AI Optimise a site page — takes score tips + content, returns improved version
app.post('/api/projects/:projectId/site-pages/:pageId/optimise', async (req, res) => {
  const { projectId, pageId } = req.params;
  const { tips, stats, content_score, missing_keywords, focus_keyword } = req.body;
  try {
    const pageResult = await pool.query('SELECT * FROM site_pages WHERE id=$1 AND project_id=$2', [pageId, projectId]);
    if (pageResult.rows.length === 0) return res.status(404).json({ error: 'Page not found' });
    const page = pageResult.rows[0];
    const project = (await pool.query('SELECT * FROM projects WHERE id=$1', [projectId])).rows[0];

    // Get all pages for internal linking
    const allPages = await pool.query('SELECT id, page_name, slug, focus_keyword FROM site_pages WHERE project_id=$1 AND id != $2', [projectId, pageId]);

    const issuesText = (tips || []).filter(t => t.type === 'error' || t.type === 'warn').map(t => '- ' + t.text).join('\n');
    const missingKwsText = (missing_keywords || []).map(k => k.keyword || k).join(', ');

    const aiResponse = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8192,
      messages: [{
        role: 'user',
        content: `You are an SEO content optimizer for ${project.business_name || project.name} (${project.industry || 'business'}) in ${project.location || 'Australia'}.

CURRENT CONTENT (score: ${content_score || 0}/100):
${page.draft_content || ''}

ISSUES TO FIX:
${issuesText || 'None'}

MISSING KEYWORDS TO ADD NATURALLY:
${missingKwsText || 'None'}

FOCUS KEYWORD: ${focus_keyword || page.focus_keyword || 'N/A'}
Current stats: ${JSON.stringify(stats || {})}

AVAILABLE INTERNAL LINKS:
${allPages.rows.map(p => p.page_name + ' (' + p.slug + ')').join(', ')}

REQUIREMENTS:
- Fix ALL listed issues
- Weave missing keywords naturally (don't keyword stuff)
- Target 1500+ words
- Ensure focus keyword appears 3-8 times
- Add H2/H3 subheadings if lacking
- Add internal links as <a href="slug">anchor text</a>
- Keep the same overall structure and tone, just improve
- Return ONLY the optimized HTML content (no wrapping markdown)
- Also return updated meta title (max 60 chars) and meta description (max 155 chars)

Return JSON: { "content_html": "...", "meta_title": "...", "meta_description": "...", "ai_notes": "what was changed" }`
      }]
    });

    let result;
    try {
      const text = aiResponse.content[0].text.trim().replace(/^```json?\n?/, '').replace(/\n?```$/, '');
      result = JSON.parse(text);
    } catch (e) {
      // If not JSON, treat as raw HTML
      result = { content_html: aiResponse.content[0].text.trim(), meta_title: page.meta_title, meta_description: page.meta_description, ai_notes: 'Optimized content' };
    }

    res.json(result);
  } catch (e) {
    console.error('[site-pages] Optimise error:', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

// ==================== GSC AUDIT ====================

app.post('/api/projects/:projectId/audits/gsc/run', async (req, res) => {
  const { projectId } = req.params;
  try {
    const proj = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    if (proj.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = proj.rows[0];
    const domain = project.domain;

    // Clean up old unactioned findings from previous runs
    await pool.query(`DELETE FROM audit_findings WHERE project_id=$1 AND pillar='gsc' AND status='new'`, [projectId]);

    // Try to get fresh GSC data first, fall back to stored data
    let gscRows = [];
    let pageRows = [];
    let matchedSite = null;
    const accessToken = await getGscAccessToken(req.auth?.userId);

    if (accessToken) {
      // Find matching GSC site
      const sites = await fetch('https://www.googleapis.com/webmasters/v3/sites', {
        headers: { Authorization: `Bearer ${accessToken}` }
      }).then(r => r.json());
      const available = (sites.siteEntry || []).map(s => s.siteUrl);
      matchedSite = available.find(s => s.includes(domain.replace(/^www\./, '')));
      if (!matchedSite && available.length > 0) matchedSite = available[0];

      if (matchedSite) {
        const endDate = new Date().toISOString().split('T')[0];
        const startDate = new Date(Date.now() - 28 * 86400000).toISOString().split('T')[0];

        // Fetch keyword-level data
        const kwRes = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(matchedSite)}/searchAnalytics/query`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ startDate, endDate, dimensions: ['query'], rowLimit: 1000 })
        }).then(r => r.json());
        gscRows = (kwRes.rows || []).map(r => ({ keyword: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position }));

        // Fetch page-level data
        const pgRes = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(matchedSite)}/searchAnalytics/query`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ startDate, endDate, dimensions: ['page'], rowLimit: 500 })
        }).then(r => r.json());
        pageRows = (pgRes.rows || []).map(r => ({ page: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position }));

        // Fetch page+query combos for cannibalization check
        const pqRes = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(matchedSite)}/searchAnalytics/query`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ startDate, endDate, dimensions: ['query', 'page'], rowLimit: 2000 })
        }).then(r => r.json());
        var pageQueryRows = (pqRes.rows || []).map(r => ({ keyword: r.keys[0], page: r.keys[1], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position }));
      }
    }

    // Fall back to stored GSC data if no live data
    if (gscRows.length === 0) {
      const stored = await pool.query('SELECT keyword, clicks, impressions, ctr, position FROM gsc_keywords WHERE project_id=$1 ORDER BY impressions DESC', [projectId]);
      gscRows = stored.rows;
    }

    if (gscRows.length === 0) {
      return res.json({ findings: [], message: 'No GSC data available. Connect GSC and sync keywords first.' });
    }

    // Create audit record
    const auditRes = await pool.query(
      `INSERT INTO audits (project_id, pillar, status, started_at) VALUES ($1, 'gsc', 'running', NOW()) RETURNING id`,
      [projectId]
    );
    const auditId = auditRes.rows[0].id;

    const findings = [];

    // 1. QUICK WINS: Keywords ranking 4-20 with high impressions (close to page 1)
    const quickWins = gscRows
      .filter(r => r.position >= 4 && r.position <= 20 && r.impressions >= 10)
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 20);

    for (const kw of quickWins) {
      const severity = kw.position <= 10 ? 'Critical' : kw.position <= 15 ? 'Medium' : 'Low';
      findings.push({
        pillar: 'gsc', category: 'Quick Win',
        title: `"${kw.keyword}" ranking #${Math.round(kw.position)} — push to page 1`,
        description: `This keyword has ${kw.impressions} impressions/month but ranks at position ${kw.position.toFixed(1)}. With targeted optimization it could reach page 1.`,
        recommendation: kw.position <= 10
          ? 'Optimize the ranking page: improve title tag, add internal links, expand content around this topic.'
          : 'Create or improve a dedicated page targeting this keyword. Add it to your content plan.',
        severity,
        current_value: `Position ${kw.position.toFixed(1)} | ${kw.impressions} imp | ${kw.clicks} clicks`,
        recommended_value: 'Position 1-3'
      });
    }

    // 2. LOW CTR: Keywords with high impressions but low CTR (needs better titles/descriptions)
    const lowCtr = gscRows
      .filter(r => r.impressions >= 50 && r.ctr < 0.02 && r.position <= 20)
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 15);

    for (const kw of lowCtr) {
      findings.push({
        pillar: 'gsc', category: 'Low CTR',
        title: `"${kw.keyword}" has ${kw.impressions} impressions but only ${(kw.ctr * 100).toFixed(1)}% CTR`,
        description: `This keyword gets good visibility but users aren't clicking. The title tag or meta description may not be compelling enough.`,
        recommendation: 'Rewrite the meta title and description to include the keyword and a clear call-to-action. Make it stand out in search results.',
        severity: kw.impressions >= 200 ? 'Critical' : 'Medium',
        current_value: `CTR: ${(kw.ctr * 100).toFixed(1)}% | ${kw.clicks} clicks / ${kw.impressions} impressions`,
        recommended_value: 'CTR > 3%'
      });
    }

    // 3. HIGH IMPRESSION ZERO CLICK: Wasted visibility
    const zeroClick = gscRows
      .filter(r => r.impressions >= 30 && r.clicks === 0)
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 10);

    for (const kw of zeroClick) {
      findings.push({
        pillar: 'gsc', category: 'Zero Clicks',
        title: `"${kw.keyword}" — ${kw.impressions} impressions, 0 clicks`,
        description: `This keyword is showing in search results but getting zero clicks. The listing may be unappealing or the keyword may trigger featured snippets.`,
        recommendation: 'Review the SERP for this keyword. If a featured snippet exists, restructure your content to win it. Otherwise, rewrite title/description.',
        severity: kw.impressions >= 100 ? 'Medium' : 'Low',
        current_value: `${kw.impressions} impressions, 0 clicks, Position ${kw.position.toFixed(1)}`,
        recommended_value: 'At least 1-2% CTR'
      });
    }

    // 4. CANNIBALIZATION: Multiple pages ranking for the same keyword
    if (pageQueryRows && pageQueryRows.length > 0) {
      const kwPages = {};
      for (const row of pageQueryRows) {
        if (!kwPages[row.keyword]) kwPages[row.keyword] = [];
        kwPages[row.keyword].push(row);
      }

      const cannibalized = Object.entries(kwPages)
        .filter(([kw, pages]) => pages.length >= 2 && pages.some(p => p.impressions >= 10))
        .sort((a, b) => {
          const aImp = a[1].reduce((s, p) => s + p.impressions, 0);
          const bImp = b[1].reduce((s, p) => s + p.impressions, 0);
          return bImp - aImp;
        })
        .slice(0, 10);

      for (const [kw, pages] of cannibalized) {
        const totalImp = pages.reduce((s, p) => s + p.impressions, 0);
        const urls = pages.map(p => {
          try { return new URL(p.page).pathname; } catch { return p.page; }
        }).join(', ');
        findings.push({
          pillar: 'gsc', category: 'Cannibalization',
          title: `"${kw}" ranking on ${pages.length} different pages`,
          description: `Multiple pages compete for the same keyword, splitting authority. Pages: ${urls}`,
          recommendation: 'Consolidate content into one authoritative page. Redirect or noindex the weaker pages, or differentiate their target keywords.',
          severity: totalImp >= 100 ? 'Critical' : 'Medium',
          current_value: `${pages.length} pages | ${totalImp} total impressions`,
          recommended_value: '1 page per keyword'
        });
      }
    }

    // 5. DECLINING PAGES: Pages with high impressions but poor performance
    const poorPages = (pageRows || [])
      .filter(r => r.impressions >= 50 && r.ctr < 0.015)
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 10);

    for (const pg of poorPages) {
      let path;
      try { path = new URL(pg.page).pathname; } catch { path = pg.page; }
      findings.push({
        pillar: 'gsc', category: 'Underperforming Page',
        title: `${path} — ${pg.impressions} impressions, ${(pg.ctr * 100).toFixed(1)}% CTR`,
        description: `This page appears in search results frequently but converts poorly to clicks.`,
        recommendation: 'Audit the page title, meta description, and structured data. Consider adding FAQ schema or improving the content quality.',
        severity: pg.impressions >= 200 ? 'Critical' : 'Medium',
        current_value: `${pg.clicks} clicks / ${pg.impressions} imp | CTR ${(pg.ctr * 100).toFixed(1)}%`,
        recommended_value: 'CTR > 3%'
      });
    }

    // 6. BRANDED vs NON-BRANDED split
    const brandTerms = (project.name || '').toLowerCase().split(/\s+/).filter(w => w.length > 3);
    if (brandTerms.length > 0) {
      const branded = gscRows.filter(r => brandTerms.some(t => r.keyword.toLowerCase().includes(t)));
      const nonBranded = gscRows.filter(r => !brandTerms.some(t => r.keyword.toLowerCase().includes(t)));
      const brandedClicks = branded.reduce((s, r) => s + r.clicks, 0);
      const totalClicks = gscRows.reduce((s, r) => s + r.clicks, 0);
      const brandPct = totalClicks > 0 ? (brandedClicks / totalClicks * 100) : 0;

      if (brandPct > 70) {
        findings.push({
          pillar: 'gsc', category: 'Brand Dependency',
          title: `${brandPct.toFixed(0)}% of clicks come from branded searches`,
          description: `Your traffic is heavily dependent on brand searches. If people don't know your brand, they won't find you.`,
          recommendation: 'Invest in non-branded content targeting service + location keywords. Build topical authority with blog posts and service pages.',
          severity: 'Critical',
          current_value: `Branded: ${brandPct.toFixed(0)}% (${brandedClicks}/${totalClicks} clicks)`,
          recommended_value: 'Below 50% branded'
        });
      }
    }

    // 7. INDEXING ISSUES: Check key pages via URL Inspection API
    if (accessToken && matchedSite) {
      try {
        // Get important pages from sitemap or pageRows
        const baseUrl = `https://${domain}`;
        const pagesToCheck = [baseUrl + '/'];

        // Add service pages and suburb pages from sitemap or page data
        const allPages = (pageRows || []).map(p => p.page);

        // Services pages (contain /services, /plumber, /gas-fitting, /blocked-drain etc)
        const servicePages = allPages.filter(p =>
          p.match(/\/(services|plumb|gas|drain|hot-water|water-filter|leak|burst|tap|toilet|bathroom|kitchen|emergency)/i)
        );
        pagesToCheck.push(...servicePages);

        // Suburb/location pages
        const serviceAreas = project.service_areas || [];
        for (const area of serviceAreas) {
          const suburbSlug = (area.name || '').toLowerCase().replace(/\s+/g, '-');
          if (suburbSlug) {
            // Try common URL patterns for suburb pages
            const suburbUrl = allPages.find(p => p.toLowerCase().includes(suburbSlug));
            if (suburbUrl && !pagesToCheck.includes(suburbUrl)) pagesToCheck.push(suburbUrl);
            else if (!pagesToCheck.some(p => p.includes(suburbSlug))) {
              pagesToCheck.push(`${baseUrl}/plumber-${suburbSlug}/`);
            }
          }
        }

        // Also add any remaining high-impression pages not yet included
        for (const p of allPages.slice(0, 20)) {
          if (!pagesToCheck.includes(p)) pagesToCheck.push(p);
        }

        console.log(`[gsc-audit] Indexing check: ${pagesToCheck.length} pages to check (home + services + suburbs)`);

        let notIndexed = [];
        let crawledNotIndexed = [];
        let mobileIssues = [];

        for (const pageUrl of pagesToCheck.slice(0, 20)) {
          try {
            const inspRes = await fetch('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', {
              method: 'POST',
              headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ inspectionUrl: pageUrl, siteUrl: matchedSite })
            });
            if (inspRes.ok) {
              const inspData = await inspRes.json();
              const result = inspData.inspectionResult;
              const indexStatus = result?.indexStatusResult;
              const mobileStatus = result?.mobileUsabilityResult;

              if (indexStatus) {
                const verdict = indexStatus.verdict;
                const coverageState = indexStatus.coverageState;

                if (verdict === 'FAIL' || verdict === 'NEUTRAL') {
                  let path;
                  try { path = new URL(pageUrl).pathname; } catch { path = pageUrl; }

                  if (coverageState === 'Crawled - currently not indexed' || coverageState === 'Discovered - currently not indexed') {
                    crawledNotIndexed.push({ url: path, state: coverageState, lastCrawl: indexStatus.lastCrawlTime, robotsTxt: indexStatus.robotsTxtState, indexing: indexStatus.indexingState, crawlable: indexStatus.pageFetchState });
                  } else {
                    notIndexed.push({ url: path, state: coverageState || verdict, reason: indexStatus.pageFetchState, robotsTxt: indexStatus.robotsTxtState, indexing: indexStatus.indexingState, lastCrawl: indexStatus.lastCrawlTime });
                  }
                }
              }

              // Mobile usability
              if (mobileStatus?.verdict === 'FAIL') {
                let path;
                try { path = new URL(pageUrl).pathname; } catch { path = pageUrl; }
                const issues = (mobileStatus.issues || []).map(i => i.issueType).join(', ');
                mobileIssues.push({ url: path, issues });
              }
            }
          } catch (e) { /* skip individual page errors */ }
        }

        // Create individual findings per page for better detail
        for (const page of notIndexed) {
          findings.push({
            pillar: 'gsc', category: 'Indexing Issues',
            title: `${page.url} — NOT indexed`,
            description: `Status: ${page.state}. Fetch state: ${page.reason || 'unknown'}. ${page.robotsTxt ? 'Robots.txt: ' + page.robotsTxt + '.' : ''} ${page.indexing ? 'Indexing state: ' + page.indexing + '.' : ''} This page is completely invisible in Google search results.`,
            recommendation: `1) Check if ${page.url} has a noindex meta tag or is blocked by robots.txt. 2) Verify the canonical tag points to itself. 3) Submit the URL for indexing in Google Search Console. 4) Add internal links from other pages pointing to this URL.`,
            severity: 'Critical',
            current_value: `Not indexed | ${page.state}`,
            recommended_value: 'Indexed and ranking'
          });
        }

        for (const page of crawledNotIndexed) {
          const lastCrawlStr = page.lastCrawl ? new Date(page.lastCrawl).toLocaleDateString() : 'unknown';
          findings.push({
            pillar: 'gsc', category: 'Indexing Issues',
            title: `${page.url} — Crawled but NOT indexed`,
            description: `Status: "${page.state}". Last crawled: ${lastCrawlStr}. Google visited this page but decided not to add it to the index. Common reasons: thin content, duplicate content, low internal links, or Google considers it low quality.`,
            recommendation: `1) Review the content on ${page.url} — is it unique and valuable? At least 500+ words? 2) Check for duplicate content with other pages on the site. 3) Add 3-5 internal links from high-authority pages pointing to this URL. 4) Add schema markup (FAQ, LocalBusiness). 5) Request indexing in GSC after improvements.`,
            severity: 'Medium',
            current_value: `Crawled, not indexed | Last crawl: ${lastCrawlStr}`,
            recommended_value: 'Indexed and ranking'
          });
        }

        for (const page of mobileIssues) {
          findings.push({
            pillar: 'gsc', category: 'Mobile Usability',
            title: `${page.url} — Mobile usability issues`,
            description: `Issues found: ${page.issues}. Mobile usability problems hurt rankings since Google uses mobile-first indexing.`,
            recommendation: `Fix the mobile issues on ${page.url}: ensure proper viewport meta tag, readable text without zooming, adequate tap target sizing, and no horizontal scrolling.`,
            severity: 'Medium',
            current_value: `${page.issues}`,
            recommended_value: '0 mobile issues'
          });
        }

        if (notIndexed.length === 0 && crawledNotIndexed.length === 0) {
          findings.push({
            pillar: 'gsc', category: 'Indexing Issues',
            title: 'All checked pages are indexed',
            description: `${pagesToCheck.length} pages checked (home, services, suburbs) — all are indexed by Google.`,
            recommendation: 'Continue monitoring. New pages should be submitted via GSC sitemap.',
            severity: 'Low',
            current_value: 'All indexed',
            recommended_value: 'All indexed'
          });
        }

        console.log(`[gsc-audit] Indexing check: ${notIndexed.length} not indexed, ${crawledNotIndexed.length} crawled not indexed, ${mobileIssues.length} mobile issues`);
      } catch (e) {
        console.log(`[gsc-audit] URL Inspection failed: ${e.message}`);
      }
    }

    // Save findings to DB
    for (const f of findings) {
      const r = await pool.query(
        `INSERT INTO audit_findings (project_id, audit_id, pillar, category, title, description, recommendation, severity, current_value, recommended_value)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [projectId, auditId, f.pillar, f.category, f.title, f.description, f.recommendation, f.severity, f.current_value, f.recommended_value]
      );
      f.id = r.rows[0].id;
      f.status = 'new';
    }

    // Mark audit complete
    await pool.query('UPDATE audits SET status=$1, completed_at=NOW(), audit_data=$2 WHERE id=$3',
      ['completed', JSON.stringify({ totalKeywords: gscRows.length, totalPages: (pageRows || []).length, findingsCount: findings.length }), auditId]);

    console.log(`[gsc-audit] Project ${projectId}: ${findings.length} findings from ${gscRows.length} keywords`);
    res.json({ findings, summary: { keywords: gscRows.length, pages: (pageRows || []).length, findings: findings.length } });
  } catch (e) {
    console.error('[gsc-audit] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==================== GBP AUDIT (Comprehensive Local SEO Audit) ====================

// Australian business directory database
const AUSTRALIAN_DIRECTORIES = [
  { name: 'Google Business Profile', url: 'business.google.com', type: 'Essential', free: true, difficulty: 'Easy', priority: 1, description: 'Most important local listing — drives Maps rankings' },
  { name: 'Apple Maps (Apple Business Connect)', url: 'businessconnect.apple.com', type: 'Essential', free: true, difficulty: 'Easy', priority: 2, description: 'Growing in importance with iPhone users' },
  { name: 'Bing Places', url: 'bingplaces.com', type: 'Essential', free: true, difficulty: 'Easy', priority: 3, description: 'Powers Bing, Cortana, and some voice search results' },
  { name: 'Yellow Pages Australia', url: 'yellowpages.com.au', type: 'Major', free: true, paid_option: '$30-300/mo', difficulty: 'Easy', priority: 4, description: 'High DA Australian directory, free basic listing' },
  { name: 'True Local', url: 'truelocal.com.au', type: 'Major', free: true, paid_option: '$20-200/mo', difficulty: 'Easy', priority: 5, description: 'Popular Australian directory with good SEO authority' },
  { name: 'Hotfrog', url: 'hotfrog.com.au', type: 'Major', free: true, difficulty: 'Easy', priority: 6, description: 'Free Australian business directory with decent DA' },
  { name: 'Local Business Guide', url: 'localbusinessguide.com.au', type: 'Major', free: true, difficulty: 'Easy', priority: 7, description: 'Australian local business directory' },
  { name: 'Start Local', url: 'startlocal.com.au', type: 'Major', free: true, paid_option: '$99-499/yr', difficulty: 'Easy', priority: 8, description: 'Australian directory with categories' },
  { name: 'Yelp Australia', url: 'yelp.com.au', type: 'Major', free: true, difficulty: 'Easy', priority: 9, description: 'International directory, helps with global SEO signals' },
  { name: 'Facebook Business', url: 'facebook.com', type: 'Essential', free: true, difficulty: 'Easy', priority: 10, description: 'Social proof + local signals + reviews' },
  { name: 'LinkedIn Company', url: 'linkedin.com', type: 'Standard', free: true, difficulty: 'Easy', priority: 11, description: 'Professional presence, B2B signals' },
  { name: 'Word of Mouth', url: 'wordofmouth.com.au', type: 'Major', free: true, paid_option: 'Contact for pricing', difficulty: 'Easy', priority: 12, description: 'Australian review platform, good for tradies' },
  { name: 'Oneflare', url: 'oneflare.com.au', type: 'Industry', free: false, paid_option: 'Pay per lead', difficulty: 'Medium', priority: 13, description: 'Lead gen for trades/services, good citations' },
  { name: 'hipages', url: 'hipages.com.au', type: 'Industry', free: false, paid_option: '$50-500/mo', difficulty: 'Medium', priority: 14, description: 'Top trades directory in Australia, strong local SEO' },
  { name: 'ServiceSeeking', url: 'serviceseeking.com.au', type: 'Industry', free: false, paid_option: 'Pay per lead', difficulty: 'Medium', priority: 15, description: 'Trades lead gen platform with business profiles' },
  { name: 'Bark', url: 'bark.com', type: 'Industry', free: true, paid_option: 'Pay per lead', difficulty: 'Easy', priority: 16, description: 'International service marketplace' },
  { name: 'Localsearch', url: 'localsearch.com.au', type: 'Major', free: true, paid_option: '$30-200/mo', difficulty: 'Easy', priority: 17, description: 'Australian business directory and digital marketing' },
  { name: 'Australian Business Directory', url: 'australianbusinessdirectory.com.au', type: 'Standard', free: true, difficulty: 'Easy', priority: 18, description: 'Basic free Australian listing' },
  { name: 'dLook', url: 'dlook.com.au', type: 'Standard', free: true, difficulty: 'Easy', priority: 19, description: 'Free Australian business directory' },
  { name: 'Superpages', url: 'superpages.com.au', type: 'Standard', free: true, difficulty: 'Easy', priority: 20, description: 'Australian online directory' },
  { name: 'Fyple', url: 'fyple.com.au', type: 'Standard', free: true, difficulty: 'Easy', priority: 21, description: 'Free business listing directory' },
  { name: 'EnrollBusiness', url: 'enrollbusiness.com', type: 'Standard', free: true, difficulty: 'Easy', priority: 22, description: 'Free international business directory' },
  { name: 'Cylex', url: 'cylex.com.au', type: 'Standard', free: true, difficulty: 'Easy', priority: 23, description: 'Free business directory with map integration' },
  { name: 'Spoke', url: 'spoke.com', type: 'Standard', free: true, difficulty: 'Easy', priority: 24, description: 'Business profile and networking' },
  { name: 'Foursquare', url: 'foursquare.com', type: 'Standard', free: true, difficulty: 'Easy', priority: 25, description: 'Location data powers Apple Maps, Uber, and others' },
];

app.post('/api/projects/:projectId/audits/gbp/run', async (req, res) => {
  const { projectId } = req.params;
  try {
    const proj = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    if (proj.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = proj.rows[0];

    await pool.query(`DELETE FROM audit_findings WHERE project_id=$1 AND pillar='gbp'`, [projectId]);

    const auditRes = await pool.query(
      `INSERT INTO audits (project_id, pillar, status, started_at) VALUES ($1, 'gbp', 'running', NOW()) RETURNING id`,
      [projectId]
    );
    const auditId = auditRes.rows[0].id;

    const domain = (project.domain || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    const businessName = project.business_name || project.name || '';
    const location = project.location || '';
    const industry = project.industry || '';
    const GOOGLE_KEY = process.env.PAGESPEED_API_KEY || process.env.GOOGLE_API_KEY;

    // ===== PHASE 1: Gather all data =====
    const gbpData = { profile: null, source: 'none', competitors: [], mapsRankings: [], directories: AUSTRALIAN_DIRECTORIES };

    // 1. Get business profile — prefer extension-scraped data (100% accurate)

    // 1a. Check for extension-scraped GBP data (most accurate source)
    try {
      const extData = await pool.query(
        `SELECT config, updated_at FROM project_integrations WHERE project_id=$1 AND kind='gbp_profile'`,
        [projectId]
      );
      if (extData.rows.length > 0) {
        const ext = typeof extData.rows[0].config === 'string' ? JSON.parse(extData.rows[0].config) : extData.rows[0].config;
        const ageHours = (Date.now() - new Date(extData.rows[0].updated_at).getTime()) / (1000 * 60 * 60);
        console.log(`[gbp-audit] Extension data found (${Math.round(ageHours)}h old)`);

        gbpData.source = 'extension';
        gbpData.profile = {
          name: ext.business?.name || businessName,
          address: ext.address || '',
          phone: ext.phone || null,
          website: ext.website || null,
          rating: ext.reviews?.averageRating || null,
          reviewCount: ext.reviews?.totalCount || 0,
          primaryType: (ext.categories || []).find(c => c.primary)?.name || null,
          categories: (ext.categories || []).map(c => c.name),
          description: ext.description || null,
          hoursSet: (ext.hours || []).length > 0,
          hoursText: (ext.hours || []).map(h => `${h.day}: ${h.hours}`).join('; '),
          hoursDays: (ext.hours || []).length,
          photoCount: ext.photos?.totalCount || 0,
          photosByOwner: ext.photos?.byOwner || 0,
          photosByCustomer: ext.photos?.byCustomer || 0,
          services: ext.services || [],
          serviceAreas: ext.service_areas || [],
          posts: ext.posts || { count: 0 },
          attributes: ext.attributes || [],
          products: ext.products || [],
          reviews: [],
          thirdPartyReviews: ext.thirdPartyReviews || [],
          socialProfiles: ext.socialProfiles || [],
          monthlyViews: ext.monthlyViews || null,
          collectedAt: ext.collected_at,
          dataAge: `${Math.round(ageHours)}h`,
        };
        console.log(`[gbp-audit] PROFILE (extension):`, JSON.stringify({
          name: gbpData.profile.name, rating: gbpData.profile.rating, reviews: gbpData.profile.reviewCount,
          photos: gbpData.profile.photoCount, categories: gbpData.profile.categories,
          description: gbpData.profile.description ? 'YES' : 'NO', hours: gbpData.profile.hoursSet,
          services: gbpData.profile.services.length, posts: gbpData.profile.posts.count,
        }));
      }
    } catch (e) { console.log(`[gbp-audit] Extension data check error: ${e.message}`); }

    // 1b. SerpAPI Maps — run to get rating/reviews/categories
    // Extension data will be merged on top afterwards for hours/description
    const extensionProfile = gbpData.profile; // Save extension data to merge later
    if (SERPAPI_KEY && businessName) {
      try {
        const searchQ = businessName.replace(/&/g, 'and');
        console.log(`[gbp-audit] SerpAPI search: "${searchQ}" (original: "${businessName}"`);

        const data = await serpApiSearch({
          engine: 'google_maps',
          q: searchQ,
          type: 'search',
          api_key: SERPAPI_KEY,
        });

        const results = data.local_results || [];
        console.log(`[gbp-audit] SerpAPI found ${results.length} results`);

        // Match by website domain (most accurate)
        const match = results.find(r => r.website && r.website.includes(domain)) ||
          results.find(r => r.title && r.title.toLowerCase().includes('houseworks')) ||
          null;

        if (match) {
          console.log(`[gbp-audit] Matched: "${match.title}" (${match.website || 'no website'})`);
          gbpData.source = 'serpapi';
          // match.reviews can be a number or a URL string — extract the number
          const reviewCount = typeof match.reviews === 'number' ? match.reviews : (typeof match.reviews_original === 'number' ? match.reviews_original : parseInt(match.reviews) || 0);
          gbpData.profile = {
            name: match.title || '',
            address: match.address || '',
            phone: match.phone || null,
            website: match.website || null,
            rating: match.rating || null,
            reviewCount: reviewCount,
            primaryType: match.type || null,
            categories: match.types || (match.type ? [match.type] : []),
            placeId: match.place_id || null,
            photoCount: match.thumbnail ? 1 : 0,
            serviceOptions: match.service_options || null,
          };

          // Get more data via Google Knowledge Graph (regular Google search)
          {
            try {
              const kpData = await serpApiSearch({
                engine: 'google',
                q: businessName,
                api_key: SERPAPI_KEY,
              });
              const kp = kpData.knowledge_graph || {};
              console.log(`[gbp-audit] Knowledge graph: title="${kp.title || 'none'}", desc=${kp.description ? 'YES' : 'NO'}, hours=${kp.hours ? 'YES' : 'NO'}, type="${kp.type || 'none'}"`);

              // Also check local_results from Google search for richer data
              const localResult = (kpData.local_results?.places || [])[0];
              if (localResult) {
                console.log(`[gbp-audit] Local result: photos=${localResult.photos_count || '?'}, hours=${localResult.operating_hours ? 'YES' : 'NO'}`);
                if (localResult.description) gbpData.profile.description = localResult.description;
                if (localResult.operating_hours) {
                  gbpData.profile.hoursSet = true;
                  gbpData.profile.hoursText = JSON.stringify(localResult.operating_hours);
                }
              }
              if (kp.description) gbpData.profile.description = kp.description;
              if (kp.hours) {
                gbpData.profile.hoursSet = true;
                gbpData.profile.hoursText = typeof kp.hours === 'string' ? kp.hours : JSON.stringify(kp.hours);
              }

              // Merge knowledge graph — only safe fields, never overwrite reviewCount with non-numbers
              const p = kp;
              if (p) {
                if (p.address) gbpData.profile.address = p.address;
                if (p.phone) gbpData.profile.phone = p.phone;
                // Don't overwrite reviewCount — KG often has wrong/missing data
                // Don't overwrite rating — SerpAPI Maps is more accurate
                // Only overwrite if KG has better data — never null out existing values
                if (p.description && !gbpData.profile.description) gbpData.profile.description = p.description;
                console.log(`[gbp-audit] KG merge: description=${gbpData.profile.description ? 'YES' : 'NO'}, hours=${gbpData.profile.hoursSet}`);
              }
            } catch (e) { console.log(`[gbp-audit] Detail lookup error: ${e.message}`); }
          }

          console.log(`[gbp-audit] PROFILE:`, JSON.stringify({
            name: gbpData.profile.name, rating: gbpData.profile.rating, reviews: gbpData.profile.reviewCount,
            photos: gbpData.profile.photoCount, phone: gbpData.profile.phone ? 'YES' : 'NO',
            categories: gbpData.profile.categories, description: gbpData.profile.description ? 'YES' : 'NO',
            hours: gbpData.profile.hoursSet, website: gbpData.profile.website ? 'YES' : 'NO',
          }));
        } else {
          console.log(`[gbp-audit] No match found for domain "${domain}" in ${results.length} results`);
          if (results.length > 0) console.log(`[gbp-audit] First result: "${results[0].title}" (${results[0].website || 'no site'})`);
        }
      } catch (e) { console.error('[gbp-audit] SerpAPI error:', e.message); }
    }

    // 1b. Enrich profile with DataForSEO (full GBP data: description, hours, services, posts, Q&A)
    if (DATAFORSEO_AUTH && gbpData.profile?.placeId) {
      try {
        console.log(`[gbp-audit] DataForSEO lookup for place_id: ${gbpData.profile.placeId}`);
        const dfsResp = await fetch('https://api.dataforseo.com/v3/business_data/google/my_business_info/task_post', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': DATAFORSEO_AUTH },
          body: JSON.stringify([{ keyword: businessName, location_name: location || 'Australia', language_name: 'English' }]),
          signal: AbortSignal.timeout(15000),
        });
        if (dfsResp.ok) {
          const dfsData = await dfsResp.json();
          const task = dfsData.tasks?.[0];
          if (task?.status_code === 20000 && task.result?.[0]?.items?.[0]) {
            const item = task.result[0].items[0];
            console.log(`[gbp-audit] DataForSEO found: "${item.title}", desc=${item.description ? 'YES' : 'NO'}, hours=${item.work_hours ? 'YES' : 'NO'}, services=${(item.people_also_search || []).length}`);
            // Merge richer data
            if (item.description) gbpData.profile.description = item.description;
            if (item.work_hours) {
              gbpData.profile.hoursSet = true;
              gbpData.profile.hoursText = JSON.stringify(item.work_hours);
            }
            if (item.total_photos) gbpData.profile.photoCount = item.total_photos;
            if (item.phone) gbpData.profile.phone = item.phone;
            if (item.category) gbpData.profile.primaryType = item.category;
            if (item.additional_categories) gbpData.profile.categories = [item.category, ...item.additional_categories].filter(Boolean);
            if (item.attributes) gbpData.profile.attributes = item.attributes;
            if (item.place_topics) gbpData.profile.topics = item.place_topics;
            gbpData.profile.dfsEnriched = true;
          } else {
            console.log(`[gbp-audit] DataForSEO: no results or error`, task?.status_code, task?.status_message);
          }
        }
      } catch (e) { console.log(`[gbp-audit] DataForSEO error: ${e.message}`); }
    }

    // 1b-alt. Try DataForSEO by keyword if no place_id
    if (DATAFORSEO_AUTH && gbpData.profile && !gbpData.profile.dfsEnriched) {
      try {
        console.log(`[gbp-audit] DataForSEO keyword search: "${businessName}"`);
        const dfsResp = await fetch('https://api.dataforseo.com/v3/business_data/google/my_business_info/task_post', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': DATAFORSEO_AUTH },
          body: JSON.stringify([{ keyword: businessName, location_name: location || 'Australia', language_name: 'English' }]),
          signal: AbortSignal.timeout(15000),
        });
        if (dfsResp.ok) {
          const dfsData = await dfsResp.json();
          const task = dfsData.tasks?.[0];
          if (task?.status_code === 20000 && task.result?.[0]?.items) {
            // Find matching business by domain
            const items = task.result[0].items;
            const match = items.find(i => i.domain && i.domain.includes(domain)) || items.find(i => i.title && i.title.toLowerCase().includes(businessName.split(' ')[0].toLowerCase())) || items[0];
            if (match) {
              console.log(`[gbp-audit] DataForSEO matched: "${match.title}", desc=${match.description ? 'YES' : 'NO'}, hours=${match.work_hours ? 'YES' : 'NO'}, photos=${match.total_photos || '?'}`);
              if (match.description) gbpData.profile.description = match.description;
              if (match.work_hours) { gbpData.profile.hoursSet = true; gbpData.profile.hoursText = JSON.stringify(match.work_hours); }
              if (match.total_photos) gbpData.profile.photoCount = match.total_photos;
              if (match.category) gbpData.profile.primaryType = match.category;
              if (match.additional_categories) gbpData.profile.categories = [match.category, ...match.additional_categories].filter(Boolean);
              if (match.attributes) gbpData.profile.attributes = match.attributes;
              gbpData.profile.dfsEnriched = true;
            }
          }
        }
      } catch (e) { console.log(`[gbp-audit] DataForSEO keyword error: ${e.message}`); }
    }

    // 1c. Scrape website for NAP consistency + schema
    if (domain) {
      try {
        const siteRes = await fetch(`https://${domain}`, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SEORoom/1.0)' } });
        if (siteRes.ok) {
          const html = await siteRes.text();
          gbpData.websiteCheck = {
            hasPhone: /tel:[\d\+\-\s\(\)]+/.test(html),
            hasAddress: /\d+\s+[\w\s]+(?:street|st|road|rd|avenue|ave|drive|dr|way|place|pl|crescent|cr)/i.test(html),
          };
          const schemaMatch = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
          if (schemaMatch) {
            gbpData.websiteCheck.schemas = schemaMatch.map(s => {
              try { return JSON.parse(s.replace(/<\/?script[^>]*>/gi, '')); } catch { return null; }
            }).filter(Boolean);
            gbpData.websiteCheck.hasLocalBusinessSchema = gbpData.websiteCheck.schemas.some(s => 
              s['@type'] === 'LocalBusiness' || s['@type'] === 'Plumber' || s['@type'] === 'HomeAndConstructionBusiness' ||
              (Array.isArray(s['@graph']) && s['@graph'].some(g => ['LocalBusiness', 'Plumber', 'HomeAndConstructionBusiness'].includes(g['@type'])))
            );
          }
          console.log(`[gbp-audit] Website check: phone=${gbpData.websiteCheck.hasPhone}, address=${gbpData.websiteCheck.hasAddress}, schema=${gbpData.websiteCheck.hasLocalBusinessSchema || false}`);
        }
      } catch (e) { console.log(`[gbp-audit] Website scrape error: ${e.message}`); }
    }

    // 2. Get maps ranking data + identify competitors
    const mapsData = await pool.query(
      `SELECT keyword, location, maps_position, maps_title, maps_rating, maps_reviews, checked_at
       FROM rank_tracking WHERE project_id=$1 AND maps_position IS NOT NULL
       ORDER BY checked_at DESC LIMIT 200`, [projectId]
    );
    gbpData.mapsRankings = mapsData.rows.map(r => ({
      keyword: r.keyword, location: r.location,
      position: r.maps_position, rating: r.maps_rating, reviews: r.maps_reviews,
    }));

    // Extract top competitors from maps data (businesses ranking above us)
    const competitorMap = {};
    for (const r of mapsData.rows) {
      if (r.maps_title && r.maps_title.toLowerCase() !== businessName.toLowerCase()) {
        if (!competitorMap[r.maps_title]) {
          competitorMap[r.maps_title] = { name: r.maps_title, rating: r.maps_rating, reviews: r.maps_reviews, appearances: 0, avgPosition: 0, keywords: [] };
        }
        competitorMap[r.maps_title].appearances++;
        competitorMap[r.maps_title].keywords.push({ keyword: r.keyword, location: r.location, position: r.maps_position });
      }
    }
    // Top 5 competitors by appearances
    gbpData.competitors = Object.values(competitorMap)
      .sort((a, b) => b.appearances - a.appearances)
      .slice(0, 5)
      .map(c => ({
        ...c,
        avgPosition: (c.keywords.reduce((s, k) => s + k.position, 0) / c.keywords.length).toFixed(1),
        keywords: c.keywords.slice(0, 5),
      }));

    // Fallback: if no competitors from maps data, use Project Settings competitors + SerpAPI lookup
    if (gbpData.competitors.length === 0 && (project.competitors || []).length > 0 && SERPAPI_KEY) {
      console.log(`[gbp-audit] No maps competitors found, looking up ${project.competitors.length} from Project Settings`);
      for (const compDomain of (project.competitors || []).slice(0, 5)) {
        try {
          const cleanDomain = compDomain.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
          // Extract a business name from domain: "littlepommieplumber.com.au" -> "little pommie plumber"
          const domainName = cleanDomain.split('.')[0].replace(/[-_]/g, ' ');
          const searchQuery = `${domainName} ${(location || '').split(',')[0] || ''}`.trim();
          console.log(`[gbp-audit] Competitor search: "${searchQuery}" (from ${compDomain})`);
          const compSearch = await serpApiSearch({
            engine: 'google_maps',
            q: searchQuery,
            type: 'search',
            api_key: SERPAPI_KEY,
          });
          const place = (compSearch.local_results || [])[0];
          if (place) {
            gbpData.competitors.push({
              name: place.title || compDomain,
              rating: place.rating || null,
              reviews: place.reviews || null,
              appearances: 0,
              avgPosition: place.position || '—',
              keywords: [],
              source: 'project_settings',
              profile: {
                rating: place.rating,
                reviews: place.reviews,
                photoCount: (place.thumbnail ? 1 : 0),
                categories: place.type ? 1 : 0,
                primaryType: place.type || null,
                website: place.website || null,
              },
            });
          }
        } catch (e) { console.log(`[gbp-audit] Competitor lookup failed for ${compDomain}:`, e.message); }
      }
      console.log(`[gbp-audit] Found ${gbpData.competitors.length} competitors from Project Settings`);
    }

    // 3. Look up top competitor profiles via Places API for comparison
    if (GOOGLE_KEY && gbpData.competitors.length > 0) {
      for (const comp of gbpData.competitors.slice(0, 3)) {
        try {
          const compResp = await fetch('https://places.googleapis.com/v1/places:searchText', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Goog-Api-Key': GOOGLE_KEY,
              'X-Goog-FieldMask': 'places.displayName,places.rating,places.userRatingCount,places.types,places.primaryTypeDisplayName,places.photos,places.editorialSummary,places.regularOpeningHours,places.websiteUri'
            },
            body: JSON.stringify({ textQuery: `${comp.name} ${location.split(',')[0] || ''}`.trim(), languageCode: 'en' })
          });
          if (compResp.ok) {
            const compData = await compResp.json();
            const p = (compData.places || [])[0];
            if (p) {
              comp.profile = {
                rating: p.rating, reviews: p.userRatingCount,
                photoCount: (p.photos || []).length,
                primaryType: p.primaryTypeDisplayName?.text || null,
                categories: (p.types || []).length,
                hasDescription: !!p.editorialSummary?.text,
                hasHours: !!(p.regularOpeningHours?.periods),
                website: p.websiteUri || null,
              };
            }
          }
        } catch (e) { /* skip competitor lookup errors */ }
      }
    }

    const serviceAreas = project.service_areas || [];
    // Merge extension data on top of SerpAPI data (extension wins for hours, address)
    if (extensionProfile && gbpData.profile) {
      if (extensionProfile.hoursSet) { gbpData.profile.hoursSet = true; gbpData.profile.hoursText = extensionProfile.hoursText; gbpData.profile.hoursDays = extensionProfile.hoursDays; }
      if (extensionProfile.address) gbpData.profile.address = extensionProfile.address;
      if (extensionProfile.description) gbpData.profile.description = extensionProfile.description;
      if (extensionProfile.services && extensionProfile.services.length > 0) gbpData.profile.services = extensionProfile.services;
      if (extensionProfile.posts) gbpData.profile.posts = extensionProfile.posts;
      if (extensionProfile.attributes && extensionProfile.attributes.length > 0) gbpData.profile.attributes = extensionProfile.attributes;
      if (extensionProfile.photoCount > 1) gbpData.profile.photoCount = extensionProfile.photoCount;
      if (extensionProfile.thirdPartyReviews) gbpData.profile.thirdPartyReviews = extensionProfile.thirdPartyReviews;
      if (extensionProfile.socialProfiles) gbpData.profile.socialProfiles = extensionProfile.socialProfiles;
      if (extensionProfile.monthlyViews) gbpData.profile.monthlyViews = extensionProfile.monthlyViews;
      gbpData.profile.extensionData = true;
      console.log(`[gbp-audit] Merged extension data: hours=${gbpData.profile.hoursSet}, desc=${gbpData.profile.description ? 'YES' : 'NO'}, photos=${gbpData.profile.photoCount}`);
    }

    console.log(`[gbp-audit] Final: source=${gbpData.source}, competitors=${gbpData.competitors.length}, rankings=${gbpData.mapsRankings.length}`);

    // ===== PHASE 2: AI Analysis =====
    let findings = [];

    if (anthropic) {
      try {
        const aiPrompt = `You are an expert local SEO auditor. Audit this Google Business Profile and produce findings based on the THREE PILLARS of local search: PROXIMITY, RELEVANCE, and PROMINENCE.

PROJECT: ${project.name} (${domain})
Business: ${businessName}
Industry: ${industry || 'trades/services'}
Location: ${location}
Service Areas: ${JSON.stringify(serviceAreas).substring(0, 500)}

===== CURRENT GBP PROFILE =====
${JSON.stringify(gbpData.profile, null, 1)}

IMPORTANT DATA NOTES:
- If "description" is null/NO, it means our API couldn't retrieve it — it does NOT mean the business has no description. DO NOT flag it as missing.
- If "hoursSet" is false/null, it means our API couldn't retrieve hours — DO NOT flag hours as missing.
- If "photoCount" is 1 or very low, our API only counts thumbnails — the actual count may be higher. Flag photos cautiously.
- ONLY flag things as missing if you are CERTAIN from the data. When in doubt, skip that finding.
- Focus on what you CAN see: categories, rating, review count, rankings, competitors.

===== COMPETITORS =====
${JSON.stringify(gbpData.competitors, null, 1)}

===== MAPS RANKINGS (sample of ${gbpData.mapsRankings.length}) =====
${JSON.stringify(gbpData.mapsRankings.slice(0, 20), null, 1)}

Return JSON with "findings" array AND "profile_summary" object.

The "profile_summary" should contain:
{
  "rating": number or null,
  "review_count": number or null,
  "photo_count": number or null,
  "primary_category": string or null,
  "secondary_categories": array or [],
  "has_description": boolean,
  "has_hours": boolean,
  "has_phone": boolean,
  "has_website": boolean,
  "services_listed": boolean or null,
  "posts_active": boolean or null,
  "pillar_scores": { "proximity": 1-10, "relevance": 1-10, "prominence": 1-10 }
}

CRITICAL: Each finding object MUST include ALL these fields:
{
  "gbp_pillar": "Proximity" or "Relevance" or "Prominence",
  "category": "subcategory name",
  "title": "action to take",
  "description": "why this matters",
  "recommendation": "one specific action",
  "severity": "Critical" or "High" or "Medium" or "Low",
  "current_value": "what it is now",
  "recommended_value": "what it should be"
}

EXAMPLE finding:
{"gbp_pillar": "Prominence", "category": "Reviews", "title": "Respond to all Google reviews", "description": "With 105 reviews, responding shows engagement.", "recommendation": "Set up a weekly review response schedule.", "severity": "High", "current_value": "Unknown response rate", "recommended_value": "100% response rate"}

"gbp_pillar" assigns each finding to one of the THREE PILLARS — this field is REQUIRED:
- "Proximity" = service areas, address, geo-targeting, maps ranking by suburb, distance issues
- "Relevance" = categories, description keywords, services listed, posts, attributes, hours, business info
- "Prominence" = reviews, photos, citations, social profiles, third-party reviews, brand signals

"category" is the subcategory:
  For Proximity: "Service Areas", "Maps Ranking", "Geo-Targeting"
  For Relevance: "Categories & Services", "Profile Completeness", "Posts & Updates", "Description"
  For Prominence: "Reviews", "Photos", "Citations", "Social Profiles"

ORGANIZE findings by the THREE PILLARS:

1. PROXIMITY (service areas + maps visibility):
   - Are service areas properly set on GBP? Any gaps vs project settings?
   - Which suburbs have weak/no ranking? (top 3-5 worst only)
   - Is address accurate and consistent?

2. RELEVANCE (categories, content, business info):
   - Is the primary category optimal? What should it be?
   - Are there secondary categories? What's missing? (e.g. "Gas Fitter", "Drain Cleaning Service")
   - Is the business description keyword-optimized?
   - Are services/products listed on GBP?
   - Are GBP posts being used? How often?
   - Are business hours complete (all 7 days)?
   - Are attributes set (licenses, payment methods, accessibility)?
   - Create ONE finding for EACH missing or suboptimal field.

3. PROMINENCE (reputation + brand signals):
   - Reviews: count, rating, are they being responded to? Do reviews mention suburbs?
   - Photos: how many? Types needed: logo, cover, team, before/after, van
   - Third-party reviews: Facebook, hipages, etc.
   - Social profiles: connected and active?
   - Citations: NAP consistency across directories
   - Create separate findings for each issue

RULES:
- ONE finding = ONE action. Each is approved or dismissed independently.
- "recommendation" = ONE sentence. ONE action. No lists.
- "title" reads like a to-do: "Add Gas Fitter as secondary category", "Upload 10 before/after job photos", "Write keyword-rich business description"
- NEVER flag missing data if the field is null in our data — the API may not return it.
- Use real numbers. No generic advice.
- Total: 15-30 focused findings. Quality over quantity.

Return ONLY valid JSON: {"profile_summary": {...}, "findings": [...]}`;

        const response = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 16000,
          messages: [{ role: 'user', content: aiPrompt }]
        });

        const text = response.content[0]?.text || '';
        console.log(`[gbp-audit] AI response: ${text.length} chars`);

        const jsonMatch = text.match(/\{[\s\S]*\}/);
        let profileSummary = null;
        if (jsonMatch) {
          // Clean common JSON issues from AI responses
          let jsonStr = jsonMatch[0]
            .replace(/,\s*}/g, '}')      // trailing commas before }
            .replace(/,\s*]/g, ']')      // trailing commas before ]
            .replace(/[\x00-\x1f]/g, ' ') // control characters
            .replace(/"\s*\n\s*"/g, '", "'); // missing commas between strings
          let parsed;
          try { parsed = JSON.parse(jsonStr); } catch (e) {
            // Second attempt: try to extract just the findings array
            console.log(`[gbp-audit] JSON parse retry after cleanup...`);
            const findingsMatch = text.match(/"findings"\s*:\s*\[([\s\S]*)\]/);
            if (findingsMatch) {
              try { parsed = { findings: JSON.parse('[' + findingsMatch[1] + ']') }; } catch (e2) {
                console.error('[gbp-audit] JSON parse failed even after cleanup:', e2.message);
                parsed = null;
              }
            }
          }
          if (!parsed) throw new Error('Could not parse AI response as JSON');
          profileSummary = parsed.profile_summary || null;
          // Smart fallback: infer pillar from category when AI doesn't include gbp_pillar
          const categoryToPillar = {
            'Reviews': 'Prominence', 'Review Management': 'Prominence', 'Review Response': 'Prominence',
            'Photos': 'Prominence', 'Photo Optimization': 'Prominence',
            'Citations': 'Prominence', 'Citation Building': 'Prominence', 'Directories': 'Prominence',
            'Social Profiles': 'Prominence', 'Social Media': 'Prominence',
            'Backlinks': 'Prominence', 'Online Presence': 'Prominence', 'Brand Mentions': 'Prominence',
            'Third-Party Reviews': 'Prominence', 'Reputation': 'Prominence',
            'Service Areas': 'Proximity', 'Service Area': 'Proximity',
            'Maps Ranking': 'Proximity', 'Maps': 'Proximity', 'Map Pack': 'Proximity',
            'Geo-Targeting': 'Proximity', 'Location': 'Proximity', 'Address': 'Proximity',
            'NAP Consistency': 'Proximity', 'NAP': 'Proximity', 'Local Landing Pages': 'Proximity',
            'Categories & Services': 'Relevance', 'Categories': 'Relevance', 'Services': 'Relevance',
            'Profile Completeness': 'Relevance', 'Business Information': 'Relevance',
            'Posts & Updates': 'Relevance', 'Posts': 'Relevance', 'Google Posts': 'Relevance',
            'Description': 'Relevance', 'Business Description': 'Relevance',
            'Website': 'Relevance', 'Website Optimization': 'Relevance',
            'Keywords': 'Relevance', 'Keyword Optimization': 'Relevance',
            'Q&A': 'Relevance', 'Products': 'Relevance', 'Attributes': 'Relevance',
            'Hours': 'Relevance', 'Business Hours': 'Relevance',
          };
          function inferPillar(finding) {
            if (['Proximity', 'Relevance', 'Prominence'].includes(finding.gbp_pillar)) return finding.gbp_pillar;
            const cat = (finding.category || '').trim();
            if (categoryToPillar[cat]) return categoryToPillar[cat];
            const catLower = cat.toLowerCase();
            for (const [key, pillar] of Object.entries(categoryToPillar)) {
              if (catLower.includes(key.toLowerCase()) || key.toLowerCase().includes(catLower)) return pillar;
            }
            const text = `${finding.title || ''} ${finding.description || ''}`.toLowerCase();
            if (/\b(review|rating|photo|citation|director|backlink|reputation|social|third.party)\b/.test(text)) return 'Prominence';
            if (/\b(service area|proximity|geo|location|address|nap |local pack|map)\b/.test(text)) return 'Proximity';
            return 'Relevance';
          }
          if (parsed.findings && Array.isArray(parsed.findings)) {
            findings = parsed.findings.map(f => {
              const gbpPillar = inferPillar(f);
              return {
                pillar: 'gbp', category: `${gbpPillar} > ${f.category || 'General'}`,
                gbp_pillar: gbpPillar,
                title: f.title, description: f.description,
                recommendation: f.recommendation, severity: f.severity || 'Medium',
                current_value: f.current_value || '', recommended_value: f.recommended_value || '',
              };
            });
          }
        }
      } catch (aiErr) {
        console.error('[gbp-audit] AI failed:', aiErr.message);
      }
    }

    // Build profile summary from raw data if AI didn't provide one
    const profileSummary = gbpData.profile ? {
      name: gbpData.profile.name,
      rating: gbpData.profile.rating,
      review_count: gbpData.profile.reviewCount,
      photo_count: gbpData.profile.photoCount,
      primary_category: gbpData.profile.primaryType,
      has_description: !!gbpData.profile.description,
      has_hours: gbpData.profile.hoursSet,
      has_phone: !!gbpData.profile.phone,
      has_website: !!gbpData.profile.website,
      address: gbpData.profile.address,
      business_status: gbpData.profile.businessStatus,
    } : null;

    // Fallback
    if (findings.length === 0) {
      if (!gbpData.profile) {
        findings.push({ pillar: 'gbp', category: 'Profile Completeness', title: 'GBP profile not found on Google Maps', description: `Could not find "${businessName}".`, recommendation: 'Verify your listing at business.google.com', severity: 'Critical', current_value: 'Not found', recommended_value: 'Verified' });
      }
    }

    // Save
    for (const f of findings) {
      const r = await pool.query(
        `INSERT INTO audit_findings (project_id, audit_id, pillar, category, title, description, recommendation, severity, current_value, recommended_value)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [projectId, auditId, f.pillar, f.category, f.title, f.description, f.recommendation, f.severity, f.current_value, f.recommended_value]
      );
      f.id = r.rows[0].id; f.status = 'new';
    }

    await pool.query('UPDATE audits SET status=$1, completed_at=NOW(), audit_data=$2 WHERE id=$3',
      ['completed', JSON.stringify({ findingsCount: findings.length, source: gbpData.source, competitors: gbpData.competitors.length, profileSummary }), auditId]);

    console.log(`[gbp-audit] Project ${projectId}: ${findings.length} findings via ${gbpData.source}`);
    res.json({ findings, profileSummary });
  } catch (e) {
    console.error('[gbp-audit] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==================== MANAGED AGENT HELPERS ====================

// Wait for a managed agent session to be ready for user input
async function waitForSessionReady(apiBase, agentHeaders, sessionId, label, maxWaitMs = 60000) {
  const pollMs = 2000;
  const t0 = Date.now();
  while (Date.now() - t0 < maxWaitMs) {
    const statusResp = await fetch(`${apiBase}/sessions/${sessionId}`, { method: 'GET', headers: agentHeaders });
    if (statusResp.ok) {
      const sess = await statusResp.json();
      const st = sess.status || sess.state || '';
      if (st === 'awaiting_input' || st === 'idle') {
        console.log(`[${label}] Session ready (${st})`);
        return true;
      }
      if (st === 'completed' || st === 'ended' || st === 'failed') {
        console.log(`[${label}] Session terminated before ready: ${st}`);
        return false;
      }
      console.log(`[${label}] Waiting for session ready... status: ${st}`);
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
  console.log(`[${label}] Session readiness timeout after ${maxWaitMs}ms`);
  return true; // proceed anyway, let the POST fail with a clear error
}

// Send user message to a managed agent session with retry on tool_use/tool_result errors
async function sendAgentMessage(apiBase, agentHeaders, sessionId, userPrompt, label, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const msgResp = await fetch(`${apiBase}/sessions/${sessionId}/events`, {
      method: 'POST',
      headers: agentHeaders,
      body: JSON.stringify({
        events: [{ type: 'user.message', content: [{ type: 'text', text: userPrompt }] }]
      }),
    });

    if (msgResp.ok) {
      const ack = await msgResp.text();
      console.log(`[${label}] Message sent (attempt ${attempt}): ${ack.substring(0, 200)}`);
      return true;
    }

    const errBody = await msgResp.text();
    console.log(`[${label}] Message send attempt ${attempt} failed (${msgResp.status}): ${errBody.substring(0, 500)}`);

    // If it's a tool_use/tool_result mismatch, wait for the environment to process tools then retry
    if (errBody.includes('tool_use') && errBody.includes('tool_result') && attempt < maxRetries) {
      console.log(`[${label}] Waiting for environment to process pending tool calls...`);
      await new Promise(r => setTimeout(r, 5000 * attempt)); // exponential backoff
      // Wait for session to become ready again
      await waitForSessionReady(apiBase, agentHeaders, sessionId, label, 30000);
      continue;
    }

    throw new Error(`Message send failed (${msgResp.status}): ${errBody}`);
  }
  throw new Error('Message send exhausted retries');
}

// Poll a managed agent session until complete, extract report text
async function pollAgentSession(apiBase, agentHeaders, sessionId, label, maxWaitMs = 600000) {
  const pollMs = 5000;
  const t0 = Date.now();

  while (Date.now() - t0 < maxWaitMs) {
    await new Promise(r => setTimeout(r, pollMs));

    const statusResp = await fetch(`${apiBase}/sessions/${sessionId}`, { method: 'GET', headers: agentHeaders });
    if (!statusResp.ok) {
      console.log(`[${label}] Status check failed: ${statusResp.status}`);
      continue;
    }

    const sess = await statusResp.json();
    const st = sess.status || sess.state || '';

    if (st === 'awaiting_input' || st === 'idle' || st === 'completed' || st === 'ended') {
      console.log(`[${label}] Agent finished: ${st}`);

      const evResp = await fetch(`${apiBase}/sessions/${sessionId}/events`, { method: 'GET', headers: agentHeaders });
      if (!evResp.ok) throw new Error(`GET events failed: ${evResp.status}`);
      const evBody = await evResp.text();
      console.log(`[${label}] Events length: ${evBody.length}`);

      let finalText = '';
      try {
        const evData = JSON.parse(evBody);
        const evts = evData.data || evData.events || (Array.isArray(evData) ? evData : []);

        // First pass: get assistant text from clearly-labeled assistant events
        for (const evt of evts) {
          const role = evt.role || evt.type || '';
          if (role === 'assistant' || role === 'assistant.message' || role === 'agent.response') {
            const content = evt.content || evt.message?.content || [];
            const parts = Array.isArray(content) ? content : (typeof content === 'string' ? [{ type: 'text', text: content }] : []);
            for (const p of parts) {
              if (p.type === 'text' && p.text) finalText += p.text + '\n';
            }
          }
        }

        // Fallback: get any non-user text blocks > 50 chars
        if (!finalText) {
          for (const evt of evts) {
            const role = evt.role || evt.type || '';
            if (role === 'user' || role === 'user.message') continue;
            const content = evt.content || evt.message?.content || [];
            const parts = Array.isArray(content) ? content : [];
            for (const p of parts) {
              if (p.type === 'text' && p.text && p.text.length > 50) finalText += p.text + '\n';
            }
          }
        }
      } catch (e) {
        console.log(`[${label}] Parse error: ${e.message}`);
        if (evBody.length > 200) finalText = evBody;
      }

      if (!finalText || finalText.length < 50) {
        throw new Error(`No assistant text. Events: ${evBody.length} chars`);
      }

      return finalText.trim();
    }
  }

  throw new Error('Agent timed out after 10 minutes');
}

// ==================== FOLLOW-UP EXTRACTION MESSAGE ====================
// Send a second message to the agent asking it to enumerate EVERY finding from its report as JSON.
// The agent already has the context — it just needs to output structured data without consolidating.

async function extractFindingsViaFollowUp(apiBase, agentHeaders, sessionId, pillar, label) {
  const validCategories = PILLAR_CATEGORIES[pillar] || [];
  const followUpPrompt = `Now I need you to create a complete JSON inventory of EVERY individual finding from your report above.

CRITICAL RULES:
- Go through your report section by section
- Every single row in every table = one JSON object
- Every single bullet point that describes an issue = one JSON object
- Do NOT consolidate or summarize — if your report mentions 12 on-page issues, I need 12 JSON objects
- Count your items and verify the total matches what your report shows
- TITLE MUST describe the specific issue, NOT just the page URL. Bad: "/about-us/". Good: "Missing H1 tag on /about-us/". Bad: "All pages". Good: "No viewport meta tag on all pages"
- Each title must be UNIQUE — if two findings have different issues, they need different titles
- NEVER combine multiple suburbs/locations into one finding. "Create pages for Morley + Guilford" is WRONG. Create SEPARATE findings: "Create location page for Morley" and "Create location page for Guilford"

Output ONLY this, nothing else:
~~~findings
[
  {"category":"<one of: ${validCategories.join(', ')}>","title":"<DESCRIPTIVE issue title, not just a URL, under 60 chars>","description":"<what is wrong — be specific, include page URLs>","recommendation":"<specific fix steps>","severity":"<Critical|High|Medium|Low>","current_value":"<current state>","recommended_value":"<target state>"}
]
~~~

Remember: one JSON object per table row, per bullet point, per issue. The total count MUST match your report.`;

  try {
    console.log(`[${label}] Sending follow-up extraction message...`);
    await waitForSessionReady(apiBase, agentHeaders, sessionId, label, 30000);
    await sendAgentMessage(apiBase, agentHeaders, sessionId, followUpPrompt, label);
    const extractionText = await pollAgentSession(apiBase, agentHeaders, sessionId, label, 300000);
    console.log(`[${label}] Follow-up response: ${extractionText.length} chars`);
    return extractionText;
  } catch (e) {
    console.error(`[${label}] Follow-up extraction failed: ${e.message}`);
    return null;
  }
}

// ==================== AGENT REPORT → STRUCTURED FINDINGS EXTRACTOR ====================

// Valid categories per pillar — findings MUST map to one of these
const PILLAR_CATEGORIES = {
  gbp_external: ['Profile Completeness', 'NAP Consistency', 'Reviews & Reputation', 'Competitor Analysis', 'Directory & Citations', 'Photos & Media', 'Suburb Coverage'],
  website: ['Site Health', 'Crawlability', 'On-Page Issues', 'Content Quality', 'Core Web Vitals', 'Schema & Data'],
  gsc_agent: ['Quick Wins', 'Low CTR Pages', 'Cannibalization', 'Zero-Click Pages', 'Underperforming Pages'],
  gsc: ['Quick Wins', 'Low CTR Pages', 'Cannibalization', 'Zero-Click Pages', 'Underperforming Pages'],
};

// ===== DETERMINISTIC findings extraction — NO AI, NO token limits, NO truncation =====
// Mirrors frontend parseReportSections + normalizeAgentSection logic exactly.
// Every bullet/numbered item/table row = one finding. 100% capture rate.

function serverNormalizeSection(name) {
  const n = name.replace(/\s*\(.*?\)\s*/g, '').trim();
  const lower = n.toLowerCase();
  const exactMap = {
    'quick wins': 'Quick Wins', 'quick win': 'Quick Wins', 'quick-win opportunities': 'Quick Wins',
    'low ctr pages': 'Low CTR Pages', 'low ctr': 'Low CTR Pages',
    'cannibalization': 'Cannibalization', 'keyword cannibalization': 'Cannibalization',
    'zero-click pages': 'Zero-Click Pages', 'zero click pages': 'Zero-Click Pages', 'zero clicks': 'Zero-Click Pages',
    'underperforming pages': 'Underperforming Pages', 'underperforming': 'Underperforming Pages',
    'action plan': 'Summary', 'priority action plan': 'Summary', 'summary': 'Summary',
    'site health': 'Site Health', 'site health overview': 'Site Health',
    'crawlability': 'Crawlability', 'crawlability & indexing': 'Crawlability', 'crawlability and indexing': 'Crawlability',
    'on-page issues': 'On-Page Issues', 'on-page seo issues': 'On-Page Issues', 'on page issues': 'On-Page Issues',
    'content quality': 'Content Quality',
    'core web vitals': 'Core Web Vitals', 'cwv': 'Core Web Vitals',
    'schema & structured data': 'Schema & Data', 'schema and structured data': 'Schema & Data', 'structured data': 'Schema & Data', 'schema': 'Schema & Data',
    'profile completeness': 'Profile Completeness', 'gbp profile completeness': 'Profile Completeness', 'profile optimization': 'Profile Completeness',
    'nap consistency': 'NAP Consistency', 'nap': 'NAP Consistency', 'name address phone': 'NAP Consistency',
    'reviews & reputation': 'Reviews & Reputation', 'reviews and reputation': 'Reviews & Reputation', 'reviews': 'Reviews & Reputation', 'review analysis': 'Reviews & Reputation',
    'competitor analysis': 'Competitor Analysis', 'competitors': 'Competitor Analysis', 'competitive analysis': 'Competitor Analysis',
    'directory & citations': 'Directory & Citations', 'directory and citations': 'Directory & Citations', 'directories & citations': 'Directory & Citations', 'citations': 'Directory & Citations', 'directories': 'Directory & Citations',
    'photos & media': 'Photos & Media', 'photos and media': 'Photos & Media', 'photos': 'Photos & Media', 'photo analysis': 'Photos & Media',
    'suburb coverage': 'Suburb Coverage', 'service area coverage': 'Suburb Coverage', 'suburb targeting': 'Suburb Coverage',
  };
  if (exactMap[lower]) return exactMap[lower];
  // Fuzzy
  if (/quick.?win|striking.?distance|page.?2|position.?[4-9]|position.?1[0-9]|position.?20|keyword.?opportunit/i.test(n)) return 'Quick Wins';
  if (/low.?ctr|poor.?ctr|ctr.?below|click.?through.?rate/i.test(n)) return 'Low CTR Pages';
  if (/cannibal|competing.?pages|duplicate.?rank/i.test(n)) return 'Cannibalization';
  if (/zero.?click|no.?click|0.?click/i.test(n)) return 'Zero-Click Pages';
  if (/underperform|stuck|should.?rank|declining/i.test(n)) return 'Underperforming Pages';
  if (/action.?plan|priority.?action|next.?action|implementation|summary/i.test(n)) return 'Summary';
  if (/site.?health|overall.?health|site.?overview/i.test(n)) return 'Site Health';
  if (/crawl|index|robot|sitemap/i.test(n)) return 'Crawlability';
  if (/on.?page|title.?tag|meta.?desc|h1|heading/i.test(n)) return 'On-Page Issues';
  if (/content.?quality|thin.?content|e-?e-?a-?t|word.?count/i.test(n)) return 'Content Quality';
  if (/core.?web|vital|cwv|speed|lcp|cls|inp|fcp/i.test(n)) return 'Core Web Vitals';
  if (/schema|structured.?data|rich.?result|json.?ld/i.test(n)) return 'Schema & Data';
  if (/profile.?complete|gbp.?profile|listing.?complete/i.test(n)) return 'Profile Completeness';
  if (/nap|name.?address.?phone/i.test(n)) return 'NAP Consistency';
  if (/review|reputation|rating/i.test(n)) return 'Reviews & Reputation';
  if (/competitor|competitive|competing/i.test(n)) return 'Competitor Analysis';
  if (/director|citation|local.?listing/i.test(n)) return 'Directory & Citations';
  if (/photo|media|image.?quality/i.test(n)) return 'Photos & Media';
  if (/suburb|service.?area|coverage|geo/i.test(n)) return 'Suburb Coverage';
  return name;
}

function isNoiseLine(line) {
  const t = line.trim();
  if (!t) return true;
  if (/^(Traceback|File "|>>>|\.\.\.|\^{5,}|FileNotFoundError|ModuleNotFoundError|ImportError|SyntaxError|NameError|TypeError|ValueError|KeyError|IndexError|AttributeError)/i.test(t)) return true;
  if (/^(I'll |Let me |Now let me |Perfect[\.\!]|Great[\.\!]|OK,|Alright|Here's what|I need to|First,|Next,|I can see|I found|I notice|Looking at|Let's |I've |I will |Now I|File created|Here are|I would|Based on|This (is|was)|For:|Contents:|Length:)/i.test(t)) return true;
  if (/^(data = |import |from |print\(|with open|json\.|os\.|sys\.|result|output|```)/i.test(t)) return true;
  if (/^>\s*(Assumptions|Data quality|Note:|Data cap|CTR benchmark)/i.test(t)) return true;
  if (/^\s*(def |class |if |for |while |try:|except|finally)/.test(t)) return true;
  return false;
}

function inferSeverity(text) {
  const lower = text.toLowerCase();
  if (/critical|urgent|broken|missing.*sitemap|noindex|error|0\s*score|not indexed/i.test(lower)) return 'Critical';
  if (/high|important|significant|major|poor|failing|blocked/i.test(lower)) return 'High';
  if (/low|minor|optional|consider|nice.?to.?have/i.test(lower)) return 'Low';
  return 'Medium';
}

function extractCurrentRecommended(text) {
  let current = '', recommended = '';
  // "Current: X" / "Recommended: Y" pattern
  const curMatch = text.match(/(?:current|now|existing|actual)[:\s]+([^|,\n]+)/i);
  const recMatch = text.match(/(?:recommend|target|should be|suggested|fix|action)[:\s]+([^|,\n]+)/i);
  if (curMatch) current = curMatch[1].trim().slice(0, 200);
  if (recMatch) recommended = recMatch[1].trim().slice(0, 200);
  return { current, recommended };
}

async function extractFindingsFromReport(reportText, pillar, projectId, auditId) {
  if (!reportText) return [];
  const validCategories = PILLAR_CATEGORIES[pillar] || [];
  if (validCategories.length === 0) return [];

  try {
    console.log(`[findings-extractor] Parsing ${pillar} report (${reportText.length} chars)...`);

    // ===== PRIMARY: Try structured ~~~findings JSON block from agent =====
    const findingsBlockMatch = reportText.match(/~~~findings\s*\n([\s\S]*?)\n~~~/);
    if (findingsBlockMatch) {
      console.log(`[findings-extractor] Found ~~~findings block for ${pillar} (${findingsBlockMatch[1].length} chars)`);
      let parsed = null;
      try {
        parsed = JSON.parse(findingsBlockMatch[1]);
      } catch (e) {
        // Try repair: find last complete object and close array
        const rawJson = findingsBlockMatch[1].trim();
        if (rawJson.startsWith('[')) {
          const lastObj = rawJson.lastIndexOf('}');
          if (lastObj > 0) {
            try { parsed = JSON.parse(rawJson.slice(0, lastObj + 1).replace(/,\s*$/, '') + ']'); } catch (e2) {}
          }
          // Last resort: extract individual objects
          if (!parsed) {
            const objs = rawJson.match(/\{[^{}]*\}/g);
            if (objs && objs.length > 0) {
              parsed = [];
              for (const o of objs) { try { parsed.push(JSON.parse(o)); } catch (e3) {} }
            }
          }
        }
      }

      if (parsed && Array.isArray(parsed) && parsed.length > 0) {
        // Validate and save structured findings
        const validFindings = [];
        for (const f of parsed) {
          if (!f.title || !f.description) continue;
          const cat = validCategories.find(c => c.toLowerCase() === (f.category || '').toLowerCase())
            || validCategories.find(c => c.toLowerCase().includes((f.category || '').toLowerCase().split(' ')[0]))
            || validCategories[0];
          const sev = ['Critical', 'High', 'Medium', 'Low'].find(s => s.toLowerCase() === (f.severity || '').toLowerCase()) || 'Medium';
          validFindings.push({
            pillar,
            category: cat,
            title: (f.title || '').slice(0, 200),
            description: (f.description || '').slice(0, 1000),
            recommendation: (f.recommendation || f.description || '').slice(0, 1000),
            severity: sev,
            current_value: (f.current_value || '').slice(0, 500),
            recommended_value: (f.recommended_value || '').slice(0, 500),
          });
        }

        // Post-process: split multi-suburb/location findings into individual items
        const expanded = [];
        for (const f of validFindings) {
          const title = f.title || '';
          // Match patterns like "for Morley + Guilford", "for Morley, Guilford and Bayswater", "for Morley & Guilford"
          const multiMatch = title.match(/^(.+?)\s+(?:for|:)\s+(.+)$/i);
          if (multiMatch) {
            const baseTitle = multiMatch[1].trim();
            const locationPart = multiMatch[2].trim();
            // Split on + , & "and"
            const locations = locationPart.split(/\s*[+&,]\s*|\s+and\s+/i).map(s => s.trim()).filter(Boolean);
            if (locations.length > 1) {
              for (const loc of locations) {
                expanded.push({ ...f, title: `${baseTitle} for ${loc}`, description: f.description.replace(locationPart, loc) });
              }
              continue;
            }
          }
          expanded.push(f);
        }

        if (expanded.length > 0) {
          const deduped = expanded; // No silent dedup — orchestrator DP tagging handles duplicates visibly

          console.log(`[findings-extractor] Structured block: ${parsed.length} raw → ${deduped.length} valid findings for ${pillar}`);

          // Save to DB
          await pool.query('DELETE FROM action_items WHERE project_id=$1 AND pillar=$2', [projectId, pillar]);
          await pool.query('DELETE FROM audit_findings WHERE project_id=$1 AND pillar=$2', [projectId, pillar]);

          for (const f of deduped) {
            const fRes = await pool.query(
              `INSERT INTO audit_findings (project_id, audit_id, pillar, category, title, description, recommendation, severity, current_value, recommended_value, status)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'approved') RETURNING id`,
              [projectId, auditId, f.pillar, f.category, f.title, f.description, f.recommendation, f.severity, f.current_value, f.recommended_value]
            );
            const findingId = fRes.rows[0].id;
            await pool.query(
              `INSERT INTO action_items (project_id, finding_id, pillar, type, category, title, description, current_value, new_value, severity, status, execution_type)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', 'manual')`,
              [projectId, findingId, f.pillar, f.category, f.category, f.title, f.recommendation || f.description, f.current_value, f.recommended_value, f.severity]
            );
          }
          console.log(`[findings-extractor] Saved ${deduped.length} structured findings for ${pillar}`);
          return deduped;
        }
      }
      console.log(`[findings-extractor] Structured block was empty/invalid for ${pillar}, falling back to markdown parser`);
    } else {
      console.log(`[findings-extractor] No ~~~findings block found for ${pillar}, using markdown parser`);
    }

    // ===== FALLBACK: Deterministic markdown parsing =====

    // ===== STEP 1: Split by markdown headers (mirrors frontend parseReportSections) =====
    const lines = reportText.split('\n');
    const rawSections = [];
    let current = null;

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (isNoiseLine(trimmed) && !current) continue;

      // Match ## or ### headers
      const mdMatch = trimmed.match(/^#{2,3}\s+(?:\d+\.\s+)?(.+)/);
      // Match === TITLE === headers
      const eqMatch = trimmed.match(/^={2,}\s*(.+?)\s*={2,}$/);
      const headerMatch = mdMatch || eqMatch;

      if (headerMatch) {
        const title = headerMatch[1].replace(/\*\*/g, '').trim();
        if (title.length > 3) {
          if (current) rawSections.push(current);
          current = { title, content: [] };
          continue;
        }
      }
      if (current) {
        current.content.push(lines[i]);
      }
    }
    if (current) rawSections.push(current);

    // ===== STEP 2: Normalize section titles + filter =====
    const skipPatterns = [/^overview$/i, /^introduction$/i, /^methodology$/i, /^data.*source/i, /^appendix/i];
    const sections = [];
    for (const s of rawSections) {
      const normalized = serverNormalizeSection(s.title);
      if (normalized === 'Summary') continue; // Skip summary/action plan sections — they duplicate findings
      if (skipPatterns.some(p => p.test(s.title))) continue;
      sections.push({ title: normalized, content: s.content });
    }

    // Merge sections with same normalized title
    const mergedMap = {};
    const mergedOrder = [];
    for (const s of sections) {
      if (mergedMap[s.title]) {
        mergedMap[s.title].content.push('', ...s.content);
      } else {
        mergedMap[s.title] = s;
        mergedOrder.push(s.title);
      }
    }

    // ===== STEP 3: Map normalized titles → valid pillar categories =====
    function matchCategory(normalizedTitle) {
      // Direct match
      if (validCategories.includes(normalizedTitle)) return normalizedTitle;
      // Case-insensitive match
      const lower = normalizedTitle.toLowerCase();
      const found = validCategories.find(c => c.toLowerCase() === lower);
      if (found) return found;
      // Partial match
      const partial = validCategories.find(c => lower.includes(c.toLowerCase().split(' ')[0]) || c.toLowerCase().includes(lower.split(' ')[0]));
      if (partial) return partial;
      return null;
    }

    // ===== STEP 4: Parse each section's content into individual findings =====
    const allFindings = [];

    for (const title of mergedOrder) {
      const section = mergedMap[title];
      const category = matchCategory(section.title);
      if (!category) {
        console.log(`[findings-extractor-deterministic] Skipping unmapped section: "${section.title}"`);
        continue;
      }

      const contentLines = section.content;
      let inTable = false;
      let tableHeaders = [];
      let separatorSeen = false;

      for (let i = 0; i < contentLines.length; i++) {
        const line = contentLines[i];
        const trimmed = line.trim();
        if (!trimmed || isNoiseLine(trimmed)) continue;

        // ---- TABLE DETECTION ----
        if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
          const cells = trimmed.split('|').map(c => c.trim()).filter(c => c);
          if (!inTable) {
            // Could be header row
            if (cells.length >= 2) {
              tableHeaders = cells;
              inTable = true;
              separatorSeen = false;
              continue;
            }
          }
          // Separator row (|---|---|)
          if (inTable && !separatorSeen && /^[\s|:-]+$/.test(trimmed.replace(/\|/g, ' ').replace(/-/g, ' ').replace(/:/g, ' '))) {
            separatorSeen = true;
            continue;
          }
          // Data row
          if (inTable && separatorSeen && cells.length >= 2) {
            // Each table row = one finding
            const titleCol = cells[0] || '';
            const actionCol = cells.find((c, idx) => idx > 0 && tableHeaders[idx] && /fix|action|recommend|resolution|what.?to.?do/i.test(tableHeaders[idx])) || '';
            const sevCol = cells.find((c, idx) => idx > 0 && tableHeaders[idx] && /priority|severity/i.test(tableHeaders[idx])) || '';
            const statusCol = cells.find((c, idx) => idx > 0 && tableHeaders[idx] && /status|current/i.test(tableHeaders[idx])) || '';

            const findingTitle = titleCol.replace(/\*\*/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim();
            if (findingTitle && findingTitle.length > 3 && !/^-+$/.test(findingTitle)) {
              const desc = cells.slice(1).filter(c => c !== actionCol && c !== sevCol).join(' — ').replace(/\*\*/g, '');
              allFindings.push({
                pillar,
                category,
                title: findingTitle.slice(0, 200),
                description: desc.slice(0, 1000) || findingTitle,
                recommendation: (actionCol || desc).replace(/\*\*/g, '').slice(0, 1000),
                severity: sevCol ? inferSeverity(sevCol) : inferSeverity(findingTitle + ' ' + desc),
                current_value: statusCol.replace(/\*\*/g, '').slice(0, 500),
                recommended_value: (actionCol || '').replace(/\*\*/g, '').slice(0, 500),
              });
            }
            continue;
          }
          continue;
        } else {
          // Exiting table
          if (inTable) { inTable = false; tableHeaders = []; separatorSeen = false; }
        }

        // ---- BULLET POINTS / NUMBERED ITEMS ----
        const bulletMatch = trimmed.match(/^(?:[-*•]|\d+[.)]\s)\s*(.+)/);
        if (bulletMatch) {
          const bulletText = bulletMatch[1].replace(/\*\*/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim();
          // Skip sub-bullets that are just descriptions of the parent (indented with 2+ spaces)
          const indent = line.match(/^(\s*)/)[1].length;
          if (indent >= 4 && allFindings.length > 0 && allFindings[allFindings.length - 1].category === category) {
            // Append to previous finding's description
            const prev = allFindings[allFindings.length - 1];
            if (prev.description.length < 900) prev.description += ' | ' + bulletText;
            continue;
          }

          if (bulletText.length > 10) {
            const { current, recommended } = extractCurrentRecommended(bulletText);
            allFindings.push({
              pillar,
              category,
              title: bulletText.split(/[.!?—|]/)[0].trim().slice(0, 200) || bulletText.slice(0, 200),
              description: bulletText.slice(0, 1000),
              recommendation: recommended || bulletText.slice(0, 1000),
              severity: inferSeverity(bulletText),
              current_value: current,
              recommended_value: recommended,
            });
          }
          continue;
        }

        // ---- BOLD STANDALONE LINES (often sub-findings) ----
        const boldMatch = trimmed.match(/^\*\*(.+?)\*\*[:\s]*(.*)$/);
        if (boldMatch && boldMatch[1].length > 10) {
          const boldTitle = boldMatch[1].trim();
          const boldDesc = boldMatch[2] || '';
          // Check if next lines are description (non-bullet, non-header)
          let extraDesc = '';
          for (let j = i + 1; j < Math.min(i + 3, contentLines.length); j++) {
            const nextTrimmed = contentLines[j].trim();
            if (!nextTrimmed || nextTrimmed.startsWith('#') || nextTrimmed.startsWith('|') || /^[-*•]|\d+[.)]/.test(nextTrimmed)) break;
            extraDesc += ' ' + nextTrimmed;
          }
          const fullDesc = (boldDesc + extraDesc).trim();
          if (fullDesc.length > 5 || boldTitle.length > 15) {
            const { current, recommended } = extractCurrentRecommended(boldTitle + ' ' + fullDesc);
            allFindings.push({
              pillar,
              category,
              title: boldTitle.slice(0, 200),
              description: (fullDesc || boldTitle).slice(0, 1000),
              recommendation: (recommended || fullDesc || boldTitle).slice(0, 1000),
              severity: inferSeverity(boldTitle + ' ' + fullDesc),
              current_value: current,
              recommended_value: recommended,
            });
          }
          continue;
        }
      }
    }

    console.log(`[findings-extractor-deterministic] Parsed ${allFindings.length} findings from ${mergedOrder.length} sections (${pillar})`);

    // No silent dedup — pass everything through, orchestrator DP tagging handles duplicates visibly
    const deduped = allFindings;

    console.log(`[findings-extractor-deterministic] Total: ${deduped.length} findings for ${pillar}`);

    // ===== STEP 6: Save to DB =====
    if (deduped.length > 0) {
      await pool.query('DELETE FROM action_items WHERE project_id=$1 AND pillar=$2', [projectId, pillar]);
      await pool.query('DELETE FROM audit_findings WHERE project_id=$1 AND pillar=$2', [projectId, pillar]);

      for (const f of deduped) {
        const fRes = await pool.query(
          `INSERT INTO audit_findings (project_id, audit_id, pillar, category, title, description, recommendation, severity, current_value, recommended_value, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'approved') RETURNING id`,
          [projectId, auditId, f.pillar, f.category, f.title, f.description, f.recommendation, f.severity, f.current_value, f.recommended_value]
        );
        const findingId = fRes.rows[0].id;

        await pool.query(
          `INSERT INTO action_items (project_id, finding_id, pillar, type, category, title, description, current_value, new_value, severity, status, execution_type)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', 'manual')`,
          [projectId, findingId, f.pillar, f.category, f.category, f.title, f.recommendation || f.description, f.current_value, f.recommended_value, f.severity]
        );
      }
      console.log(`[findings-extractor-deterministic] Saved ${deduped.length} findings + action items for ${pillar} (project ${projectId})`);
    }

    return deduped;
  } catch (e) {
    console.error(`[findings-extractor-deterministic] Error parsing ${pillar} findings:`, e.message);
    return [];
  }
}

// Re-extract findings from an existing completed agent audit (for backfilling)
app.post('/api/projects/:projectId/audits/:pillar/extract-findings', async (req, res) => {
  const { projectId, pillar } = req.params;
  try {
    const auditRes = await pool.query(
      `SELECT id, audit_data FROM audits WHERE project_id=$1 AND pillar=$2 AND status='completed' ORDER BY completed_at DESC LIMIT 1`,
      [projectId, pillar]
    );
    if (auditRes.rows.length === 0) return res.status(404).json({ error: `No completed ${pillar} audit found` });
    const audit = auditRes.rows[0];
    const auditData = typeof audit.audit_data === 'string' ? JSON.parse(audit.audit_data) : audit.audit_data;
    const reportText = auditData?.report;
    if (!reportText) return res.status(400).json({ error: 'Audit has no report text' });

    const findings = await extractFindingsFromReport(reportText, pillar, parseInt(projectId), audit.id);
    res.json({ extracted: findings.length, findings });
  } catch (e) {
    console.error(`[extract-findings] Error:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==================== FRONTEND-DRIVEN FINDINGS SYNC (Source of Truth) ====================
// Frontend extracts findings from parsed report sections (same code that renders them)
// and POSTs here. This guarantees 100% match between displayed items and DB.
app.post('/api/projects/:projectId/audits/:pillar/sync-findings', async (req, res) => {
  const { projectId } = req.params;
  let { pillar } = req.params;
  const { findings } = req.body;
  if (!findings || !Array.isArray(findings)) return res.status(400).json({ error: 'findings array required' });

  // Map frontend pillar names to DB pillar names
  const PILLAR_DB_MAP = { gsc: 'gsc_agent', gbp: 'gbp_external', gbp_external: 'gbp_external', gsc_agent: 'gsc_agent', website: 'website' };
  const dbPillar = PILLAR_DB_MAP[pillar] || pillar;

  try {
    // Get the latest completed audit ID for this pillar
    const auditRes = await pool.query(
      `SELECT id FROM audits WHERE project_id=$1 AND pillar=$2 AND status='completed' ORDER BY completed_at DESC LIMIT 1`,
      [projectId, dbPillar]
    );
    if (auditRes.rows.length === 0) return res.status(404).json({ error: `No completed ${dbPillar} audit found` });
    const auditId = auditRes.rows[0].id;

    // Check if we already synced for this audit (avoid re-syncing on every page load)
    const existingCount = await pool.query(
      `SELECT COUNT(*) as cnt FROM audit_findings WHERE project_id=$1 AND pillar=$2 AND audit_id=$3`,
      [projectId, dbPillar, auditId]
    );
    const existing = parseInt(existingCount.rows[0].cnt);
    if (existing === findings.length && existing > 0) {
      // Already synced with same count — skip
      return res.json({ synced: existing, skipped: true });
    }

    // Clear old findings + action items for this pillar
    await pool.query('DELETE FROM action_items WHERE project_id=$1 AND pillar=$2', [projectId, dbPillar]);
    await pool.query('DELETE FROM audit_findings WHERE project_id=$1 AND pillar=$2', [projectId, dbPillar]);

    // Insert all findings 1:1
    let saved = 0;
    for (const f of findings) {
      const fRes = await pool.query(
        `INSERT INTO audit_findings (project_id, audit_id, pillar, category, title, description, recommendation, severity, current_value, recommended_value, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'approved') RETURNING id`,
        [projectId, auditId, dbPillar, f.category || 'Uncategorized', f.title, f.description || '', f.recommendation || '', f.severity || 'Medium', f.current_value || '', f.recommended_value || '']
      );
      const findingId = fRes.rows[0].id;
      await pool.query(
        `INSERT INTO action_items (project_id, finding_id, pillar, type, category, title, description, current_value, new_value, severity, status, execution_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', 'manual')`,
        [projectId, findingId, dbPillar, f.category || 'Uncategorized', f.category || 'Uncategorized', f.title, f.recommendation || f.description || '', f.current_value || '', f.recommended_value || '', f.severity || 'Medium']
      );
      saved++;
    }

    console.log(`[sync-findings] Frontend synced ${saved} findings for ${dbPillar} (audit ${auditId})`);
    res.json({ synced: saved, auditId });
  } catch (e) {
    console.error(`[sync-findings] Error:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==================== EXTERNAL GBP AUDIT (Managed Agent — Sonnet + Web Search) ====================

app.get('/api/projects/:projectId/audits/gbp-external/status', async (req, res) => {
  const { projectId } = req.params;
  try {
    const result = await pool.query(
      `SELECT id, status, audit_data, started_at, completed_at FROM audits WHERE project_id=$1 AND pillar='gbp_external' ORDER BY started_at DESC LIMIT 1`,
      [projectId]
    );
    if (result.rows.length === 0) return res.json({ status: 'none' });
    const audit = result.rows[0];
    const data = typeof audit.audit_data === 'string' ? JSON.parse(audit.audit_data) : (audit.audit_data || {});
    res.json({
      status: audit.status,
      report: data.report || null,
      error: data.error || null,
      startedAt: audit.started_at,
      completedAt: audit.completed_at,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects/:projectId/audits/gbp-external/run', async (req, res) => {
  const { projectId } = req.params;
  try {
    const proj = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    if (proj.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = proj.rows[0];

    // Delete old external findings
    await pool.query(`DELETE FROM audit_findings WHERE project_id=$1 AND pillar='gbp_external'`, [projectId]);
    await pool.query(`UPDATE audits SET status='failed', completed_at=NOW(), audit_data='{"error":"Superseded by new audit run"}' WHERE project_id=$1 AND pillar='gbp_external' AND status='running'`, [projectId]);

    const auditRes = await pool.query(
      `INSERT INTO audits (project_id, pillar, status, started_at) VALUES ($1, 'gbp_external', 'running', NOW()) RETURNING id`,
      [projectId]
    );
    const auditId = auditRes.rows[0].id;

    const domain = (project.domain || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    const businessName = project.business_name || project.name || '';
    const location = project.location || '';
    const industry = project.industry || '';
    const serviceAreas = project.service_areas || [];

    // Get extension-scraped data if available (for context)
    let extensionProfile = null;
    try {
      const extData = await pool.query(
        `SELECT config FROM project_integrations WHERE project_id=$1 AND kind='gbp_profile'`, [projectId]
      );
      if (extData.rows.length > 0) {
        extensionProfile = typeof extData.rows[0].config === 'string' ? JSON.parse(extData.rows[0].config) : extData.rows[0].config;
      }
    } catch (e) {}

    const gbpAgentId = process.env.GBP_AGENT_ID;
    const gbpEnvId = process.env.GBP_ENVIRONMENT_ID;

    if (!anthropic || !gbpAgentId || !gbpEnvId) {
      await pool.query('UPDATE audits SET status=$1, completed_at=NOW() WHERE id=$2', ['failed', auditId]);
      return res.status(500).json({ error: 'GBP Agent not configured. Set GBP_AGENT_ID and GBP_ENVIRONMENT_ID.' });
    }

    console.log(`[gbp-external] Starting managed agent audit for "${businessName}" in ${location}`);

    const userPrompt = `Conduct a full Google Business Profile audit for: ${businessName}, ${location}${domain ? `, website: ${domain}` : ''}${industry ? `, industry: ${industry}` : ''}`;

    // Run the managed agent via Sessions API (raw fetch — SDK may not have beta.sessions)
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const apiBase = 'https://api.anthropic.com/v1';
    const agentHeaders = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'managed-agents-2026-04-01',
    };

    console.log(`[gbp-external] Creating session for agent ${gbpAgentId}...`);

    const sessionResp = await fetch(`${apiBase}/sessions`, {
      method: 'POST',
      headers: agentHeaders,
      body: JSON.stringify({ agent: gbpAgentId, environment_id: gbpEnvId }),
    });
    if (!sessionResp.ok) {
      const errBody = await sessionResp.text();
      throw new Error(`Session create failed (${sessionResp.status}): ${errBody}`);
    }
    const session = await sessionResp.json();
    console.log(`[gbp-external] Session created: ${session.id}`);

    res.json({ auditId, status: 'running', sessionId: session.id });

    (async () => {
      try {
        await waitForSessionReady(apiBase, agentHeaders, session.id, 'gbp-external');
        await sendAgentMessage(apiBase, agentHeaders, session.id, userPrompt, 'gbp-external');
        const finalText = await pollAgentSession(apiBase, agentHeaders, session.id, 'gbp-external');

        const displayReport = finalText.replace(/~~~findings[\s\S]*?~~~/g, '').trim();
        await pool.query('UPDATE audits SET status=$1, completed_at=NOW(), audit_data=$2 WHERE id=$3',
          ['completed', JSON.stringify({ report: displayReport, sessionId: session.id }), auditId]);
        console.log(`[gbp-external] Report stored (${displayReport.length} chars)`);

        // PASS 2: Follow-up extraction
        const extractionText = await extractFindingsViaFollowUp(apiBase, agentHeaders, session.id, 'gbp_external', 'gbp-external');
        const textForExtraction = extractionText || finalText;
        const extracted = await extractFindingsFromReport(textForExtraction, 'gbp_external', projectId, auditId);
        console.log(`[gbp-external] Extracted ${extracted.length} findings`);
      } catch (bgErr) {
        console.error('[gbp-external] Background error:', bgErr.message);
        try { await pool.query(`UPDATE audits SET status='failed', completed_at=NOW(), audit_data=$1 WHERE id=$2`,
          [JSON.stringify({ error: bgErr.message }), auditId]); } catch (e2) {}
      }
    })();

  } catch (e) {
    console.error('[gbp-external] Error:', e.message);
    try { await pool.query(`UPDATE audits SET status='failed', completed_at=NOW() WHERE project_id=$1 AND pillar='gbp_external' AND status='running'`, [projectId]); } catch (e2) {}
    res.status(500).json({ error: e.message });
  }
});

// ==================== WEBSITE AGENT AUDIT (Managed Agent) ====================

app.get('/api/projects/:projectId/audits/website-agent/status', async (req, res) => {
  const { projectId } = req.params;
  try {
    const result = await pool.query(
      `SELECT id, status, audit_data, started_at, completed_at FROM audits WHERE project_id=$1 AND pillar='website' ORDER BY started_at DESC LIMIT 1`,
      [projectId]
    );
    if (result.rows.length === 0) return res.json({ status: 'none' });
    const audit = result.rows[0];
    const data = typeof audit.audit_data === 'string' ? JSON.parse(audit.audit_data) : (audit.audit_data || {});
    res.json({
      status: audit.status,
      report: data.report || null,
      error: data.error || null,
      startedAt: audit.started_at,
      completedAt: audit.completed_at,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects/:projectId/audits/website-agent/run', async (req, res) => {
  const { projectId } = req.params;
  try {
    const proj = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    if (proj.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = proj.rows[0];

    await pool.query(`DELETE FROM audit_findings WHERE project_id=$1 AND pillar='website'`, [projectId]);
    await pool.query(`UPDATE audits SET status='failed', completed_at=NOW(), audit_data='{"error":"Superseded by new audit run"}' WHERE project_id=$1 AND pillar='website' AND status='running'`, [projectId]);

    const auditRes = await pool.query(
      `INSERT INTO audits (project_id, pillar, status, started_at) VALUES ($1, 'website', 'running', NOW()) RETURNING id`,
      [projectId]
    );
    const auditId = auditRes.rows[0].id;

    const domain = (project.domain || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    const businessName = project.business_name || project.name || '';
    const location = project.location || '';
    const industry = project.industry || '';

    const websiteAgentId = process.env.WEBSITE_AGENT_ID || process.env.WEBSITE_AUDIT_AGENT;
    const envId = process.env.GBP_ENVIRONMENT_ID; // shared environment

    if (!anthropic || !websiteAgentId || !envId) {
      await pool.query('UPDATE audits SET status=$1, completed_at=NOW() WHERE id=$2', ['failed', auditId]);
      return res.status(500).json({ error: 'Website Agent not configured. Set WEBSITE_AGENT_ID env var.' });
    }

    console.log(`[website-agent] Starting audit for "${domain}"`);

    const userPrompt = `Conduct a comprehensive website SEO audit for: ${domain}${businessName ? ` (${businessName})` : ''}${location ? `, located in ${location}` : ''}${industry ? `, industry: ${industry}` : ''}. Simulate Googlebot crawling the homepage and key service/location pages. Analyze crawlability, renderability, indexability, content quality, Core Web Vitals, and competitive SERP standing. Use pipe-delimited markdown tables (| Col | Col |) for all data tables.`;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    const apiBase = 'https://api.anthropic.com/v1';
    const agentHeaders = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'managed-agents-2026-04-01',
    };

    const sessionResp = await fetch(`${apiBase}/sessions`, {
      method: 'POST',
      headers: agentHeaders,
      body: JSON.stringify({ agent: websiteAgentId, environment_id: envId }),
    });
    if (!sessionResp.ok) {
      const errBody = await sessionResp.text();
      throw new Error(`Session create failed (${sessionResp.status}): ${errBody}`);
    }
    const session = await sessionResp.json();
    console.log(`[website-agent] Session created: ${session.id}`);

    res.json({ auditId, status: 'running', sessionId: session.id });

    (async () => {
      try {
        await waitForSessionReady(apiBase, agentHeaders, session.id, 'website-agent');
        await sendAgentMessage(apiBase, agentHeaders, session.id, userPrompt, 'website-agent');
        const finalText = await pollAgentSession(apiBase, agentHeaders, session.id, 'website-agent');

        // Store report for display (strip any inline findings block)
        const displayReport = finalText.replace(/~~~findings[\s\S]*?~~~/g, '').trim();
        await pool.query('UPDATE audits SET status=$1, completed_at=NOW(), audit_data=$2 WHERE id=$3',
          ['completed', JSON.stringify({ report: displayReport, sessionId: session.id }), auditId]);
        console.log(`[website-agent] Report stored (${displayReport.length} chars)`);

        // PASS 2: Send follow-up message asking agent to enumerate every finding as JSON
        const extractionText = await extractFindingsViaFollowUp(apiBase, agentHeaders, session.id, 'website', 'website-agent');
        const textForExtraction = extractionText || finalText; // fall back to original report if follow-up fails

        // Extract findings from follow-up response (or original report as fallback)
        const extracted = await extractFindingsFromReport(textForExtraction, 'website', projectId, auditId);
        console.log(`[website-agent] Extracted ${extracted.length} findings`);
      } catch (bgErr) {
        console.error('[website-agent] Background error:', bgErr.message);
        try { await pool.query(`UPDATE audits SET status='failed', completed_at=NOW(), audit_data=$1 WHERE id=$2`,
          [JSON.stringify({ error: bgErr.message }), auditId]); } catch (e2) {}
      }
    })();

  } catch (e) {
    console.error('[website-agent] Error:', e.message);
    try { await pool.query(`UPDATE audits SET status='failed', completed_at=NOW() WHERE project_id=$1 AND pillar='website' AND status='running'`, [projectId]); } catch (e2) {}
    res.status(500).json({ error: e.message });
  }
});

// ==================== GSC AGENT AUDIT (Managed Agent) ====================

app.get('/api/projects/:projectId/audits/gsc-agent/status', async (req, res) => {
  const { projectId } = req.params;
  try {
    const result = await pool.query(
      `SELECT id, status, audit_data, started_at, completed_at FROM audits WHERE project_id=$1 AND pillar='gsc_agent' ORDER BY started_at DESC LIMIT 1`,
      [projectId]
    );
    if (result.rows.length === 0) return res.json({ status: 'none' });
    const audit = result.rows[0];
    const data = typeof audit.audit_data === 'string' ? JSON.parse(audit.audit_data) : (audit.audit_data || {});
    res.json({
      status: audit.status,
      report: data.report || null,
      error: data.error || null,
      startedAt: audit.started_at,
      completedAt: audit.completed_at,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects/:projectId/audits/gsc-agent/run', async (req, res) => {
  const { projectId } = req.params;
  try {
    const proj = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    if (proj.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = proj.rows[0];

    await pool.query(`DELETE FROM audit_findings WHERE project_id=$1 AND pillar='gsc_agent'`, [projectId]);
    // Mark any stuck running audits as failed
    await pool.query(`UPDATE audits SET status='failed', completed_at=NOW(), audit_data='{"error":"Superseded by new audit run"}' WHERE project_id=$1 AND pillar='gsc_agent' AND status='running'`, [projectId]);

    const auditRes = await pool.query(
      `INSERT INTO audits (project_id, pillar, status, started_at) VALUES ($1, 'gsc_agent', 'running', NOW()) RETURNING id`,
      [projectId]
    );
    const auditId = auditRes.rows[0].id;

    const domain = (project.domain || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    const gscProperty = project.gsc_property || '';

    const gscAgentId = process.env.GSC_AGENT_ID || process.env.GSC_AUDIT_AGENT;
    const envId = process.env.GBP_ENVIRONMENT_ID; // shared environment

    if (!anthropic || !gscAgentId || !envId) {
      await pool.query('UPDATE audits SET status=$1, completed_at=NOW() WHERE id=$2', ['failed', auditId]);
      return res.status(500).json({ error: 'GSC Agent not configured. Set GSC_AGENT_ID env var.' });
    }

    // Fetch GSC data to feed to agent
    let gscData = null;
    try {
      const userId = 1; // TODO: get from auth
      const accessToken = await getGscAccessToken(userId);
      if (accessToken && gscProperty) {
        const property = gscProperty;
        // Fetch last 28 days of search analytics
        const analyticsResp = await fetch('https://www.googleapis.com/webmasters/v3/sites/' + encodeURIComponent(property) + '/searchAnalytics/query', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            startDate: new Date(Date.now() - 28 * 86400000).toISOString().split('T')[0],
            endDate: new Date().toISOString().split('T')[0],
            dimensions: ['query', 'page'],
            rowLimit: 500,
          }),
        });
        if (analyticsResp.ok) {
          gscData = await analyticsResp.json();
          console.log(`[gsc-agent] Fetched ${(gscData.rows || []).length} GSC rows`);
        }
      }
    } catch (e) {
      console.log(`[gsc-agent] Could not fetch GSC data: ${e.message}`);
    }

    console.log(`[gsc-agent] Starting audit for "${domain}"`);

    let userPrompt = `Conduct a comprehensive Google Search Console audit for: ${domain}`;
    if (gscData && gscData.rows && gscData.rows.length > 0) {
      // Summarize top data for the agent
      const topRows = gscData.rows.slice(0, 200).map(r => ({
        query: r.keys[0],
        page: r.keys[1],
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: (r.ctr * 100).toFixed(1) + '%',
        position: r.position.toFixed(1),
      }));
      userPrompt += `\n\nHere is the GSC search analytics data (last 28 days, top 200 query+page combinations):\n\`\`\`json\n${JSON.stringify(topRows, null, 2)}\n\`\`\`\n\nAnalyze this data to find: Quick Wins (position 4-20 with good impressions), Low CTR pages, Keyword Cannibalization (same query ranking for multiple pages), Zero Click queries, Underperforming Pages, Brand Dependency. Use pipe-delimited markdown tables for all findings.`;
    } else {
      userPrompt += `\n\nNote: GSC API data was not available. Analyze the site externally — check indexing, keyword targeting, content gaps, and SERP presence. Use pipe-delimited markdown tables for all findings.`;
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    const apiBase = 'https://api.anthropic.com/v1';
    const agentHeaders = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'managed-agents-2026-04-01',
    };

    const sessionResp = await fetch(`${apiBase}/sessions`, {
      method: 'POST',
      headers: agentHeaders,
      body: JSON.stringify({ agent: gscAgentId, environment_id: envId }),
    });
    if (!sessionResp.ok) {
      const errBody = await sessionResp.text();
      throw new Error(`Session create failed (${sessionResp.status}): ${errBody}`);
    }
    const session = await sessionResp.json();
    console.log(`[gsc-agent] Session created: ${session.id}`);

    res.json({ auditId, status: 'running', sessionId: session.id });

    // Store raw GSC data for structured orchestrator use
    const gscRawRows = (gscData && gscData.rows) ? gscData.rows.slice(0, 200).map(r => ({
      query: r.keys[0], page: r.keys[1], clicks: r.clicks, impressions: r.impressions,
      ctr: parseFloat((r.ctr * 100).toFixed(1)), position: parseFloat(r.position.toFixed(1)),
    })) : null;

    (async () => {
      try {
        await waitForSessionReady(apiBase, agentHeaders, session.id, 'gsc-agent');
        await sendAgentMessage(apiBase, agentHeaders, session.id, userPrompt, 'gsc-agent');
        const finalText = await pollAgentSession(apiBase, agentHeaders, session.id, 'gsc-agent');

        const displayReport = finalText.replace(/~~~findings[\s\S]*?~~~/g, '').trim();
        await pool.query('UPDATE audits SET status=$1, completed_at=NOW(), audit_data=$2 WHERE id=$3',
          ['completed', JSON.stringify({ report: displayReport, sessionId: session.id, raw_gsc_data: gscRawRows }), auditId]);
        console.log(`[gsc-agent] Report stored (${displayReport.length} chars) with ${gscRawRows ? gscRawRows.length : 0} raw GSC rows`);

        // PASS 2: Follow-up extraction
        const extractionText = await extractFindingsViaFollowUp(apiBase, agentHeaders, session.id, 'gsc_agent', 'gsc-agent');
        const textForExtraction = extractionText || finalText;
        const extracted = await extractFindingsFromReport(textForExtraction, 'gsc_agent', projectId, auditId);
        console.log(`[gsc-agent] Extracted ${extracted.length} findings`);
      } catch (bgErr) {
        console.error('[gsc-agent] Background error:', bgErr.message);
        try { await pool.query(`UPDATE audits SET status='failed', completed_at=NOW(), audit_data=$1 WHERE id=$2`,
          [JSON.stringify({ error: bgErr.message }), auditId]); } catch (e2) {}
      }
    })();

  } catch (e) {
    console.error('[gsc-agent] Error:', e.message);
    try { await pool.query(`UPDATE audits SET status='failed', completed_at=NOW() WHERE project_id=$1 AND pillar='gsc_agent' AND status='running'`, [projectId]); } catch (e2) {}
    res.status(500).json({ error: e.message });
  }
});

// ==================== TECHNICAL AUDIT (AI-Powered) ====================

app.post('/api/projects/:projectId/audits/technical/run', async (req, res) => {
  const { projectId } = req.params;
  try {
    const proj = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    if (proj.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = proj.rows[0];
    const wpUrl = project.wordpress_url;
    const domain = (project.website || project.domain || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    const siteUrl = wpUrl || (domain ? `https://${domain}` : '');

    if (!siteUrl) return res.status(400).json({ error: 'No website URL configured. Set it in Project Settings.' });

    // Clean up old findings
    await pool.query(`DELETE FROM audit_findings WHERE project_id=$1 AND pillar='technical'`, [projectId]);

    const auditRes = await pool.query(
      `INSERT INTO audits (project_id, pillar, status, started_at) VALUES ($1, 'technical', 'running', NOW()) RETURNING id`,
      [projectId]
    );
    const auditId = auditRes.rows[0].id;
    const baseUrl = siteUrl.replace(/\/$/, '');

    console.log(`[tech-audit] Starting AI-powered audit for ${baseUrl}`);

    // ===== PHASE 1: Crawl site data =====
    const crawlData = {
      https: null, headers: {}, robots: null, sitemap: null,
      pages: [], sitemapUrls: [], robotsTxt: ''
    };

    // 1. Homepage fetch + headers
    try {
      const resp = await fetch(baseUrl, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
      crawlData.https = { finalUrl: resp.url, isHttps: resp.url.startsWith('https://'), status: resp.status };
      crawlData.headers = {
        hsts: resp.headers.get('strict-transport-security') || null,
        xFrameOptions: resp.headers.get('x-frame-options') || null,
        contentSecurityPolicy: resp.headers.get('content-security-policy') ? 'present' : null,
        server: resp.headers.get('server') || null,
      };
      const homeHtml = await resp.text();
      crawlData.homepageSize = Math.round(homeHtml.length / 1024);
      crawlData.httpRefs = (homeHtml.match(/src=["']http:\/\//gi) || []).length;
    } catch (e) {
      crawlData.https = { error: e.message };
    }

    // 2. Robots.txt
    try {
      const robotsResp = await fetch(`${baseUrl}/robots.txt`, { signal: AbortSignal.timeout(10000) });
      if (robotsResp.ok) {
        crawlData.robotsTxt = await robotsResp.text();
        crawlData.robots = {
          exists: true,
          hasSitemap: crawlData.robotsTxt.toLowerCase().includes('sitemap:'),
          length: crawlData.robotsTxt.length,
        };
        // Check wildcard user-agent blocking
        const wildcardBlocks = crawlData.robotsTxt.split(/User-agent:\s*/i);
        const wildcardSection = wildcardBlocks.find(b => b.match(/^\*\s*$/m) || b.match(/^\*\n/));
        if (wildcardSection) {
          crawlData.robots.wildcardDisallowAll = !!wildcardSection.match(/^Disallow:\s*\/\s*$/m);
          crawlData.robots.wildcardAllowAll = !!wildcardSection.match(/^Allow:\s*\/\s*$/m);
        }
      } else {
        crawlData.robots = { exists: false, status: robotsResp.status };
      }
    } catch (e) { crawlData.robots = { exists: false, error: e.message }; }

    // 3. Sitemap discovery
    try {
      let sitemapResp = await fetch(`${baseUrl}/sitemap_index.xml`, { signal: AbortSignal.timeout(10000) });
      if (!sitemapResp.ok) sitemapResp = await fetch(`${baseUrl}/sitemap.xml`, { signal: AbortSignal.timeout(10000) });
      
      if (sitemapResp.ok) {
        const sitemapXml = await sitemapResp.text();
        const allLocs = (sitemapXml.match(/<loc>([^<]+)<\/loc>/g) || []).map(m => m.replace(/<\/?loc>/g, ''));
        
        // Check if this is a sitemap index
        const isIndex = sitemapXml.includes('<sitemapindex');
        if (isIndex) {
          crawlData.sitemap = { exists: true, type: 'index', subSitemaps: allLocs.length };
          // Fetch first sub-sitemap for actual URLs
          if (allLocs.length > 0) {
            try {
              const subResp = await fetch(allLocs[0], { signal: AbortSignal.timeout(10000) });
              if (subResp.ok) {
                const subXml = await subResp.text();
                crawlData.sitemapUrls = (subXml.match(/<loc>([^<]+)<\/loc>/g) || []).map(m => m.replace(/<\/?loc>/g, ''));
              }
            } catch (e) {}
          }
        } else {
          crawlData.sitemapUrls = allLocs.filter(u => !u.endsWith('.xml'));
          crawlData.sitemap = { exists: true, type: 'single', urlCount: crawlData.sitemapUrls.length };
        }
      } else {
        crawlData.sitemap = { exists: false };
      }
    } catch (e) { crawlData.sitemap = { exists: false, error: e.message }; }

    console.log(`[tech-audit] Sitemap: ${crawlData.sitemapUrls.length} URLs found`);

    // 4. Crawl sample pages — extract SEO data from each
    const pagesToCrawl = crawlData.sitemapUrls.length > 0
      ? crawlData.sitemapUrls.slice(0, 15)
      : [baseUrl, `${baseUrl}/contact`, `${baseUrl}/about`, `${baseUrl}/services`];

    for (const pageUrl of pagesToCrawl) {
      try {
        const pageResp = await fetch(pageUrl, { signal: AbortSignal.timeout(10000) });
        if (!pageResp.ok) {
          crawlData.pages.push({ url: pageUrl, status: pageResp.status, error: true });
          continue;
        }
        const html = await pageResp.text();
        const slug = pageUrl.replace(baseUrl, '').replace(/^\/|\/$/g, '') || 'home';

        // Extract meta title
        const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/is);
        const metaTitle = titleMatch ? titleMatch[1].trim() : null;

        // Extract meta description
        const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)/i) ||
                          html.match(/<meta[^>]*content=["']([^"']*)[^>]*name=["']description["']/i);
        const metaDesc = descMatch ? descMatch[1].trim() : null;

        // Extract canonical
        const canonicalMatch = html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']*)/i);
        const canonical = canonicalMatch ? canonicalMatch[1] : null;

        // Extract OG tags
        const ogTitle = html.match(/property=["']og:title["'][^>]*content=["']([^"']*)/i)?.[1] || null;
        const ogDesc = html.match(/property=["']og:description["'][^>]*content=["']([^"']*)/i)?.[1] || null;
        const ogImage = html.match(/property=["']og:image["'][^>]*content=["']([^"']*)/i)?.[1] || null;

        // Schema markup
        const schemaMatches = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
        let schemaTypes = [];
        for (const sm of schemaMatches) {
          try {
            const jsonStr = sm.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '');
            const parsed = JSON.parse(jsonStr);
            if (parsed['@type']) schemaTypes.push(parsed['@type']);
            if (parsed['@graph']) schemaTypes.push(...parsed['@graph'].map(g => g['@type']).filter(Boolean));
          } catch (e) {}
        }
        const hasItemtype = !!html.match(/itemtype=/i);

        // Viewport
        const hasViewport = !!html.match(/name=["']viewport["']/i);

        // H1 tags
        const h1Matches = html.match(/<h1[^>]*>(.*?)<\/h1>/gis) || [];
        const h1s = h1Matches.map(h => h.replace(/<[^>]+>/g, '').trim()).filter(Boolean);

        // Internal links
        const linkMatches = html.match(/href=["']([^"'#]+)["']/gi) || [];
        const internalLinks = linkMatches.filter(l => {
          const href = l.replace(/href=["']/i, '').replace(/["']$/, '');
          return (href.includes(domain) || (href.startsWith('/') && !href.startsWith('//'))) && !href.match(/\.(css|js|png|jpg|gif|svg|ico|woff|pdf)(\?|$)/i);
        }).length;
        const externalLinks = linkMatches.filter(l => {
          const href = l.replace(/href=["']/i, '').replace(/["']$/, '');
          return href.startsWith('http') && !href.includes(domain);
        }).length;

        // Images without alt
        const imgMatches = html.match(/<img[^>]*>/gi) || [];
        const imgsWithoutAlt = imgMatches.filter(img => !img.match(/alt=["'][^"']+["']/i)).length;

        // Robots meta
        const robotsMeta = html.match(/<meta[^>]*name=["']robots["'][^>]*content=["']([^"']*)/i)?.[1] || null;

        crawlData.pages.push({
          url: pageUrl, slug, status: pageResp.status,
          metaTitle, metaTitleLen: metaTitle ? metaTitle.length : 0,
          metaDesc, metaDescLen: metaDesc ? metaDesc.length : 0,
          canonical, ogTitle: ogTitle ? 'yes' : 'no', ogDesc: ogDesc ? 'yes' : 'no', ogImage: ogImage ? 'yes' : 'no',
          schemaTypes: schemaTypes.length > 0 ? schemaTypes.join(', ') : (hasItemtype ? 'microdata' : 'none'),
          hasViewport, h1s, h1Count: h1s.length,
          internalLinks, externalLinks,
          totalImages: imgMatches.length, imgsWithoutAlt,
          robotsMeta,
          htmlSize: Math.round(html.length / 1024),
        });
      } catch (e) {
        crawlData.pages.push({ url: pageUrl, error: true, errorMsg: e.message });
      }
    }

    console.log(`[tech-audit] Crawled ${crawlData.pages.filter(p => !p.error).length}/${pagesToCrawl.length} pages`);

    // 5. Server response time
    const startTime = Date.now();
    try {
      await fetch(baseUrl, { signal: AbortSignal.timeout(10000) });
      crawlData.responseTime = Date.now() - startTime;
    } catch (e) {
      crawlData.responseTime = 10000;
    }

    // ===== PHASE 2: AI Analysis =====
    let findings = [];

    if (anthropic) {
      try {
        const serviceAreas = project.service_areas || [];
        const aiPrompt = `You are an expert local SEO technical auditor. Analyze this website crawl data and return actionable findings.

PROJECT: ${project.name} (${domain})
Industry: ${project.industry || 'unknown'}
Location: ${project.location || 'unknown'}
Service Areas: ${JSON.stringify(serviceAreas).substring(0, 500)}

CRAWL DATA:
${JSON.stringify(crawlData, null, 1)}

Return a JSON object with "findings" array. Each finding MUST have:
- pillar: "technical"
- category: one of "security", "crawl", "sitemap", "schema", "mobile", "speed", "links", "structure", "on_page"
- title: concise issue title
- description: what's wrong and why it matters for SEO
- recommendation: specific action to fix it
- severity: "Critical", "Medium", or "Low"
- current_value: what it is now
- recommended_value: what it should be

ANALYZE THOROUGHLY FOR:

HTTPS & SECURITY:
- Is site on HTTPS? Mixed content? Missing HSTS?
- Security headers (X-Frame-Options, CSP)

CRAWLABILITY & INDEXING:
- robots.txt issues (blocking crawlers, missing sitemap directive)
- Sitemap presence and quality
- Pages with noindex that shouldn't have it
- Server response time

ON-PAGE SEO (per page):
- Meta titles: too long (>60), too short (<30), missing, duplicates, missing location keywords for local SEO
- Meta descriptions: too long (>160), too short (<70), missing
- Missing or multiple H1 tags
- Missing canonical tags
- Missing OG tags (og:title, og:description, og:image)
- Images without alt text

SCHEMA MARKUP:
- Missing LocalBusiness schema (critical for local SEO)
- Missing Service schema
- Pages without any structured data

MOBILE USABILITY:
- Missing viewport meta tag

INTERNAL LINK STRUCTURE:
- Pages with fewer than 3 internal links (weak connectivity)
- Average internal links per page
- Orphan-like pages

Be specific — reference actual page URLs and their exact issues. Do NOT make up data — only report what the crawl data shows.
For a local business, missing LocalBusiness schema and location keywords in meta titles are high-priority findings.

Return ONLY valid JSON: {"findings": [...]}`;

        const response = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 8000,
          messages: [{ role: 'user', content: aiPrompt }]
        });

        const text = response.content[0]?.text || '';
        console.log(`[tech-audit] AI response: ${text.length} chars`);

        // Parse AI response
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.findings && Array.isArray(parsed.findings)) {
            findings = parsed.findings.map(f => ({
              pillar: 'technical',
              category: f.category || 'general',
              title: f.title,
              description: f.description,
              recommendation: f.recommendation,
              severity: f.severity || 'Medium',
              current_value: f.current_value || '',
              recommended_value: f.recommended_value || '',
            }));
          }
        }
      } catch (aiErr) {
        console.error('[tech-audit] AI analysis failed:', aiErr.message);
      }
    }

    // Fallback: if AI failed or not configured, use basic rule-based findings
    if (findings.length === 0) {
      console.log('[tech-audit] Using rule-based fallback');
      if (crawlData.https && !crawlData.https.isHttps) {
        findings.push({ pillar: 'technical', category: 'security', title: 'Site not using HTTPS', description: 'HTTPS is a ranking factor.', recommendation: 'Install SSL certificate.', severity: 'Critical', current_value: 'HTTP', recommended_value: 'HTTPS' });
      }
      if (!crawlData.headers.hsts) {
        findings.push({ pillar: 'technical', category: 'security', title: 'Missing HSTS header', description: 'Strict-Transport-Security not set.', recommendation: 'Add HSTS header.', severity: 'Low', current_value: 'Not set', recommended_value: 'max-age=31536000' });
      }
      if (crawlData.robots && !crawlData.robots.exists) {
        findings.push({ pillar: 'technical', category: 'crawl', title: 'robots.txt not found', description: 'Search engines need this file.', recommendation: 'Create robots.txt.', severity: 'Medium', current_value: 'Missing', recommended_value: 'Present' });
      }
      if (crawlData.sitemap && !crawlData.sitemap.exists) {
        findings.push({ pillar: 'technical', category: 'sitemap', title: 'XML sitemap not found', description: 'Sitemaps help discovery.', recommendation: 'Generate sitemap.', severity: 'Critical', current_value: 'Missing', recommended_value: 'Present' });
      }
      for (const page of crawlData.pages.filter(p => !p.error)) {
        if (page.schemaTypes === 'none') {
          findings.push({ pillar: 'technical', category: 'schema', title: `Missing schema: ${page.slug}`, description: `${page.url} has no structured data.`, recommendation: 'Add JSON-LD schema.', severity: 'Medium', current_value: 'None', recommended_value: 'LocalBusiness + Service' });
        }
      }
      if (findings.length === 0) {
        findings.push({ pillar: 'technical', category: 'general', title: 'No critical issues detected', description: 'Basic checks passed.', recommendation: 'Run a deeper audit.', severity: 'Low', current_value: 'Passed', recommended_value: 'N/A' });
      }
    }

    // Save findings
    for (const f of findings) {
      await pool.query(
        `INSERT INTO audit_findings (project_id, audit_id, pillar, category, title, description, recommendation, severity, current_value, recommended_value)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [projectId, auditId, f.pillar, f.category, f.title, f.description, f.recommendation, f.severity, f.current_value, f.recommended_value]
      );
    }

    await pool.query(`UPDATE audits SET status='completed', completed_at=NOW(), audit_data=$2 WHERE id=$1`, [auditId, JSON.stringify({ crawlData: { pagesScanned: crawlData.pages.length, sitemapUrls: crawlData.sitemapUrls.length } })]);

    console.log(`[tech-audit] Done. ${findings.length} findings.`);
    const savedFindings = await pool.query('SELECT * FROM audit_findings WHERE audit_id=$1 ORDER BY severity', [auditId]);
    res.json({ findings: savedFindings.rows });
  } catch (e) {
    console.error('[tech-audit] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==================== 11. USER-LEVEL OAUTH (GSC & GBP) ====================

// Helper: get GSC access token by userId (user-level, shared across all projects)
async function getGscAccessToken(userId) {
  const r = await pool.query('SELECT config FROM user_integrations WHERE user_id=$1 AND kind=$2 AND status=$3', [userId, 'gsc', 'connected']);
  if (r.rows.length === 0) return null;
  let config = r.rows[0].config;
  if (typeof config === 'string') config = JSON.parse(config);

  // Refresh if expired (with 60s buffer)
  if (Date.now() > (config.expires_at - 60000)) {
    if (!config.refresh_token) return null;
    const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: config.refresh_token, client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET, grant_type: 'refresh_token'
      })
    });
    const newTokens = await refreshRes.json();
    if (newTokens.error) { console.error('[gsc] Token refresh failed:', newTokens.error); return null; }
    config.access_token = newTokens.access_token;
    config.expires_at = Date.now() + (newTokens.expires_in * 1000);
    await pool.query('UPDATE user_integrations SET config=$1, updated_at=NOW() WHERE user_id=$2 AND kind=$3',
      [JSON.stringify(config), userId, 'gsc']);
  }
  return config.access_token;
}

// Helper: get GBP access token by userId (user-level)
async function getGbpAccessToken(userId) {
  const r = await pool.query('SELECT config FROM user_integrations WHERE user_id=$1 AND kind=$2 AND status=$3', [userId, 'gbp', 'connected']);
  if (r.rows.length === 0) return null;
  let config = r.rows[0].config;
  if (typeof config === 'string') config = JSON.parse(config);

  if (Date.now() > (config.expires_at - 60000)) {
    if (!config.refresh_token) return null;
    const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: config.refresh_token, client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET, grant_type: 'refresh_token'
      })
    });
    const newTokens = await refreshRes.json();
    if (newTokens.error) { console.error('[gbp] Token refresh failed:', newTokens.error); return null; }
    config.access_token = newTokens.access_token;
    config.expires_at = Date.now() + (newTokens.expires_in * 1000);
    await pool.query('UPDATE user_integrations SET config=$1, updated_at=NOW() WHERE user_id=$2 AND kind=$3',
      [JSON.stringify(config), userId, 'gbp']);
  }
  return config.access_token;
}

// List available GSC sites for dropdown in Project Settings
app.get('/api/user/gsc/sites', async (req, res) => {
  try {
    const accessToken = await getGscAccessToken(req.auth.userId);
    if (!accessToken) return res.json({ sites: [], error: 'GSC not connected' });
    const sites = await fetch('https://www.googleapis.com/webmasters/v3/sites', {
      headers: { Authorization: `Bearer ${accessToken}` }
    }).then(r => r.json());
    res.json({ sites: (sites.siteEntry || []).map(s => ({ url: s.siteUrl, permission: s.permissionLevel })) });
  } catch (e) { res.json({ sites: [], error: e.message }); }
});

// List available GBP locations for dropdown in Project Settings
app.get('/api/user/gbp/locations', async (req, res) => {
  try {
    const accessToken = await getGbpAccessToken(req.auth.userId);
    if (!accessToken) return res.json({ locations: [], error: 'GBP not connected' });
    const acctRes = await fetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', {
      headers: { Authorization: `Bearer ${accessToken}` }
    }).then(r => r.json());
    const allLocations = [];
    for (const acct of (acctRes.accounts || [])) {
      try {
        const locRes = await fetch(
          `https://mybusinessbusinessinformation.googleapis.com/v1/${acct.name}/locations?readMask=name,title,storefrontAddress,websiteUri`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        }).then(r => r.json());
        for (const l of (locRes.locations || [])) {
          allLocations.push({ id: l.name, title: l.title, address: l.storefrontAddress?.addressLines?.join(', ') || '', website: l.websiteUri || '' });
        }
      } catch (e) { /* skip account errors */ }
    }
    res.json({ locations: allLocations });
  } catch (e) { res.json({ locations: [], error: e.message }); }
});

// ==================== GSC OAUTH (USER-LEVEL) ====================

// Start GSC OAuth — no projectId needed
app.get('/api/user/gsc/connect', (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(503).json({ error: 'Google OAuth not configured' });
  const state = Buffer.from(JSON.stringify({
    token: req.headers.authorization?.replace('Bearer ', '')
  })).toString('base64url');
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${GOOGLE_CLIENT_ID}&redirect_uri=${encodeURIComponent(GOOGLE_REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent(GSC_SCOPES)}&access_type=offline&prompt=consent&state=${state}`;
  res.json({ url });
});

// GSC callback — store tokens at user level
app.get('/api/gsc/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send('Missing code or state');
    const stateData = JSON.parse(Buffer.from(state, 'base64url').toString());
    const token = stateData.token;

    let userId;
    try { userId = jwt.verify(token, JWT_SECRET).userId; } catch { return res.status(401).send('Invalid session'); }

    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI, grant_type: 'authorization_code'
      })
    });
    const tokens = await tokenRes.json();
    if (tokens.error) return res.status(400).send(`OAuth error: ${tokens.error_description || tokens.error}`);

    // Store in user_integrations (not project_integrations)
    await pool.query(
      `INSERT INTO user_integrations (user_id, kind, config, status)
       VALUES ($1, 'gsc', $2, 'connected')
       ON CONFLICT (user_id, kind) DO UPDATE SET config=$2, status='connected', updated_at=NOW()`,
      [userId, JSON.stringify({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: Date.now() + (tokens.expires_in * 1000)
      })]
    );
    console.log(`[gsc] OAuth tokens stored for user ${userId}`);

    res.send('<html><body><script>window.close(); window.opener && window.opener.location.reload();</script><p>GSC connected! You can close this tab.</p></body></html>');
  } catch (err) {
    console.error('[gsc] OAuth callback error:', err.message);
    res.status(500).send('OAuth failed: ' + err.message);
  }
});

// User-level GSC status
app.get('/api/user/gsc/status', async (req, res) => {
  const r = await pool.query('SELECT status, updated_at FROM user_integrations WHERE user_id=$1 AND kind=$2', [req.auth.userId, 'gsc']);
  if (r.rows.length === 0) return res.json({ connected: false });
  res.json({ connected: r.rows[0].status === 'connected', updated_at: r.rows[0].updated_at });
});

// User-level GSC disconnect
app.post('/api/user/gsc/disconnect', async (req, res) => {
  await pool.query('UPDATE user_integrations SET status=$1, config=$2, updated_at=NOW() WHERE user_id=$3 AND kind=$4',
    ['disconnected', '{}', req.auth.userId, 'gsc']);
  res.json({ ok: true });
});

// ==================== GBP OAUTH (USER-LEVEL) ====================

// Start GBP OAuth — no projectId needed
app.get('/api/user/gbp/connect', (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(503).json({ error: 'Google OAuth not configured' });
  const state = Buffer.from(JSON.stringify({
    token: req.headers.authorization?.replace('Bearer ', '')
  })).toString('base64url');
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${GOOGLE_CLIENT_ID}&redirect_uri=${encodeURIComponent(GBP_REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent(GBP_SCOPES)}&access_type=offline&prompt=consent&state=${state}`;
  res.json({ url });
});

// GBP callback — store tokens at user level
app.get('/api/gbp/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send('Missing code or state');
    const stateData = JSON.parse(Buffer.from(state, 'base64url').toString());
    const token = stateData.token;

    let userId;
    try { userId = jwt.verify(token, JWT_SECRET).userId; } catch { return res.status(401).send('Invalid session'); }

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GBP_REDIRECT_URI, grant_type: 'authorization_code'
      })
    });
    const tokens = await tokenRes.json();
    if (tokens.error) return res.status(400).send(`OAuth error: ${tokens.error_description || tokens.error}`);

    await pool.query(
      `INSERT INTO user_integrations (user_id, kind, config, status)
       VALUES ($1, 'gbp', $2, 'connected')
       ON CONFLICT (user_id, kind) DO UPDATE SET config=$2, status='connected', updated_at=NOW()`,
      [userId, JSON.stringify({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: Date.now() + (tokens.expires_in * 1000)
      })]
    );
    console.log(`[gbp] OAuth tokens stored for user ${userId}`);
    res.send('<html><body><script>window.close(); window.opener && window.opener.location.reload();</script><p>GBP connected! You can close this tab.</p></body></html>');
  } catch (err) {
    console.error('[gbp] OAuth callback error:', err.message);
    res.status(500).send('OAuth failed: ' + err.message);
  }
});

// User-level GBP status
app.get('/api/user/gbp/status', async (req, res) => {
  const r = await pool.query('SELECT status, updated_at FROM user_integrations WHERE user_id=$1 AND kind=$2', [req.auth.userId, 'gbp']);
  if (r.rows.length === 0) return res.json({ connected: false });
  res.json({ connected: r.rows[0].status === 'connected', updated_at: r.rows[0].updated_at });
});

// User-level GBP disconnect
app.post('/api/user/gbp/disconnect', async (req, res) => {
  await pool.query('UPDATE user_integrations SET status=$1, config=$2, updated_at=NOW() WHERE user_id=$3 AND kind=$4',
    ['disconnected', '{}', req.auth.userId, 'gbp']);
  res.json({ ok: true });
});

// User-level: get all Google integration statuses
app.get('/api/user/integrations', async (req, res) => {
  try {
    const r = await pool.query('SELECT kind, status, updated_at FROM user_integrations WHERE user_id=$1', [req.auth.userId]);
    const integrations = {};
    r.rows.forEach(row => { integrations[row.kind] = { status: row.status, connected: row.status === 'connected', updated_at: row.updated_at }; });
    res.json({ integrations });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GBP: List accounts and locations (uses user-level token)
app.get('/api/projects/:projectId/gbp/locations', async (req, res) => {
  try {
    const accessToken = await getGbpAccessToken(req.auth.userId);
    if (!accessToken) return res.status(400).json({ error: 'GBP not connected — connect in Integrations' });

    const acctRes = await fetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', {
      headers: { Authorization: `Bearer ${accessToken}` }
    }).then(r => r.json());

    const accounts = acctRes.accounts || [];
    if (accounts.length === 0) return res.json({ accounts: [], locations: [] });

    const allLocations = [];
    for (const acct of accounts) {
      const locRes = await fetch(`https://mybusinessbusinessinformation.googleapis.com/v1/${acct.name}/locations?readMask=name,title,storefrontAddress,phoneNumbers,categories,websiteUri,regularHours,metadata`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      }).then(r => r.json());
      const locs = (locRes.locations || []).map(l => ({ ...l, accountName: acct.name, accountDisplayName: acct.accountName }));
      allLocations.push(...locs);
    }

    res.json({ accounts, locations: allLocations });
  } catch (e) {
    console.error('[gbp] Locations error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Sync GSC keywords — fetches real positions from Google and stores them
app.post('/api/projects/:projectId/gsc/sync-keywords', async (req, res) => {
  try {
    const { projectId } = req.params;
    const accessToken = await getGscAccessToken(req.auth.userId);
    if (!accessToken) return res.status(400).json({ error: 'GSC not connected — connect in Integrations' });

    const proj = await pool.query('SELECT domain FROM projects WHERE id=$1', [projectId]);
    if (proj.rows.length === 0) return res.status(404).json({ error: 'Project not found' });

    const domain = proj.rows[0].domain;
    const gscDomain = `sc-domain:${domain.replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/$/, '')}`;

    // Find matching site
    const sites = await fetch('https://www.googleapis.com/webmasters/v3/sites', {
      headers: { Authorization: `Bearer ${accessToken}` }
    }).then(r => r.json());
    const available = (sites.siteEntry || []).map(s => s.siteUrl);
    let matchedSite = available.find(s => s.includes(domain.replace(/^www\./, '')));
    if (!matchedSite && available.length > 0) matchedSite = available[0];
    if (!matchedSite) return res.status(400).json({ error: 'Domain not found in GSC' });

    // Fetch last 28 days for more accurate recent positions
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 28 * 86400000).toISOString().split('T')[0];

    const perfRes = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(matchedSite)}/searchAnalytics/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ startDate, endDate, dimensions: ['query'], rowLimit: 500 })
    });
    const perfData = await perfRes.json();
    const rows = perfData.rows || [];

    // Upsert into gsc_keywords (save current position as prev_position before overwriting)
    let synced = 0;
    for (const row of rows) {
      const kw = row.keys[0];
      await pool.query(
        `INSERT INTO gsc_keywords (project_id, keyword, clicks, impressions, ctr, position, fetched_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (project_id, keyword)
         DO UPDATE SET prev_position = gsc_keywords.position, clicks=$3, impressions=$4, ctr=$5, position=$6, fetched_at=NOW()`,
        [projectId, kw, row.clicks || 0, row.impressions || 0, row.ctr || 0, row.position || 0]
      );
      synced++;
    }

    console.log(`[gsc] Synced ${synced} keywords for project ${projectId}, matchedSite=${matchedSite}, available=${JSON.stringify(available)}, rawRows=${rows.length}`);
    res.json({ ok: true, synced, last_date: endDate, debug: { matched_site: matchedSite, available_sites: available, raw_rows: rows.length, domain_used: domain, gsc_domain_tried: gscDomain, perf_response_keys: Object.keys(perfData) } });
  } catch (e) {
    console.error('[gsc] Sync keywords error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get synced GSC keywords
app.get('/api/projects/:projectId/gsc/keywords', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT keyword, clicks, impressions, ctr, position, fetched_at FROM gsc_keywords WHERE project_id=$1 ORDER BY impressions DESC',
      [req.params.projectId]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Upload GSC keywords from CSV (exported from Google Search Console)
app.post('/api/projects/:projectId/gsc/upload-csv', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { rows } = req.body; // [{keyword, clicks, impressions, ctr, position}]
    if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'No rows provided' });

    let synced = 0;
    for (const row of rows) {
      const kw = (row.keyword || '').trim();
      if (!kw) continue;
      const clicks = parseInt(row.clicks) || 0;
      const impressions = parseInt(row.impressions) || 0;
      const ctr = parseFloat((row.ctr || '0').replace('%', '')) / 100 || 0;
      const position = parseFloat(row.position) || 0;

      await pool.query(
        `INSERT INTO gsc_keywords (project_id, keyword, clicks, impressions, ctr, position, fetched_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (project_id, keyword)
         DO UPDATE SET prev_position = gsc_keywords.position, clicks=$3, impressions=$4, ctr=$5, position=$6, fetched_at=NOW()`,
        [projectId, kw, clicks, impressions, ctr, position]
      );
      synced++;
    }

    console.log(`[gsc] CSV upload: ${synced} keywords for project ${projectId}`);
    res.json({ ok: true, synced });
  } catch (e) {
    console.error('[gsc] CSV upload error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==================== DATAFORSEO RANK TRACKING ====================

// Import discovered keywords with volume + position data
app.post('/api/projects/:projectId/rank-tracking/import-discovered', async (req, res) => {
  const { projectId } = req.params;
  const { keywords } = req.body; // [{keyword, volume, position, url, competition}]
  if (!Array.isArray(keywords) || keywords.length === 0) return res.status(400).json({ error: 'No keywords provided' });
  try {
    let added = 0;
    const baseTime = Date.now();
    for (let i = 0; i < keywords.length; i++) {
      const k = keywords[i];
      if (!k.keyword) continue;
      const kw = k.keyword.trim();
      // Insert into rank_keywords with volume
      await pool.query(
        `INSERT INTO rank_keywords (project_id, keyword, search_volume, competition) VALUES ($1, $2, $3, $4)
         ON CONFLICT (project_id, keyword, location) DO UPDATE SET search_volume=COALESCE(EXCLUDED.search_volume, rank_keywords.search_volume), competition=COALESCE(EXCLUDED.competition, rank_keywords.competition)`,
        [projectId, kw, k.volume || null, k.competition || null]
      );
      // Don't insert GSC position as SERP rank — only real SERP checks should populate rank_tracking
      added++;
    }
    const { rows } = await pool.query('SELECT * FROM rank_keywords WHERE project_id=$1 ORDER BY keyword', [projectId]);
    res.json({ ok: true, added, total: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// AI suggest service keywords for Maps
app.post('/api/projects/:projectId/rank-tracking/suggest-services', async (req, res) => {
  const { projectId } = req.params;
  try {
    const projRes = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    if (projRes.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const p = projRes.rows[0];
    const existing = (req.body.existing || []).join(', ');
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: `You are a local SEO expert. Generate service keywords for a Maps ranking campaign.

Business: ${p.business_name || p.name}
Industry: ${p.industry || 'general'}
Location: ${p.location || 'Australia'}
${existing ? `Already have: ${existing}` : ''}

Generate 20-30 service keyword variations that people would search on Google Maps to find this business. Include:
- Core services (e.g., "auto locksmith", "car key replacement")
- Specific service variations (e.g., "transponder key programming", "emergency car lockout")
- Near-me style keywords (e.g., "locksmith near me", "24 hour locksmith")
- Problem-based keywords (e.g., "locked out of car", "lost car keys")

IMPORTANT: Do NOT include city names, suburb names, or location names in the keywords. The location will be added separately as a suburb. For example return "auto locksmith" NOT "auto locksmith Perth".

Return ONLY a JSON array of strings, no duplicates, no explanation. Example: ["service 1", "service 2"]` }]
    });
    const text = msg.content[0].text.trim();
    const match = text.match(/\[[\s\S]*\]/);
    const services = match ? JSON.parse(match[0]) : [];
    res.json({ services });
  } catch (e) {
    console.error('[suggest-services] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// AI generate smart keyword combos
app.post('/api/projects/:projectId/rank-tracking/generate-combos', async (req, res) => {
  const { projectId } = req.params;
  const { services, suburbs, count, mode } = req.body; // mode: '1:1' or 'many'
  try {
    const projRes = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    if (projRes.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const p = projRes.rows[0];
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages: [{ role: 'user', content: `You are a local SEO expert generating Google Maps keyword combinations.

Business: ${p.business_name || p.name}
Industry: ${p.industry || 'general'}
Location: ${p.location || 'Australia'}

Services: ${services.join(', ')}
Suburbs: ${suburbs.join(', ')}
Target count: ${count} keywords
Mode: ${mode === '1:1' ? 'One service per suburb (spread evenly)' : 'Multiple services per suburb (full coverage)'}

Generate exactly ${count} keyword combinations pairing services with suburbs. Each combo is a service keyword that will be searched in a specific suburb on Google Maps.

Strategy:
- Prioritize high-intent, high-volume service keywords with closest/most relevant suburbs
- For "1:1" mode: spread services across different suburbs for maximum coverage
- For "many" mode: pair top services with multiple suburbs, prioritize closest suburbs
- Put the most impactful combos first (highest expected search volume)
- Each combo should be a realistic search someone would do on Google Maps

Return ONLY a JSON array of objects with "service" and "suburb" keys. No explanation.
Example: [{"service": "auto locksmith", "suburb": "Vincent"}, ...]` }]
    });
    const text = msg.content[0].text.trim();
    const match = text.match(/\[[\s\S]*\]/);
    let combos = match ? JSON.parse(match[0]) : [];

    // Estimate volumes via DataForSEO if available
    if (DATAFORSEO_AUTH && combos.length > 0) {
      try {
        const keywords = combos.map(c => `${c.service} ${c.suburb}`);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20000);
        const dfsRes = await fetch('https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': DATAFORSEO_AUTH },
          body: JSON.stringify([{ keywords, location_name: 'Australia', language_name: 'English' }]),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (dfsRes.ok) {
          const dfsData = await dfsRes.json();
          const volResults = dfsData?.tasks?.[0]?.result || [];
          const volMap = {};
          for (const r of volResults) {
            if (r.keyword && r.search_volume != null) volMap[r.keyword.toLowerCase()] = r.search_volume;
          }
          combos = combos.map(c => ({
            ...c,
            volume: volMap[`${c.service} ${c.suburb}`.toLowerCase()] ?? null
          }));
        }
      } catch (volErr) { console.log(`[generate-combos] Volume error: ${volErr.message}`); }
    }

    res.json({ combos });
  } catch (e) {
    console.error('[generate-combos] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Add keywords to track
app.post('/api/projects/:projectId/rank-tracking/keywords', async (req, res) => {
  const { projectId } = req.params;
  const { keywords, location_code, location } = req.body; // keywords: string[], location: string (suburb/city for Maps), location_code: number
  if (!Array.isArray(keywords) || keywords.length === 0) return res.status(400).json({ error: 'No keywords provided' });
  try {
    let added = 0;
    for (const kw of keywords) {
      if (!kw || typeof kw !== 'string') continue;
      await pool.query(
        `INSERT INTO rank_keywords (project_id, keyword, location, location_code) VALUES ($1, $2, $3, $4) ON CONFLICT (project_id, keyword, location) DO NOTHING`,
        [projectId, kw.trim(), location || '', location_code || 2036]
      );
      added++;
    }
    const { rows } = await pool.query('SELECT * FROM rank_keywords WHERE project_id=$1 ORDER BY added_at DESC', [projectId]);
    res.json({ ok: true, added, total: rows.length, keywords: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Remove a tracked keyword
app.delete('/api/projects/:projectId/rank-tracking/keywords/:keywordId', async (req, res) => {
  try {
    await pool.query('DELETE FROM rank_keywords WHERE id=$1 AND project_id=$2', [req.params.keywordId, req.params.projectId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Bulk delete keywords by IDs
app.post('/api/projects/:projectId/rank-tracking/keywords/bulk-delete', async (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'No IDs provided' });
  try {
    await pool.query('DELETE FROM rank_tracking WHERE keyword_id = ANY($1::int[]) AND project_id=$2', [ids, req.params.projectId]);
    await pool.query('DELETE FROM rank_keywords WHERE id = ANY($1::int[]) AND project_id=$2', [ids, req.params.projectId]);
    res.json({ ok: true, deleted: ids.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete ALL tracked keywords for a project
app.delete('/api/projects/:projectId/rank-tracking/keywords', async (req, res) => {
  try {
    await pool.query('DELETE FROM rank_tracking WHERE project_id=$1', [req.params.projectId]);
    await pool.query('DELETE FROM rank_keywords WHERE project_id=$1', [req.params.projectId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Clean ALL maps data (keywords with location + their tracking records)
app.delete('/api/projects/:projectId/maps/clean', async (req, res) => {
  try {
    // Delete tracking records for maps keywords (those with a location)
    const trackDel = await pool.query(
      `DELETE FROM rank_tracking WHERE project_id=$1 AND location IS NOT NULL AND location != ''`,
      [req.params.projectId]
    );
    // Delete grid scans
    const gridDel = await pool.query(
      `DELETE FROM grid_scans WHERE project_id=$1`,
      [req.params.projectId]
    );
    // Delete the maps keywords themselves
    const kwDel = await pool.query(
      `DELETE FROM rank_keywords WHERE project_id=$1 AND location IS NOT NULL AND location != ''`,
      [req.params.projectId]
    );
    console.log(`[maps-clean] Cleaned ${kwDel.rowCount} keywords + ${trackDel.rowCount} tracking + ${gridDel.rowCount} grid scans for project ${req.params.projectId}`);
    res.json({ ok: true, keywords_deleted: kwDel.rowCount, tracking_deleted: trackDel.rowCount, grid_scans_deleted: gridDel.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// SERPapi-powered Maps/Local Pack sync
app.post('/api/projects/:projectId/maps/sync-serpapi', async (req, res) => {
  if (!SERPAPI_KEY) return res.status(503).json({ error: 'SERPAPI_KEY not configured. Add it to Railway env vars.' });
  const { projectId } = req.params;
  try {
    const projRes = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    if (projRes.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = projRes.rows[0];
    const businessName = project.business_name || project.name || '';

    // Get maps keywords (those with a location)
    const kwRes = await pool.query(
      `SELECT * FROM rank_keywords WHERE project_id=$1 AND location IS NOT NULL AND location != '' ORDER BY keyword`,
      [projectId]
    );
    if (kwRes.rows.length === 0) return res.status(400).json({ error: 'No maps keywords. Generate keywords first.' });

    console.log(`[maps-serpapi] Starting sync for ${kwRes.rows.length} keywords, business="${businessName}"`);

    // GPS coordinates for Perth suburbs — used for location-accurate local pack results
    const suburbGPS = {
      'leeming': { lat: -32.0728, lng: 115.8640 }, 'murdoch': { lat: -32.0660, lng: 115.8430 },
      'cannington': { lat: -32.0170, lng: 115.9340 }, 'east cannington': { lat: -32.0100, lng: 115.9500 },
      'ferndale': { lat: -32.0300, lng: 115.9500 }, 'lynwood': { lat: -32.0400, lng: 115.9300 },
      'parkwood': { lat: -32.0450, lng: 115.9150 }, 'queens park': { lat: -32.0050, lng: 115.9400 },
      'riverton': { lat: -32.0350, lng: 115.8940 }, 'rossmoyne': { lat: -32.0380, lng: 115.8700 },
      'shelley': { lat: -32.0280, lng: 115.8800 }, 'willetton': { lat: -32.0530, lng: 115.8890 },
      'wilson': { lat: -32.0230, lng: 115.9100 }, 'canning vale': { lat: -32.0580, lng: 115.9180 },
      'bentley': { lat: -32.0000, lng: 115.9200 }, 'welshpool': { lat: -31.9930, lng: 115.9450 },
      'atwell': { lat: -32.1440, lng: 115.8640 }, 'aubin grove': { lat: -32.1640, lng: 115.8660 },
      'bibra lake': { lat: -32.0930, lng: 115.8200 }, 'cockburn': { lat: -32.1300, lng: 115.8500 },
      'coogee': { lat: -32.1190, lng: 115.7650 }, 'coolbellup': { lat: -32.0830, lng: 115.8030 },
      'hamilton hill': { lat: -32.0820, lng: 115.7770 }, 'jandakot': { lat: -32.1050, lng: 115.8700 },
      'spearwood': { lat: -32.1050, lng: 115.7830 }, 'success': { lat: -32.1440, lng: 115.8490 },
      'banjup': { lat: -32.1290, lng: 115.8580 }, 'beeliar': { lat: -32.1350, lng: 115.8150 },
      'hammond park': { lat: -32.1620, lng: 115.8470 }, 'henderson': { lat: -32.1490, lng: 115.7730 },
      'lake coogee': { lat: -32.1280, lng: 115.7800 }, 'munster': { lat: -32.1310, lng: 115.7870 },
      'north coogee': { lat: -32.1100, lng: 115.7640 }, 'north lake': { lat: -32.0770, lng: 115.8330 },
      'south lake': { lat: -32.0870, lng: 115.8350 }, 'treeby': { lat: -32.1500, lng: 115.8630 },
      'wattleup': { lat: -32.1470, lng: 115.7990 }, 'yangebup': { lat: -32.1220, lng: 115.8140 }
    };

    // SERPapi helper — Google Search with GPS coordinates for accurate local pack
    async function serpApiSearch(keyword, suburb) {
      const query = suburb ? `${keyword} ${suburb}` : keyword;
      const gps = suburb ? suburbGPS[suburb.toLowerCase()] : null;
      const paramObj = {
        api_key: SERPAPI_KEY,
        engine: 'google',
        q: query,
        google_domain: 'google.com.au',
        gl: 'au',
        hl: 'en',
        num: 20
      };
      if (gps) {
        paramObj.lat = gps.lat;
        paramObj.lon = gps.lng;
      } else {
        paramObj.location = 'Perth, Western Australia, Australia';
      }
      const params = new URLSearchParams(paramObj);
      const resp = await fetch(`https://serpapi.com/search.json?${params}`);
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`SERPapi error ${resp.status}: ${text.substring(0, 200)}`);
      }
      return resp.json();
    }

    // Process keywords in parallel (5 at a time)
    const results = [];
    const baseTime = Date.now();
    for (let i = 0; i < kwRes.rows.length; i += 5) {
      const batch = kwRes.rows.slice(i, i + 5);
      const promises = batch.map(async (kw, j) => {
        const idx = i + j;
        const query = `${kw.keyword} ${kw.location}`;
        try {
          const data = await serpApiSearch(kw.keyword, kw.location);
          if (idx === 0) console.log(`[maps-serpapi] Raw response keys for "${query}":`, Object.keys(data), 'local_results.places count:', (data.local_results?.places || []).length);

          // Extract local pack results — google engine returns local_results.places
          const localResults = data.local_results?.places || data.local_results || [];
          const localPack = Array.isArray(localResults) ? localResults : [];

          // Find our position in local pack
          let maps = { position: null, title: null, rating: null, reviews: null, address: null };
          const localPackTop3 = [];
          const nameLower = businessName.toLowerCase();
          const nameNoSpaces = nameLower.replace(/\s+/g, '');
          const nameWords = nameLower.split(/\s+/).filter(w => w.length > 2);

          for (let p = 0; p < localPack.length; p++) {
            const place = localPack[p];
            const titleLower = (place.title || '').toLowerCase();
            const titleNoSpaces = titleLower.replace(/\s+/g, '');
            const pos = place.position || (p + 1);

            // Match business
            const nameMatch = nameLower && (
              titleLower.includes(nameLower) || titleNoSpaces.includes(nameNoSpaces) ||
              (nameWords.length >= 2 && nameWords.every(w => titleLower.includes(w)))
            );

            if (nameMatch && !maps.position) {
              maps = { position: pos, title: place.title, rating: place.rating, reviews: place.reviews, address: place.address };
            }

            if (pos <= 3) {
              localPackTop3.push({ position: pos, title: place.title, rating: place.rating, reviews: place.reviews, source: 'local' });
            }
          }

          // Extract organic SERP position
          let serp = { position: null, url: null, title: null, snippet: null, type: null };
          const domain = (project.website || project.domain || '').replace(/^https?:\/\//, '').replace(/\/$/, '').replace(/^www\./, '').toLowerCase();
          for (const item of (data.organic_results || [])) {
            let itemHost = '';
            try { itemHost = new URL(item.link || '').hostname.replace(/^www\./, '').toLowerCase(); } catch (e) {
              itemHost = (item.link || '').replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '').toLowerCase();
            }
            if (domain && (itemHost === domain || itemHost.endsWith('.' + domain))) {
              serp = { position: item.position, url: item.link, title: item.title, snippet: item.snippet, type: 'organic' };
              break;
            }
          }

          // Build competitors list (local pack top 3 minus our business)
          const kwCompetitors = localPackTop3.filter(t => {
            const tLower = (t.title || '').toLowerCase();
            const tNoSpaces = tLower.replace(/\s+/g, '');
            return !tLower.includes(nameLower) && !tNoSpaces.includes(nameNoSpaces);
          });

          // Save to DB
          await pool.query(
            `INSERT INTO rank_tracking (project_id, keyword, location, location_code, language_code, serp_position, serp_url, serp_title, serp_snippet, serp_type, maps_position, maps_title, maps_rating, maps_reviews, maps_address, competitors, checked_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
            [projectId, kw.keyword, kw.location || '', kw.location_code, kw.language_code,
             serp.position, serp.url, serp.title, serp.snippet, serp.type,
             maps.position, maps.title, maps.rating, maps.reviews, maps.address,
             JSON.stringify(kwCompetitors), new Date(baseTime + idx).toISOString()]
          );

          const result = { keyword: kw.keyword, location: kw.location, serp_position: serp.position, maps_position: maps.position, local_pack_top3: localPackTop3.map(t => t.title) };
          results[idx] = result;
          if (idx < 3) console.log(`[maps-serpapi] "${query}" → local_pack=${maps.position || '>20'}, top3: ${localPackTop3.map(t => t.title).join(', ')}`);
        } catch (err) {
          console.error(`[maps-serpapi] Error for "${query}":`, err.message);
          results[idx] = { keyword: kw.keyword, location: kw.location, error: err.message };
        }
      });
      await Promise.all(promises);
    }

    console.log(`[maps-serpapi] Done. Synced ${results.filter(r => r && !r.error).length}/${kwRes.rows.length} keywords.`);
    res.json({ ok: true, synced: results.filter(r => r && !r.error).length, total: kwRes.rows.length, results: results.filter(Boolean) });
  } catch (e) {
    console.error('[maps-serpapi] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Local Falcon sync — pulls scan reports into Maps tab
app.post('/api/projects/:projectId/maps/sync-localfalcon', async (req, res) => {
  if (!LOCAL_FALCON_KEY) return res.status(503).json({ error: 'LOCAL_FALCON_KEY not configured. Add it to Railway env vars.' });
  const { projectId } = req.params;
  try {
    const projRes = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    if (projRes.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = projRes.rows[0];
    const businessName = project.business_name || project.name || '';

    // Fetch all reports from Local Falcon
    const lfResp = await fetch(`https://api.localfalcon.com/v1/reports?api_key=${LOCAL_FALCON_KEY}`, {
      headers: { 'Accept': 'application/json' }
    });
    const lfData = await lfResp.json();
    if (!lfData.success) return res.status(400).json({ error: lfData.message || 'Local Falcon API error' });

    const reports = lfData.data?.reports || [];
    console.log(`[maps-localfalcon] Got ${reports.length} reports from Local Falcon`);

    // Filter reports for this business (match by place_id or name)
    const placeName = businessName.toLowerCase();
    const relevantReports = reports.filter(r => {
      const locName = (r.location?.name || '').toLowerCase();
      return locName.includes(placeName) || placeName.includes(locName);
    });

    if (relevantReports.length === 0) {
      return res.status(400).json({ error: `No Local Falcon reports match business "${businessName}". Found ${reports.length} reports for other businesses. Check your business name in Project Settings.` });
    }

    const reportsToUse = relevantReports;
    const baseTime = Date.now();
    let synced = 0;

    for (let i = 0; i < reportsToUse.length; i++) {
      const report = reportsToUse[i];
      const keyword = report.keyword || '';
      const location = ''; // Local Falcon handles location via geo-grid

      // Extract keyword and location from keyword field (e.g. "plumber leeming" -> keyword="plumber", location="leeming")
      const parts = keyword.split(/\s+/);
      let kwBase = keyword;
      let kwLocation = '';
      if (parts.length >= 2) {
        kwBase = parts[0];
        kwLocation = parts.slice(1).join(' ');
      }

      // Ensure keyword exists in rank_keywords
      await pool.query(
        `INSERT INTO rank_keywords (project_id, keyword, location) VALUES ($1, $2, $3) ON CONFLICT (project_id, keyword, location) DO NOTHING`,
        [projectId, kwBase, kwLocation]
      );

      // Map Local Falcon data to our DB schema
      const arp = parseFloat(report.arp) || null;
      const atrp = parseFloat(report.atrp) || null;
      const solv = parseFloat(report.solv) || 0;
      const foundIn = parseInt(report.found_in) || 0;
      const dataPoints = parseInt(report.data_points) || 0;

      // maps_position = ARP (average rank position) — most useful metric
      const mapsPosition = arp && arp <= 20 ? Math.round(arp) : null;

      // Store competitors as metadata with Local Falcon metrics
      const lfMetrics = {
        arp, atrp, solv, found_in: foundIn, data_points: dataPoints,
        heatmap: report.heatmap || null,
        report_key: report.report_key || null,
        source: 'local_falcon'
      };

      await pool.query(
        `INSERT INTO rank_tracking (project_id, keyword, location, serp_position, maps_position, maps_title, competitors, checked_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [projectId, kwBase, kwLocation, null, mapsPosition, businessName,
         JSON.stringify([lfMetrics]), new Date(baseTime + i).toISOString()]
      );

      synced++;
    }

    // Reload keywords
    const { rows: allKw } = await pool.query('SELECT * FROM rank_keywords WHERE project_id=$1 ORDER BY keyword', [projectId]);

    console.log(`[maps-localfalcon] Done. Synced ${synced} reports.`);
    res.json({ ok: true, synced, total: reportsToUse.length, keywords: allKw });
  } catch (e) {
    console.error('[maps-localfalcon] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==================== GRID SCAN (SerpAPI Maps — replaces Local Falcon) ====================

// Generate NxN grid of GPS points around a center
function generateGrid(centerLat, centerLng, radiusKm, gridSize) {
  const points = [];
  const latPerKm = 1 / 111.32;
  const lngPerKm = 1 / (111.32 * Math.cos(centerLat * Math.PI / 180));
  const step = (radiusKm * 2) / (gridSize - 1);
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      const offsetKmY = radiusKm - (row * step); // top to bottom
      const offsetKmX = -radiusKm + (col * step); // left to right
      points.push({
        row, col,
        lat: Math.round((centerLat + offsetKmY * latPerKm) * 100000) / 100000,
        lng: Math.round((centerLng + offsetKmX * lngPerKm) * 100000) / 100000,
      });
    }
  }
  return points;
}

// Run grid scan for selected keywords
app.post('/api/projects/:projectId/maps/grid-scan', async (req, res) => {
  if (!SERPAPI_KEY) return res.status(503).json({ error: 'SERPAPI_KEY not configured' });
  const { projectId } = req.params;
  const { keyword_ids, grid_size = 5, radius_km = 10 } = req.body;

  try {
    const projRes = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    if (projRes.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = projRes.rows[0];
    const businessName = project.business_name || project.name || '';
    const domain = (project.website || project.domain || '').replace(/^https?:\/\//, '').replace(/\/$/, '').replace(/^www\./, '').toLowerCase();

    if (!businessName) return res.status(400).json({ error: 'Business name not set in Project Settings' });

    // Get business center GPS from project location
    const rawLocation = (project.location || '').trim();
    const locParts = rawLocation.toLowerCase().replace(/[,]/g, ' ').split(/\s+/).filter(Boolean);
    let centerGps = null;
    const candidates = [rawLocation.toLowerCase().trim(), locParts[0], locParts.slice(0, 2).join(' ')].filter(Boolean);
    for (const c of candidates) { if (SUBURB_GPS[c]) { centerGps = SUBURB_GPS[c]; break; } }

    // If GBP location has GPS in the name (like "place_id:xxx"), fall back to project location
    if (!centerGps) {
      // Try to use the first service area as fallback
      const areas = project.service_areas || [];
      if (areas.length > 0) {
        const firstArea = (areas[0].name || areas[0] || '').toLowerCase().trim();
        if (SUBURB_GPS[firstArea]) centerGps = SUBURB_GPS[firstArea];
      }
    }
    if (!centerGps) return res.status(400).json({ error: `Cannot find GPS for location "${rawLocation}". Add a known suburb as your project location.` });

    // Get keywords to scan
    let kwFilter = '';
    let kwParams = [projectId];
    if (keyword_ids && keyword_ids.length > 0) {
      kwFilter = ` AND id = ANY($2)`;
      kwParams.push(keyword_ids);
    }
    const kwRes = await pool.query(`SELECT * FROM rank_keywords WHERE project_id=$1${kwFilter} ORDER BY keyword`, kwParams);
    const keywords = kwRes.rows.filter(k => k.location); // only maps keywords (have location)

    if (keywords.length === 0) return res.status(400).json({ error: 'No maps keywords found. Add service + location keywords first.' });

    const gridSizeInt = Math.min(Math.max(parseInt(grid_size) || 5, 3), 7);
    const radiusFloat = Math.min(Math.max(parseFloat(radius_km) || 10, 2), 30);
    const totalPoints = gridSizeInt * gridSizeInt;
    const totalCalls = keywords.length * totalPoints;

    console.log(`[grid-scan] Starting: ${keywords.length} keywords × ${totalPoints} points = ${totalCalls} API calls, grid=${gridSizeInt}×${gridSizeInt}, radius=${radiusFloat}km, center=${centerGps.lat},${centerGps.lng}`);

    // Generate grid points
    const gridPoints = generateGrid(centerGps.lat, centerGps.lng, radiusFloat, gridSizeInt);

    const results = [];
    const nameLower = businessName.toLowerCase();
    const nameNoSpaces = nameLower.replace(/\s+/g, '');
    const nameWords = nameLower.split(/\s+/).filter(w => w.length > 2);

    // Process keywords sequentially, grid points in parallel batches of 5
    for (const kw of keywords) {
      const kwLabel = `${kw.keyword} ${kw.location}`;
      const pointResults = [];
      let ourBusiness = null;

      for (let i = 0; i < gridPoints.length; i += 5) {
        const batch = gridPoints.slice(i, i + 5);
        const promises = batch.map(async (point) => {
          try {
            const data = await serpApiSearch({
              engine: 'google_maps',
              q: kwLabel,
              ll: `@${point.lat},${point.lng},14z`,
              type: 'search',
            });

            const localResults = data.local_results || [];
            let position = null;
            let found = false;
            const top3 = [];

            for (let p = 0; p < localResults.length && p < 20; p++) {
              const place = localResults[p];
              const titleLower = (place.title || '').toLowerCase();
              const titleNoSpaces = titleLower.replace(/\s+/g, '');
              const placePos = place.position || (p + 1);

              // Capture top 3 for competitor analysis
              if (placePos <= 3) {
                top3.push({
                  position: placePos,
                  title: place.title || '',
                  rating: place.rating || null,
                  reviews: place.reviews || 0,
                  type: place.type || '',
                  address: place.address || '',
                  website: place.website || '',
                });
              }

              const nameMatch = nameLower && (
                titleLower.includes(nameLower) || titleNoSpaces.includes(nameNoSpaces) ||
                (nameWords.length >= 2 && nameWords.every(w => titleLower.includes(w)))
              );

              // Also match by domain/website
              const placeWebsite = (place.website || '').toLowerCase();
              const domainMatch = domain && placeWebsite && (placeWebsite.includes(domain) || domain.includes(placeWebsite.replace(/^https?:\/\//, '').replace(/\/$/, '').replace(/^www\./, '')));

              if ((nameMatch || domainMatch) && !found) {
                position = placePos;
                found = true;
                // Capture our own business stats
                if (!ourBusiness) {
                  ourBusiness = { rating: place.rating || null, reviews: place.reviews || 0, type: place.type || '', title: place.title || '' };
                }
              }
            }

            return { ...point, position, found, top3, error: null };
          } catch (err) {
            console.error(`[grid-scan] Error at (${point.row},${point.col}) for "${kwLabel}":`, err.message);
            return { ...point, position: null, found: false, error: err.message };
          }
        });

        const batchResults = await Promise.all(promises);
        pointResults.push(...batchResults);
      }

      // Calculate metrics
      const successPoints = pointResults.filter(p => !p.error);
      const foundPoints = successPoints.filter(p => p.found);
      const totalScanned = successPoints.length;
      const foundCount = foundPoints.length;

      // ARP: average rank of found positions
      const arp = foundCount > 0
        ? Math.round((foundPoints.reduce((s, p) => s + p.position, 0) / foundCount) * 10) / 10
        : null;

      // ATRP: average true rank (unfound = 21)
      const atrp = totalScanned > 0
        ? Math.round((successPoints.reduce((s, p) => s + (p.found ? p.position : 21), 0) / totalScanned) * 10) / 10
        : null;

      // SOLV: share of local voice = % of points where found in top 3
      const top3Count = foundPoints.filter(p => p.position <= 3).length;
      const solv = totalScanned > 0
        ? Math.round((top3Count / totalScanned) * 1000) / 10
        : 0;

      // Aggregate competitor data across all grid points
      const compMap = {};
      for (const pt of successPoints) {
        for (const c of (pt.top3 || [])) {
          const cName = c.title.trim();
          if (!cName) continue;
          // Skip our own business
          const cLower = cName.toLowerCase();
          const cNoSpaces = cLower.replace(/\s+/g, '');
          const isUs = cLower.includes(nameLower) || cNoSpaces.includes(nameNoSpaces) ||
            (nameWords.length >= 2 && nameWords.every(w => cLower.includes(w)));
          if (isUs) continue;
          if (!compMap[cName]) {
            compMap[cName] = { name: cName, rating: c.rating, reviews: c.reviews, type: c.type, website: c.website, appearances: 0, top1: 0, top3: 0, positions: [] };
          }
          compMap[cName].appearances++;
          if (c.position === 1) compMap[cName].top1++;
          if (c.position <= 3) compMap[cName].top3++;
          compMap[cName].positions.push(c.position);
          // Update to latest non-null values
          if (c.rating && (!compMap[cName].rating || c.rating > compMap[cName].rating)) compMap[cName].rating = c.rating;
          if (c.reviews && c.reviews > compMap[cName].reviews) compMap[cName].reviews = c.reviews;
          if (c.type && !compMap[cName].type) compMap[cName].type = c.type;
          if (c.website && !compMap[cName].website) compMap[cName].website = c.website;
        }
      }
      // Sort by appearances (most dominant competitors first)
      const competitors = Object.values(compMap)
        .map(c => ({
          ...c,
          avg_position: Math.round((c.positions.reduce((s,p) => s+p, 0) / c.positions.length) * 10) / 10,
          dominance: Math.round((c.top3 / totalScanned) * 1000) / 10, // % of grid points in top 3
        }))
        .sort((a, b) => b.appearances - a.appearances)
        .slice(0, 10); // top 10 competitors

      // Save to grid_scans table
      await pool.query(
        `INSERT INTO grid_scans (project_id, keyword_id, keyword, location, grid_size, center_lat, center_lng, radius_km, grid_points, competitors, arp, atrp, solv, found_in, data_points, scanned_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())`,
        [projectId, kw.id, kw.keyword, kw.location, gridSizeInt, centerGps.lat, centerGps.lng, radiusFloat,
         JSON.stringify(pointResults), JSON.stringify({ top: competitors.slice(0, 3), our_business: ourBusiness }), arp, atrp, solv, foundCount, totalScanned]
      );

      // Also update rank_tracking with grid metrics (compatible with existing table display)
      const gridMetrics = {
        arp, atrp, solv, found_in: foundCount, data_points: totalScanned,
        grid_size: gridSizeInt, radius_km: radiusFloat,
        source: 'serpapi_grid'
      };

      await pool.query(
        `INSERT INTO rank_tracking (project_id, keyword, location, serp_position, maps_position, maps_title, competitors, checked_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
        [projectId, kw.keyword, kw.location, null, arp ? Math.round(arp) : null, businessName, JSON.stringify([gridMetrics])]
      );

      const result = { keyword: kw.keyword, location: kw.location, keyword_id: kw.id, arp, atrp, solv, found_in: foundCount, data_points: totalScanned, grid_points: pointResults, competitors, our_business: ourBusiness };
      results.push(result);
      console.log(`[grid-scan] "${kwLabel}" → ARP=${arp || 'N/A'}, ATRP=${atrp || 'N/A'}, SOLV=${solv}%, found=${foundCount}/${totalScanned}`);
    }

    console.log(`[grid-scan] Done. Scanned ${keywords.length} keywords, ${totalCalls} API calls.`);
    res.json({ ok: true, scanned: keywords.length, total_api_calls: totalCalls, results });
  } catch (e) {
    console.error('[grid-scan] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get latest grid scan results for a project
app.get('/api/projects/:projectId/maps/grid-scans', async (req, res) => {
  try {
    // Get latest scan per keyword using DISTINCT ON
    const { rows } = await pool.query(`
      SELECT DISTINCT ON (keyword, location) *
      FROM grid_scans
      WHERE project_id=$1
      ORDER BY keyword, location, scanned_at DESC
    `, [req.params.projectId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get tracked keywords
app.get('/api/projects/:projectId/rank-tracking/keywords', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM rank_keywords WHERE project_id=$1 ORDER BY keyword', [req.params.projectId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Sync ranks — calls DataForSEO for all tracked keywords
app.post('/api/projects/:projectId/rank-tracking/sync', async (req, res) => {
  if (!SERPAPI_KEY) return res.status(503).json({ error: 'SERPAPI_KEY not configured. Add it to Railway env vars.' });
  const { projectId } = req.params;
  try {
    const projRes = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    if (projRes.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = projRes.rows[0];
    const domain = (project.website || project.domain || '').replace(/^https?:\/\//, '').replace(/\/$/, '').replace(/^www\./, '');
    const businessName = project.business_name || project.name || domain;

    const kwRes = await pool.query('SELECT * FROM rank_keywords WHERE project_id=$1', [projectId]);
    if (kwRes.rows.length === 0) return res.status(400).json({ error: 'No keywords to track. Add keywords first.' });

    console.log(`[rank-sync] Starting SerpAPI sync for ${kwRes.rows.length} keywords, domain="${domain}", businessName="${businessName}"`);

    // GPS coordinates for Perth suburbs
    const suburbGPS = {
      'leeming': { lat: -32.0728, lng: 115.8640 }, 'cannington': { lat: -32.0170, lng: 115.9340 },
      'east cannington': { lat: -32.0100, lng: 115.9500 }, 'ferndale': { lat: -32.0300, lng: 115.9500 },
      'lynwood': { lat: -32.0400, lng: 115.9300 }, 'parkwood': { lat: -32.0450, lng: 115.9150 },
      'queens park': { lat: -32.0050, lng: 115.9400 }, 'riverton': { lat: -32.0350, lng: 115.8940 },
      'rossmoyne': { lat: -32.0380, lng: 115.8700 }, 'shelley': { lat: -32.0280, lng: 115.8800 },
      'willetton': { lat: -32.0530, lng: 115.8890 }, 'wilson': { lat: -32.0230, lng: 115.9100 },
      'canning vale': { lat: -32.0580, lng: 115.9180 }, 'bentley': { lat: -32.0000, lng: 115.9200 },
      'welshpool': { lat: -31.9930, lng: 115.9450 }, 'atwell': { lat: -32.1440, lng: 115.8640 },
      'aubin grove': { lat: -32.1640, lng: 115.8660 }, 'banjup': { lat: -32.1290, lng: 115.8580 },
      'beeliar': { lat: -32.1350, lng: 115.8150 }, 'bibra lake': { lat: -32.0930, lng: 115.8200 },
      'cockburn': { lat: -32.1300, lng: 115.8500 }, 'coogee': { lat: -32.1190, lng: 115.7650 },
      'coolbellup': { lat: -32.0830, lng: 115.8030 }, 'hamilton hill': { lat: -32.0820, lng: 115.7770 },
      'hammond park': { lat: -32.1620, lng: 115.8470 }, 'henderson': { lat: -32.1490, lng: 115.7730 },
      'jandakot': { lat: -32.1050, lng: 115.8700 }, 'lake coogee': { lat: -32.1280, lng: 115.7800 },
      'munster': { lat: -32.1310, lng: 115.7870 }, 'north coogee': { lat: -32.1100, lng: 115.7640 },
      'north lake': { lat: -32.0770, lng: 115.8330 }, 'south lake': { lat: -32.0870, lng: 115.8350 },
      'spearwood': { lat: -32.1050, lng: 115.7830 }, 'success': { lat: -32.1440, lng: 115.8490 },
      'treeby': { lat: -32.1500, lng: 115.8630 }, 'wattleup': { lat: -32.1470, lng: 115.7990 },
      'yangebup': { lat: -32.1220, lng: 115.8140 }, 'murdoch': { lat: -32.0660, lng: 115.8430 }
    };

    const results = [];
    const competitors = project.competitors || [];
    const competitorDomains = competitors.map(c => (c.domain || c).replace(/^https?:\/\//, '').replace(/\/$/, '').replace(/^www\./, '').toLowerCase());
    const baseTime = Date.now();

    // Process keywords in parallel (5 at a time) via SerpAPI
    for (let i = 0; i < kwRes.rows.length; i += 5) {
      const batch = kwRes.rows.slice(i, i + 5);
      const promises = batch.map(async (kw, j) => {
        const idx = i + j;
        const query = kw.location ? `${kw.keyword} ${kw.location}` : kw.keyword;
        try {
          // Build SerpAPI params
          const paramObj = {
            engine: 'google',
            q: query,
            google_domain: 'google.com.au',
            gl: 'au',
            hl: 'en',
            num: 30
          };
          // Use GPS coords for suburb-level accuracy
          const gps = kw.location ? suburbGPS[kw.location.toLowerCase()] : null;
          if (gps) {
            paramObj.lat = gps.lat;
            paramObj.lon = gps.lng;
          } else {
            paramObj.location = 'Perth, Western Australia, Australia';
          }

          const data = await serpApiSearch(paramObj);
          if (idx === 0) console.log(`[rank-sync] First keyword "${query}" response keys:`, Object.keys(data));

          // Parse organic results
          let serp = { position: null, url: null, title: null, snippet: null, type: null };
          let kwCompetitors = [];
          const domainLower = domain.toLowerCase();
          if (idx < 3) console.log(`[rank-sync] "${query}" matching domain: "${domainLower}", organic_results: ${(data.organic_results || []).length}`);
          for (const item of (data.organic_results || [])) {
            const pos = item.position;

            // Use item.link (actual URL) for domain matching — NOT displayed_link which has Google's display format
            let itemHost = '';
            try {
              itemHost = new URL(item.link || '').hostname.replace(/^www\./, '').toLowerCase();
            } catch (e) {
              itemHost = (item.link || '').replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '').toLowerCase();
            }
            if (idx < 3 && pos <= 5) console.log(`[rank-sync]   #${pos} itemHost="${itemHost}" link="${(item.link || '').slice(0, 60)}" vs domain="${domainLower}" match=${itemHost === domainLower}`);
            if (domainLower && (itemHost === domainLower || itemHost === 'www.' + domainLower || itemHost.endsWith('.' + domainLower))) {
              if (!serp.position) {
                serp = { position: pos, url: item.link, title: item.title, snippet: item.snippet, type: 'organic' };
              }
            } else {
              if (kwCompetitors.filter(c => c.source === 'serp').length < 3) {
                kwCompetitors.push({ domain: itemHost, position: pos, url: item.link, title: item.title, source: 'serp' });
              }
            }
            // Named competitors — strict host match
            for (const cd of competitorDomains) {
              if ((itemHost === cd || itemHost === 'www.' + cd || itemHost.endsWith('.' + cd)) && !kwCompetitors.find(c => c.domain === itemHost && c.source === 'serp')) {
                kwCompetitors.push({ domain: itemHost, position: pos, url: item.link, title: item.title, source: 'serp' });
              }
            }
          }

          // Parse local pack
          let maps = { position: null, title: null, rating: null, reviews: null, address: null };
          const localPackTop3 = [];
          const localResults = data.local_results?.places || data.local_results || [];
          const localPack = Array.isArray(localResults) ? localResults : [];
          const nameLower = businessName.toLowerCase();
          const nameNoSpaces = nameLower.replace(/\s+/g, '');
          const nameWords = nameLower.split(/\s+/).filter(w => w.length > 2);

          for (let p = 0; p < localPack.length; p++) {
            const place = localPack[p];
            const titleLower = (place.title || '').toLowerCase();
            const titleNoSpaces = titleLower.replace(/\s+/g, '');
            const pos = place.position || (p + 1);
            const placeDomain = (place.links?.website || '').replace(/^https?:\/\//, '').replace(/\/$/, '').replace(/^www\./, '').toLowerCase();

            const nameMatch = nameLower && (
              titleLower.includes(nameLower) || titleNoSpaces.includes(nameNoSpaces) ||
              (nameWords.length >= 2 && nameWords.every(w => titleLower.includes(w)))
            );
            const domainMatch = domain && placeDomain && (placeDomain.includes(domain.toLowerCase()) || domain.toLowerCase().includes(placeDomain));

            if ((nameMatch || domainMatch) && !maps.position) {
              maps = { position: pos, title: place.title, rating: place.rating, reviews: place.reviews, address: place.address };
            }
            if (pos <= 3) {
              localPackTop3.push({ position: pos, title: place.title, rating: place.rating, reviews: place.reviews, source: 'local' });
            }
          }

          // Add local pack competitors (excluding our business)
          if (localPackTop3.length > 0) {
            const filtered = localPackTop3.filter(t => {
              const tLower = (t.title || '').toLowerCase();
              const tNoSpaces = tLower.replace(/\s+/g, '');
              return !tLower.includes(nameLower) && !tNoSpaces.includes(nameNoSpaces);
            });
            kwCompetitors = [...filtered, ...kwCompetitors];
          }

          // Extract search volume from search_information if available
          const searchInfo = data.search_information || {};

          // Save to DB
          await pool.query(
            `INSERT INTO rank_tracking (project_id, keyword, location, location_code, language_code, serp_position, serp_url, serp_title, serp_snippet, serp_type, maps_position, maps_title, maps_rating, maps_reviews, maps_address, competitors, checked_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
            [projectId, kw.keyword, kw.location || '', kw.location_code, kw.language_code,
             serp.position, serp.url, serp.title, serp.snippet, serp.type,
             maps.position, maps.title, maps.rating, maps.reviews, maps.address,
             JSON.stringify(kwCompetitors), new Date(baseTime + idx).toISOString()]
          );

          if (idx < 3) console.log(`[rank-sync] "${query}" → serp=${serp.position || '>30'}, maps=${maps.position || 'N/A'}`);
          results[idx] = { keyword: kw.keyword, location: kw.location, serp_position: serp.position, maps_position: maps.position, local_pack_top3: localPackTop3.map(t => t.title), competitors: kwCompetitors.length };
        } catch (err) {
          console.error(`[rank-sync] Error for "${query}":`, err.message);
          results[idx] = { keyword: kw.keyword, location: kw.location, error: err.message };
        }
      });
      await Promise.all(promises);
    }

    // Fetch search volumes via DataForSEO for all tracked keywords
    if (DATAFORSEO_AUTH && kwRes.rows.length > 0) {
      try {
        const allKws = kwRes.rows.map(k => k.keyword);
        console.log(`[rank-sync] Fetching DataForSEO volumes for ${allKws.length} keywords`);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20000);
        const dfsRes = await fetch('https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': DATAFORSEO_AUTH },
          body: JSON.stringify([{ keywords: allKws, location_name: 'Australia', language_name: 'English' }]),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (dfsRes.ok) {
          const dfsData = await dfsRes.json();
          const volResults = dfsData?.tasks?.[0]?.result || [];
          let updated = 0;
          for (const r of volResults) {
            if (r.keyword && r.search_volume != null) {
              await pool.query(
                'UPDATE rank_keywords SET search_volume=$1 WHERE project_id=$2 AND LOWER(keyword)=LOWER($3)',
                [r.search_volume, projectId, r.keyword]
              );
              updated++;
            }
          }
          console.log(`[rank-sync] Updated ${updated} keyword volumes via DataForSEO`);
        } else {
          console.log(`[rank-sync] DataForSEO volume fetch failed: HTTP ${dfsRes.status}`);
        }
      } catch (volErr) {
        console.log(`[rank-sync] DataForSEO volume fetch error: ${volErr.message}`);
      }
    }

    const synced = results.filter(r => r && !r.error).length;
    console.log(`[rank-sync] Done. Synced ${synced}/${kwRes.rows.length} keywords.`);
    res.json({ ok: true, synced, results: results.filter(Boolean) });
  } catch (e) {
    console.error('[rank-sync] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get latest rankings for a project
app.get('/api/projects/:projectId/rank-tracking/latest', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT ON (rt.keyword, rt.location) rt.keyword, rt.location, rt.serp_position, rt.serp_url, rt.maps_position, rt.maps_title, rt.maps_rating, rt.maps_reviews, rt.competitors, rt.checked_at,
             g.position AS gsc_position, g.clicks AS gsc_clicks, g.impressions AS gsc_impressions, g.ctr AS gsc_ctr
      FROM rank_tracking rt
      LEFT JOIN gsc_keywords g ON g.project_id = rt.project_id AND LOWER(g.keyword) = LOWER(rt.keyword)
      WHERE rt.project_id=$1
      ORDER BY rt.keyword, rt.location, rt.checked_at DESC
    `, [req.params.projectId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get rank history for a keyword (for charts)
app.get('/api/projects/:projectId/rank-tracking/history', async (req, res) => {
  const { keyword, days } = req.query;
  try {
    const { rows } = await pool.query(`
      SELECT keyword, serp_position, maps_position, competitors, checked_at
      FROM rank_tracking WHERE project_id=$1 ${keyword ? 'AND keyword=$2' : ''}
      AND checked_at > NOW() - INTERVAL '${parseInt(days) || 30} days'
      ORDER BY checked_at ASC
    `, keyword ? [req.params.projectId, keyword] : [req.params.projectId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Import keywords from GSC into rank tracking
app.post('/api/projects/:projectId/rank-tracking/import', async (req, res) => {
  const { projectId } = req.params;
  const { limit: maxKw } = req.body;
  try {
    let keywords = new Set();

    // Import from GSC
    try {
      const gscRes = await pool.query(
        `SELECT keyword FROM gsc_keywords WHERE project_id=$1 AND keyword IS NOT NULL ORDER BY impressions DESC LIMIT $2`,
        [projectId, maxKw || 50]
      );
      gscRes.rows.forEach(r => keywords.add(r.keyword.toLowerCase()));
    } catch (e) { console.log('gsc_keywords table error, skipping:', e.message); }

    if (keywords.size === 0) {
      return res.json({ error: 'No keywords found. Connect Google Search Console first to import keywords.' });
    }

    let added = 0;
    for (const kw of keywords) {
      const r = await pool.query(
        `INSERT INTO rank_keywords (project_id, keyword, location) VALUES ($1, $2, $3) ON CONFLICT (project_id, keyword, location) DO NOTHING RETURNING id`,
        [projectId, kw, '']
      );
      if (r.rows.length > 0) added++;
    }

    const { rows } = await pool.query('SELECT * FROM rank_keywords WHERE project_id=$1 ORDER BY keyword', [projectId]);
    res.json({ ok: true, imported: added, total: rows.length, keywords: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Discover keywords a domain ranks for via SerpAPI (site: search)
app.post('/api/projects/:projectId/rank-tracking/discover', async (req, res) => {
  if (!SERPAPI_KEY) return res.status(503).json({ error: 'SERPAPI_KEY not configured' });
  const { projectId } = req.params;
  const limit = parseInt(req.body.limit) || 50; // Default 50, accepts 10/20/30/40/50
  try {
    const projRes = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    if (projRes.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = projRes.rows[0];
    const domain = (project.website || project.domain || '').replace(/^https?:\/\//, '').replace(/\/$/, '').replace(/^www\./, '');

    if (!domain) return res.status(400).json({ error: 'Project has no website/domain configured' });

    console.log(`[discover] Fetching ranked keywords for ${domain} via SerpAPI (limit: ${limit})`);

    // Use Google organic search with site: to find pages that rank, then extract keywords
    // Also check GSC data first as a primary keyword source
    const keywords = [];
    const seen = new Set();

    // 1. Pull from GSC if available
    try {
      const gscRes = await pool.query(
        `SELECT keyword, position, clicks, impressions FROM gsc_keywords WHERE project_id=$1 AND keyword IS NOT NULL ORDER BY impressions DESC LIMIT $2`,
        [projectId, limit * 4]
      );
      for (const r of gscRes.rows) {
        const kw = r.keyword.toLowerCase().trim();
        if (kw && !seen.has(kw)) {
          seen.add(kw);
          keywords.push({ keyword: r.keyword, volume: r.impressions || null, position: Math.round(r.position) || null, url: null, competition: null, source: 'gsc', clicks: r.clicks, impressions: r.impressions });
        }
      }
      console.log(`[discover] Found ${keywords.length} keywords from GSC`);
    } catch (e) { console.log('[discover] GSC lookup skipped:', e.message); }

    // 2. Use SerpAPI to search for the domain and extract related keywords from SERP features
    const searchQueries = [`site:${domain}`, domain];
    for (const q of searchQueries) {
      try {
        const data = await serpApiSearch({
          engine: 'google',
          q: q,
          google_domain: 'google.com.au',
          gl: 'au',
          hl: 'en',
          num: 100
        });

        // Extract related searches as keyword suggestions
        for (const rs of (data.related_searches || [])) {
          const kw = (rs.query || '').toLowerCase().trim();
          if (kw && !seen.has(kw)) {
            seen.add(kw);
            keywords.push({ keyword: rs.query, volume: null, position: null, url: null, competition: null, source: 'related' });
          }
        }

        // Extract "people also ask" as keyword ideas
        for (const paa of (data.related_questions || [])) {
          const kw = (paa.question || '').toLowerCase().trim();
          if (kw && !seen.has(kw)) {
            seen.add(kw);
            keywords.push({ keyword: paa.question, volume: null, position: null, url: null, competition: null, source: 'paa' });
          }
        }

        // Extract organic result URLs that belong to this domain
        for (const item of (data.organic_results || [])) {
          const itemDomain = (item.displayed_link || item.link || '').replace(/^https?:\/\//, '').replace(/\/$/, '').replace(/^www\./, '').toLowerCase();
          if (itemDomain.includes(domain.toLowerCase())) {
            // The title often contains the primary keyword for this page
            const title = (item.title || '').toLowerCase().replace(/\s*[-|–—].*$/, '').trim();
            if (title && title.length > 3 && title.length < 80 && !seen.has(title)) {
              seen.add(title);
              keywords.push({ keyword: item.title.replace(/\s*[-|–—].*$/, '').trim(), volume: null, position: item.position, url: item.link, competition: null, source: 'serp' });
            }
          }
        }
      } catch (e) {
        console.log(`[discover] SerpAPI query "${q}" failed:`, e.message);
      }
    }

    // Sort by relevance: GSC keywords with impressions first, then by position
    keywords.sort((a, b) => {
      if (a.source === 'gsc' && b.source !== 'gsc') return -1;
      if (b.source === 'gsc' && a.source !== 'gsc') return 1;
      if (a.impressions && b.impressions) return b.impressions - a.impressions;
      if (a.position && b.position) return a.position - b.position;
      return 0;
    });

    const capped = keywords.slice(0, limit);
    console.log(`[discover] Found ${keywords.length} total, returning top ${capped.length} (limit: ${limit}) for ${domain}`);

    // Fetch search volume from DataForSEO Keywords Data API
    if (DATAFORSEO_AUTH && capped.length > 0) {
      try {
        console.log(`[discover] Fetching search volume for ${capped.length} keywords via DataForSEO`);
        const dfsBody = [{
          keywords: capped.map(k => k.keyword),
          location_name: 'Australia',
          language_name: 'English',
        }];
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        const dfsRes = await fetch('https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': DATAFORSEO_AUTH },
          body: JSON.stringify(dfsBody),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        const dfsText = await dfsRes.text();
        console.log(`[discover] DataForSEO HTTP ${dfsRes.status}, body length: ${dfsText.length}`);
        console.log(`[discover] DataForSEO raw (first 500): ${dfsText.slice(0, 500)}`);
        const dfsData = JSON.parse(dfsText);
        const task = dfsData.tasks?.[0];
        if (task?.result) {
          const volMap = {};
          for (const r of task.result) {
            if (r.keyword && r.search_volume != null) {
              volMap[r.keyword.toLowerCase()] = r.search_volume;
            }
          }
          for (const kw of capped) {
            const vol = volMap[kw.keyword.toLowerCase()];
            if (vol != null) kw.volume = vol;
          }
          console.log(`[discover] Got volume for ${Object.keys(volMap).length}/${capped.length} keywords`);
        } else {
          console.log(`[discover] DataForSEO no results. Status: ${task?.status_code} ${task?.status_message}`);
        }
      } catch (e) {
        console.log(`[discover] DataForSEO volume lookup failed: ${e.name}: ${e.message}`);
      }
    }

    res.json({ ok: true, keywords: capped, total: keywords.length, limit });
  } catch (e) {
    console.error('[discover] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==================== 12. MONTHLY REPORTS ====================

// List reports for a project
app.get('/api/projects/:projectId/reports', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM monthly_reports WHERE project_id=$1 ORDER BY month DESC', [req.params.projectId]);
    const reports = r.rows.map(row => {
      const data = typeof row.report_data === 'string' ? JSON.parse(row.report_data) : (row.report_data || {});
      return { id: row.id, month: row.month, createdAt: row.created_at, ...data };
    });
    res.json({ reports });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Generate monthly report
app.post('/api/projects/:projectId/reports/generate', async (req, res) => {
  const { projectId } = req.params;
  try {
    const proj = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    if (proj.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = proj.rows[0];

    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const monthLabel = now.toLocaleDateString('en-AU', { year: 'numeric', month: 'long' });

    // 1. Maps Rankings — from grid_scans (most accurate) + rank_tracking
    const gridRes = await pool.query(
      `SELECT keyword, arp, atrp, solv, found_in, data_points, grid_size, competitors, scanned_at
       FROM grid_scans WHERE project_id=$1 ORDER BY scanned_at DESC`,
      [projectId]
    );
    // Latest scan per keyword
    const latestGrid = {};
    for (const r of gridRes.rows) { if (!latestGrid[r.keyword]) latestGrid[r.keyword] = r; }
    const gridEntries = Object.values(latestGrid);
    const avgArp = gridEntries.length > 0 ? gridEntries.reduce((s, r) => s + (r.arp || 0), 0) / gridEntries.length : null;
    const avgAtrp = gridEntries.length > 0 ? gridEntries.reduce((s, r) => s + (r.atrp || 0), 0) / gridEntries.length : null;
    const avgSolv = gridEntries.length > 0 ? gridEntries.reduce((s, r) => s + (r.solv || 0), 0) / gridEntries.length : null;

    // Top keywords by grid scan
    const topMapKeywords = gridEntries
      .sort((a, b) => (a.arp || 99) - (b.arp || 99))
      .slice(0, 10)
      .map(r => ({
        keyword: r.keyword,
        arp: r.arp ? parseFloat(r.arp.toFixed(1)) : null,
        atrp: r.atrp ? parseFloat(r.atrp.toFixed(1)) : null,
        visibility: r.solv ? parseFloat((r.solv).toFixed(0)) : 0,
        found: r.found_in || 0,
        total: r.data_points || 0,
        status: r.solv >= 60 ? 'Dominant' : r.solv >= 30 ? 'Competitive' : r.solv > 0 ? 'Needs Work' : 'Not Visible'
      }));

    // Rank tracking fallback
    const rankRes = await pool.query(
      `SELECT keyword, serp_position, maps_position FROM rank_tracking
       WHERE project_id=$1 AND checked_at >= NOW() - INTERVAL '30 days' ORDER BY checked_at DESC`,
      [projectId]
    );
    const latestByKw = {};
    for (const r of rankRes.rows) { if (!latestByKw[r.keyword]) latestByKw[r.keyword] = r; }
    const rankEntries = Object.values(latestByKw);
    const serpPositions = rankEntries.filter(r => r.serp_position).map(r => r.serp_position);
    const mapsPositions = rankEntries.filter(r => r.maps_position).map(r => r.maps_position);
    const avgSerp = serpPositions.length > 0 ? serpPositions.reduce((a, b) => a + b, 0) / serpPositions.length : null;
    const avgMaps = mapsPositions.length > 0 ? mapsPositions.reduce((a, b) => a + b, 0) / mapsPositions.length : null;

    const mapsRankings = {
      totalKeywords: gridEntries.length || mapsPositions.length,
      avgArp: avgArp,
      avgAtrp: avgAtrp,
      avgVisibility: avgSolv,
      dominant: gridEntries.filter(r => r.solv >= 60).length,
      competitive: gridEntries.filter(r => r.solv >= 30 && r.solv < 60).length,
      needsWork: gridEntries.filter(r => r.solv > 0 && r.solv < 30).length,
      notVisible: gridEntries.filter(r => !r.solv || r.solv === 0).length,
      topKeywords: topMapKeywords,
      avgMapsPosition: avgMaps,
      mapsTop3: mapsPositions.filter(p => p <= 3).length,
    };

    const serpRankings = {
      avgPosition: avgSerp,
      keywordsTracked: rankEntries.length,
      top3: serpPositions.filter(p => p <= 3).length,
      top10: serpPositions.filter(p => p <= 10).length,
      page2: serpPositions.filter(p => p > 10 && p <= 20).length,
      notRanking: serpPositions.filter(p => p > 20).length,
    };

    // 2. GSC — pull live data if connected
    let gscData = { clicks: 0, impressions: 0, ctr: 0, avgPosition: null, topPages: [], topQueries: [], totalKeywords: 0 };
    try {
      const token = await getGscAccessToken(req.auth?.userId);
      if (token && project.gsc_property) {
        const endDate = now.toISOString().split('T')[0];
        const startDate = new Date(now - 30 * 86400000).toISOString().split('T')[0];

        // Top queries
        const qRes = await fetch('https://www.googleapis.com/webmasters/v3/sites/' + encodeURIComponent(project.gsc_property) + '/searchAnalytics/query', {
          method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ startDate, endDate, dimensions: ['query'], rowLimit: 20, orderBy: [{ fieldName: 'clicks', sortOrder: 'DESCENDING' }] }),
          signal: AbortSignal.timeout(15000),
        });
        if (qRes.ok) {
          const qData = await qRes.json();
          const rows = qData.rows || [];
          gscData.topQueries = rows.map(r => ({
            query: r.keys[0], clicks: r.clicks, impressions: r.impressions,
            ctr: parseFloat((r.ctr * 100).toFixed(1)), position: parseFloat(r.position.toFixed(1))
          }));
          gscData.clicks = rows.reduce((s, r) => s + r.clicks, 0);
          gscData.impressions = rows.reduce((s, r) => s + r.impressions, 0);
          gscData.totalKeywords = rows.length;
        }

        // Top pages
        const pRes = await fetch('https://www.googleapis.com/webmasters/v3/sites/' + encodeURIComponent(project.gsc_property) + '/searchAnalytics/query', {
          method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ startDate, endDate, dimensions: ['page'], rowLimit: 10, orderBy: [{ fieldName: 'clicks', sortOrder: 'DESCENDING' }] }),
          signal: AbortSignal.timeout(15000),
        });
        if (pRes.ok) {
          const pData = await pRes.json();
          gscData.topPages = (pData.rows || []).map(r => ({
            page: r.keys[0].replace(project.domain || '', '').replace(/^https?:\/\/[^/]+/, ''),
            clicks: r.clicks, impressions: r.impressions,
            ctr: parseFloat((r.ctr * 100).toFixed(1)), position: parseFloat(r.position.toFixed(1))
          }));
        }

        // Totals
        const tRes = await fetch('https://www.googleapis.com/webmasters/v3/sites/' + encodeURIComponent(project.gsc_property) + '/searchAnalytics/query', {
          method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ startDate, endDate }),
          signal: AbortSignal.timeout(15000),
        });
        if (tRes.ok) {
          const tData = await tRes.json();
          const tRows = tData.rows || [];
          if (tRows.length > 0) {
            gscData.clicks = tRows[0].clicks;
            gscData.impressions = tRows[0].impressions;
            gscData.ctr = parseFloat((tRows[0].ctr * 100).toFixed(1));
            gscData.avgPosition = parseFloat(tRows[0].position.toFixed(1));
          }
        }
      }
    } catch (gscErr) { console.log('[reports] GSC fetch skipped:', gscErr.message); }

    // Fallback to stored GSC keywords if no live data
    if (gscData.clicks === 0 && gscData.topQueries.length === 0) {
      const gscRes = await pool.query(
        'SELECT keyword, clicks, impressions, ctr, position FROM gsc_keywords WHERE project_id=$1 ORDER BY impressions DESC LIMIT 20',
        [projectId]
      );
      if (gscRes.rows.length > 0) {
        gscData.topQueries = gscRes.rows.map(r => ({
          query: r.keyword, clicks: r.clicks || 0, impressions: r.impressions || 0,
          ctr: r.ctr ? parseFloat((r.ctr * 100).toFixed(1)) : 0, position: r.position ? parseFloat(r.position.toFixed(1)) : null
        }));
        gscData.clicks = gscRes.rows.reduce((s, r) => s + (r.clicks || 0), 0);
        gscData.impressions = gscRes.rows.reduce((s, r) => s + (r.impressions || 0), 0);
        gscData.totalKeywords = gscRes.rows.length;
        if (gscData.impressions > 0) gscData.ctr = parseFloat((gscData.clicks / gscData.impressions * 100).toFixed(1));
      }
    }

    // 3. Audit findings with details
    const findingsRes = await pool.query(
      `SELECT pillar, severity, status, category, title FROM audit_findings WHERE project_id=$1 ORDER BY severity DESC, created_at DESC`,
      [projectId]
    );
    const findingsByPillar = {};
    const criticalFindings = [];
    for (const r of findingsRes.rows) {
      const p = r.pillar || 'other';
      if (!findingsByPillar[p]) findingsByPillar[p] = { total: 0, critical: 0, high: 0, medium: 0, approved: 0, dismissed: 0, pending: 0 };
      findingsByPillar[p].total++;
      if (r.severity === 'Critical') { findingsByPillar[p].critical++; criticalFindings.push({ pillar: p, title: r.title, status: r.status }); }
      if (r.severity === 'High') findingsByPillar[p].high++;
      if (r.severity === 'Medium') findingsByPillar[p].medium++;
      if (r.status === 'approved') findingsByPillar[p].approved++;
      if (r.status === 'dismissed') findingsByPillar[p].dismissed++;
      if (r.status === 'new') findingsByPillar[p].pending++;
    }

    // 4. Action items with detail
    const actionsRes = await pool.query(
      `SELECT status, pillar, title, severity FROM action_items WHERE project_id=$1 ORDER BY created_at DESC`,
      [projectId]
    );
    const actionsByStatus = { done: 0, pending: 0, 'in-progress': 0 };
    const recentActions = [];
    for (const r of actionsRes.rows) {
      actionsByStatus[r.status] = (actionsByStatus[r.status] || 0) + 1;
      recentActions.push({ title: r.title, status: r.status, pillar: r.pillar, severity: r.severity });
    }
    const totalActions = Object.values(actionsByStatus).reduce((s, v) => s + v, 0);
    const completionRate = totalActions > 0 ? Math.round((actionsByStatus.done / totalActions) * 100) : 0;

    // 5. On-page audit stats
    let onPageStats = { totalPages: 0, avgScore: 0, pagesFixed: 0, issuesFound: 0 };
    try {
      const opRes = await pool.query('SELECT results FROM onpage_audit_cache WHERE project_id=$1', [projectId]);
      if (opRes.rows.length > 0 && opRes.rows[0].results) {
        const pages = typeof opRes.rows[0].results === 'string' ? JSON.parse(opRes.rows[0].results) : opRes.rows[0].results;
        if (Array.isArray(pages)) {
          onPageStats.totalPages = pages.length;
          const scores = pages.map(p => p.seoScore || 0);
          onPageStats.avgScore = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
          onPageStats.issuesFound = pages.reduce((s, p) => s + (p.issues ? p.issues.filter(i => i.type !== 'good').length : 0), 0);
        }
      }
      const fixRes = await pool.query(`SELECT COUNT(*) as cnt FROM wp_change_history WHERE project_id=$1 AND rolled_back_at IS NULL`, [projectId]);
      onPageStats.pagesFixed = parseInt(fixRes.rows[0]?.cnt || 0);
    } catch (e) { /* skip */ }

    // 6. PageSpeed scores
    let pageSpeedStats = null;
    try {
      const psRes = await pool.query(`SELECT report_data FROM audits WHERE project_id=$1 AND pillar='pagespeed' ORDER BY created_at DESC LIMIT 1`, [projectId]);
      if (psRes.rows.length > 0 && psRes.rows[0].report_data) {
        const psData = typeof psRes.rows[0].report_data === 'string' ? JSON.parse(psRes.rows[0].report_data) : psRes.rows[0].report_data;
        if (Array.isArray(psData) && psData.length > 0) {
          const scores = psData.filter(p => p.performance != null).map(p => p.performance);
          pageSpeedStats = {
            avgPerformance: scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
            good: scores.filter(s => s >= 90).length,
            needsImprovement: scores.filter(s => s >= 50 && s < 90).length,
            poor: scores.filter(s => s < 50).length,
            totalPages: psData.length,
          };
        }
      }
    } catch (e) { /* skip */ }

    // 7. AI-generated executive summary
    let executiveSummary = '';
    if (anthropic) {
      try {
        const summaryResp = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 500,
          system: 'You are an SEO agency report writer. Write a brief, professional executive summary (3-4 sentences) for a monthly SEO report. Be specific with numbers. No bullet points, no headers. Tone: confident, data-driven, action-oriented.',
          messages: [{ role: 'user', content: `Write an executive summary for ${project.business_name || project.name} (${project.domain}):
- Maps: ${gridEntries.length} keywords tracked, avg visibility ${avgSolv ? avgSolv.toFixed(0) + '%' : 'N/A'}, ${mapsRankings.dominant} dominant, ${mapsRankings.notVisible} not visible
- GSC: ${gscData.clicks} clicks, ${gscData.impressions} impressions, ${gscData.ctr}% CTR
- Audit: ${findingsRes.rows.length} total findings, ${criticalFindings.length} critical
- Actions: ${actionsByStatus.done} completed, ${actionsByStatus.pending} pending, ${completionRate}% completion rate
- On-page: ${onPageStats.totalPages} pages, avg SEO score ${onPageStats.avgScore}%, ${onPageStats.pagesFixed} fixes applied
- PageSpeed: ${pageSpeedStats ? `avg ${pageSpeedStats.avgPerformance}% performance` : 'not scanned'}` }]
        });
        executiveSummary = summaryResp.content[0].text;
      } catch (e) { console.log('[reports] AI summary skipped:', e.message); }
    }

    // 8. Overall health score (0-100)
    let healthScore = 50; // base
    if (avgSolv) healthScore = Math.min(100, Math.max(0, Math.round(
      (avgSolv * 0.3) + // Maps visibility weight
      (completionRate * 0.2) + // Action completion weight
      (onPageStats.avgScore * 0.2) + // On-page score weight
      ((pageSpeedStats?.avgPerformance || 50) * 0.15) + // PageSpeed weight
      (Math.min(100, (gscData.ctr || 0) * 20) * 0.15) // CTR weight (5% CTR = 100)
    )));

    // 9. Previous month comparison
    let previousMonth = null;
    try {
      const prevDate = new Date(now);
      prevDate.setMonth(prevDate.getMonth() - 1);
      const prevMonth = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`;
      const prevRes = await pool.query('SELECT report_data FROM monthly_reports WHERE project_id=$1 AND month=$2', [projectId, prevMonth]);
      if (prevRes.rows.length > 0) {
        const prev = typeof prevRes.rows[0].report_data === 'string' ? JSON.parse(prevRes.rows[0].report_data) : prevRes.rows[0].report_data;
        previousMonth = {
          healthScore: prev.healthScore,
          mapsRankings: { avgArp: prev.mapsRankings?.avgArp, avgVisibility: prev.mapsRankings?.avgVisibility },
          gscData: { clicks: prev.gscData?.clicks, impressions: prev.gscData?.impressions, ctr: prev.gscData?.ctr, avgPosition: prev.gscData?.avgPosition },
          onPageStats: { avgScore: prev.onPageStats?.avgScore },
          pageSpeedStats: { avgPerformance: prev.pageSpeedStats?.avgPerformance },
        };
      }
    } catch (e) { console.log('[reports] Previous month lookup skipped:', e.message); }

    const reportData = {
      version: 2,
      monthLabel,
      project: { name: project.business_name || project.name, domain: project.domain, industry: project.industry, location: project.location },
      healthScore,
      executiveSummary,
      mapsRankings,
      serpRankings,
      gscData,
      findingsByPillar,
      criticalFindings: criticalFindings.slice(0, 5),
      actions: { completed: actionsByStatus.done, inProgress: actionsByStatus['in-progress'], pending: actionsByStatus.pending, total: totalActions, completionRate, recentActions },
      onPageStats,
      pageSpeedStats,
      previousMonth,
      generatedAt: now.toISOString()
    };

    // Upsert report
    const r = await pool.query(
      `INSERT INTO monthly_reports (project_id, month, report_data) VALUES ($1, $2, $3)
       ON CONFLICT (project_id, month) DO UPDATE SET report_data=$3, created_at=NOW() RETURNING *`,
      [projectId, month, JSON.stringify(reportData)]
    );

    console.log(`[reports] Generated v2 ${month} report for project ${projectId}`);
    res.json({ report: { id: r.rows[0].id, month, createdAt: r.rows[0].created_at, ...reportData } });
  } catch (e) {
    console.error('[reports] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==================== 13. GBP POSTS ====================

// List all GBP posts for a project
app.get('/api/projects/:id/gbp-posts', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM gbp_posts WHERE project_id=$1 ORDER BY scheduled_date ASC',
      [req.params.id]
    );
    res.json({ posts: result.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create a new GBP post
app.post('/api/projects/:id/gbp-posts', async (req, res) => {
  const { title, body, post_type, cta_type, cta_url, offer_code, event_title, event_start, event_end, image_url, scheduled_date, scheduled_time, status } = req.body;
  if (!body || !scheduled_date) return res.status(400).json({ error: 'body and scheduled_date required' });
  try {
    const result = await pool.query(
      `INSERT INTO gbp_posts (project_id, title, body, post_type, cta_type, cta_url, offer_code, event_title, event_start, event_end, image_url, scheduled_date, scheduled_time, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
      [req.params.id, title || null, body, post_type || 'update', cta_type || null, cta_url || null, offer_code || null, event_title || null, event_start || null, event_end || null, image_url || null, scheduled_date, scheduled_time || '09:00', status || 'draft']
    );
    res.status(201).json({ post: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update a GBP post
app.put('/api/gbp-posts/:id', async (req, res) => {
  const { title, body, post_type, cta_type, cta_url, offer_code, event_title, event_start, event_end, image_url, scheduled_date, scheduled_time, status } = req.body;
  try {
    const result = await pool.query(
      `UPDATE gbp_posts
       SET title=COALESCE($2, title), body=COALESCE($3, body), post_type=COALESCE($4, post_type),
           cta_type=$5, cta_url=$6, offer_code=$7, event_title=$8, event_start=$9, event_end=$10,
           image_url=$11, scheduled_date=COALESCE($12, scheduled_date), scheduled_time=COALESCE($13, scheduled_time),
           status=COALESCE($14, status), updated_at=NOW()
       WHERE id=$1 RETURNING *`,
      [req.params.id, title, body, post_type, cta_type || null, cta_url || null, offer_code || null, event_title || null, event_start || null, event_end || null, image_url || null, scheduled_date, scheduled_time, status]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Post not found' });
    res.json({ post: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete a GBP post
app.delete('/api/gbp-posts/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM gbp_posts WHERE id=$1 RETURNING id',
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Post not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Publish a GBP post via Late.dev API
app.post('/api/gbp-posts/:id/publish', async (req, res) => {
  if (!LATE_API_KEY) return res.status(400).json({ error: 'LATE_API_KEY not configured' });
  try {
    const postResult = await pool.query('SELECT * FROM gbp_posts WHERE id=$1', [req.params.id]);
    if (postResult.rows.length === 0) return res.status(404).json({ error: 'Post not found' });
    const post = postResult.rows[0];

    // Call Late.dev API to publish
    const mediaUrls = post.image_url ? [post.image_url] : [];
    const lateResponse = await fetch('https://api.getlate.dev/v1/post/create', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LATE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text: post.body,
        platforms: ['gbp'],
        mediaUrls: mediaUrls
      })
    });

    if (!lateResponse.ok) {
      const error = await lateResponse.text();
      console.error(`[gbp-posts] Late.dev API error: ${lateResponse.status} ${error}`);
      // Update status to failed
      await pool.query('UPDATE gbp_posts SET status=$1 WHERE id=$2', ['failed', req.params.id]);
      return res.status(400).json({ error: `Late.dev API failed: ${error.substring(0, 200)}` });
    }

    const lateData = await lateResponse.json();
    const latePostId = lateData.id || lateData.post_id;

    // Update post status and save Late post ID
    const updateResult = await pool.query(
      'UPDATE gbp_posts SET status=$1, late_post_id=$2, published_at=NOW(), updated_at=NOW() WHERE id=$3 RETURNING *',
      ['published', latePostId, req.params.id]
    );

    res.json({ post: updateResult.rows[0] });
  } catch (e) {
    console.error(`[gbp-posts] Publish error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// Generate a month of GBP posts via AI
app.post('/api/projects/:id/gbp-posts/generate', async (req, res) => {
  if (!anthropic) return res.status(400).json({ error: 'Anthropic API not configured' });
  try {
    const projectResult = await pool.query(
      'SELECT business_name, industry, location, service_areas FROM projects WHERE id=$1',
      [req.params.id]
    );
    if (projectResult.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = projectResult.rows[0];

    const serviceAreas = Array.isArray(project.service_areas) ? project.service_areas.map(a => a.name).join(', ') : 'N/A';

    // Call Haiku to generate posts
    const prompt = `Generate 4 weeks of Google Business Profile (GBP) posts for this business. Each post should be different and engaging.

Business Info:
- Name: ${project.business_name || 'N/A'}
- Industry: ${project.industry || 'N/A'}
- Location: ${project.location || 'N/A'}
- Service Areas: ${serviceAreas}

Create exactly 4 posts, one for each of the next 4 weeks. Mix the post types: 2 updates, 1 offer, 1 event. Keep each post under 1500 characters.

Respond with a valid JSON array (no markdown, just raw JSON) with this structure:
[{
  "title": "Post title",
  "body": "Post content",
  "post_type": "update|offer|event",
  "cta_type": "LEARN_MORE|BOOK|ORDER|CALL|null",
  "week_number": 1
}]`;

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });

    let jsonText = message.content[0].type === 'text' ? message.content[0].text : '';
    // Extract JSON from markdown code blocks if present
    const jsonMatch = jsonText.match(/```(?:json)?\n?([\s\S]*?)\n?```/);
    if (jsonMatch) jsonText = jsonMatch[1];
    const posts = JSON.parse(jsonText);

    if (!Array.isArray(posts) || posts.length === 0) {
      return res.status(400).json({ error: 'AI response was not a valid post array' });
    }

    // Spread posts across next 4 weeks
    const now = new Date();
    const insertedPosts = [];
    for (let i = 0; i < posts.length; i++) {
      const post = posts[i];
      const weekOffset = (post.week_number || i + 1) - 1;
      const postDate = new Date(now);
      postDate.setDate(postDate.getDate() + weekOffset * 7);
      const dateStr = postDate.toISOString().split('T')[0];

      const insertResult = await pool.query(
        `INSERT INTO gbp_posts (project_id, title, body, post_type, cta_type, scheduled_date, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'draft') RETURNING *`,
        [req.params.id, post.title || null, post.body, post.post_type || 'update', post.cta_type || null, dateStr]
      );
      insertedPosts.push(insertResult.rows[0]);
    }

    res.status(201).json({ posts: insertedPosts, message: `Generated ${insertedPosts.length} posts` });
  } catch (e) {
    console.error(`[gbp-posts] Generate error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ==================== 14. BLOG CONTENT SYSTEM ====================

// GET blog posts for a project
app.get('/api/projects/:id/blog-posts', async (req, res) => {
  try {
    const { id: projectId } = req.params;
    const r = await pool.query(
      `SELECT * FROM content_queue
       WHERE project_id=$1 AND content_type='blog'
       ORDER BY target_publish_date ASC NULLS LAST, created_at DESC`,
      [projectId]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST create new blog post
app.post('/api/projects/:id/blog-posts', async (req, res) => {
  try {
    const { id: projectId } = req.params;
    const { title, focus_keyword, target_keywords, target_publish_date, blog_category, blog_tags, word_count, notes } = req.body;

    const shareToken = crypto.randomUUID();
    const r = await pool.query(
      `INSERT INTO content_queue
       (project_id, content_type, title, current_focus_keyword, target_keywords, target_publish_date, blog_category, blog_tags,
        current_word_count, notes, share_token, status, client_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [projectId, 'blog', title, focus_keyword, JSON.stringify(target_keywords || []), target_publish_date,
       blog_category, blog_tags || [], word_count || 1500, notes, shareToken, 'draft', 'not_sent']
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST generate AI draft for blog post
app.post('/api/projects/:id/blog-posts/:postId/generate-draft', async (req, res) => {
  try {
    const { id: projectId, postId } = req.params;

    if (!anthropic) return res.status(500).json({ error: 'Claude API not configured' });

    // Get blog post
    const post = (await pool.query('SELECT * FROM content_queue WHERE id=$1 AND project_id=$2', [postId, projectId])).rows[0];
    if (!post) return res.status(404).json({ error: 'Blog post not found' });

    // Get project info
    const project = (await pool.query('SELECT * FROM projects WHERE id=$1', [projectId])).rows[0];
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // Build prompt
    const targetKeywords = post.target_keywords ? JSON.parse(post.target_keywords) : [];
    const keywordList = targetKeywords.length > 0 ? targetKeywords.join(', ') : 'target keywords';

    const prompt = `You are an SEO copywriter. Write a comprehensive, SEO-optimized blog post.

Title: "${post.current_focus_keyword || post.title}"
Focus Keyword: "${post.current_focus_keyword || ''}"
Target Keywords: ${keywordList}
Target Word Count: ${post.current_word_count || 1500} words
Business: ${project.business_name || project.name}
Industry: ${project.industry || 'general'}

Requirements:
- Start with a compelling intro paragraph that includes the focus keyword naturally
- Use H2 and H3 headings to structure the content
- Include the focus keyword in the first H2 heading
- Incorporate target keywords naturally throughout
- Write for both humans and search engines
- Use clear, engaging language appropriate for ${project.industry || 'the industry'}
- Include practical tips and actionable insights
- End with a strong conclusion and call-to-action
- Format as HTML with proper semantic tags

Output ONLY the HTML content (starting with a P tag for the intro), no meta tags.`;

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });

    const draftContent = message.content[0].type === 'text' ? message.content[0].text : '';

    // Generate meta title and description
    const metaPrompt = `Given this blog post content and focus keyword "${post.current_focus_keyword}", generate:
1. A concise meta title (50-60 characters)
2. A compelling meta description (150-160 characters)

Format your response as JSON: { "meta_title": "...", "meta_description": "..." }`;

    const metaMessage = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: metaPrompt }]
    });

    let metaTitle = '', metaDesc = '';
    try {
      const metaText = metaMessage.content[0].type === 'text' ? metaMessage.content[0].text : '{}';
      const metaJson = JSON.parse(metaText);
      metaTitle = metaJson.meta_title || '';
      metaDesc = metaJson.meta_description || '';
    } catch (e) {
      console.log('[blog-gen] Meta parse error:', e.message);
    }

    // Update post
    const wordCount = draftContent.replace(/<[^>]+>/g, '').trim().split(/\s+/).filter(Boolean).length;
    const updated = await pool.query(
      `UPDATE content_queue SET draft_content=$1, draft_meta_title=$2, draft_meta_desc=$3, draft_word_count=$4, updated_at=NOW()
       WHERE id=$5 RETURNING *`,
      [draftContent, metaTitle, metaDesc, wordCount, postId]
    );

    res.json(updated.rows[0]);
  } catch (e) {
    console.error('[blog-gen]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST send blog to client
app.post('/api/projects/:id/blog-posts/:postId/send-to-client', async (req, res) => {
  try {
    const { id: projectId, postId } = req.params;
    const { client_name, client_email } = req.body;

    const r = await pool.query(
      `UPDATE content_queue SET client_status=$1, client_name=$2, client_email=$3, updated_at=NOW()
       WHERE id=$4 AND project_id=$5 RETURNING *`,
      ['pending_review', client_name, client_email, postId, projectId]
    );

    if (r.rows.length === 0) return res.status(404).json({ error: 'Blog post not found' });
    const post = r.rows[0];
    const shareUrl = `${process.env.APP_URL || 'https://seo-room-v5-production.up.railway.app'}/blog-review/${post.share_token}`;

    res.json({ ...post, shareUrl });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET public blog review page (no auth required)
app.get('/api/blog-review/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const r = await pool.query(
      `SELECT id, title, draft_content, draft_meta_title, draft_meta_desc, current_focus_keyword, client_status, client_comments
       FROM content_queue WHERE share_token=$1`,
      [token]
    );

    if (r.rows.length === 0) return res.status(404).json({ error: 'Blog post not found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST comment on blog review (public)
app.post('/api/blog-review/:token/comment', async (req, res) => {
  try {
    const { token } = req.params;
    const { name, comment } = req.body;

    const post = (await pool.query('SELECT client_comments FROM content_queue WHERE share_token=$1', [token])).rows[0];
    if (!post) return res.status(404).json({ error: 'Blog post not found' });

    const comments = post.client_comments || [];
    comments.push({ name, comment, timestamp: new Date().toISOString() });

    const r = await pool.query(
      `UPDATE content_queue SET client_comments=$1, updated_at=NOW() WHERE share_token=$2 RETURNING *`,
      [JSON.stringify(comments), token]
    );

    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST approve blog (public)
app.post('/api/blog-review/:token/approve', async (req, res) => {
  try {
    const { token } = req.params;
    const { name } = req.body;

    const r = await pool.query(
      `UPDATE content_queue SET client_status=$1, client_reviewed_at=NOW(), updated_at=NOW()
       WHERE share_token=$2 RETURNING *`,
      ['approved', token]
    );

    if (r.rows.length === 0) return res.status(404).json({ error: 'Blog post not found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST request changes (public)
app.post('/api/blog-review/:token/request-changes', async (req, res) => {
  try {
    const { token } = req.params;
    const { name, comment } = req.body;

    const post = (await pool.query('SELECT client_comments FROM content_queue WHERE share_token=$1', [token])).rows[0];
    if (!post) return res.status(404).json({ error: 'Blog post not found' });

    const comments = post.client_comments || [];
    comments.push({ name, comment, timestamp: new Date().toISOString(), type: 'change_request' });

    const r = await pool.query(
      `UPDATE content_queue SET client_status=$1, client_comments=$2, updated_at=NOW()
       WHERE share_token=$3 RETURNING *`,
      ['changes_requested', JSON.stringify(comments), token]
    );

    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST publish blog to WordPress
app.post('/api/projects/:id/blog-posts/:postId/publish', async (req, res) => {
  try {
    const { id: projectId, postId } = req.params;

    const post = (await pool.query('SELECT * FROM content_queue WHERE id=$1 AND project_id=$2', [postId, projectId])).rows[0];
    if (!post) return res.status(404).json({ error: 'Blog post not found' });
    if (post.client_status !== 'approved') return res.status(400).json({ error: 'Blog post must be approved before publishing' });

    const project = (await pool.query('SELECT * FROM projects WHERE id=$1', [projectId])).rows[0];
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const wpBase = (project.wordpress_url || '').replace(/\/$/, '');
    if (!wpBase) return res.status(400).json({ error: 'WordPress URL not configured' });

    const authHeaders = getWpAuthHeaders(project);

    // Create WordPress post
    const wpPayload = {
      title: post.title || post.current_focus_keyword,
      content: post.draft_content || '',
      status: 'publish'
    };

    // Add Yoast meta if available
    if (post.draft_meta_title || post.draft_meta_desc) {
      wpPayload.yoast_head_json = {
        title: post.draft_meta_title,
        description: post.draft_meta_desc
      };
    }

    const wpRes = await fetch(`${wpBase}/wp-json/wp/v2/posts`, {
      method: 'POST',
      headers: { ...(authHeaders || {}), 'Content-Type': 'application/json' },
      body: JSON.stringify(wpPayload)
    });

    if (!wpRes.ok) {
      const wpErr = await wpRes.text();
      throw new Error(`WordPress API error: ${wpRes.status} - ${wpErr}`);
    }

    const wpPost = await wpRes.json();

    // Save to wp_change_history
    await pool.query(
      `INSERT INTO wp_change_history (project_id, page_id, page_url, page_title, change_type, field_name, new_value)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [projectId, wpPost.id, wpPost.link, post.title, 'publish', 'blog_post_created', JSON.stringify(wpPost)]
    );

    // Update blog post status
    const updated = await pool.query(
      `UPDATE content_queue SET status=$1, published_at=NOW(), page_id=$2, page_url=$3, updated_at=NOW()
       WHERE id=$4 RETURNING *`,
      ['published', wpPost.id, wpPost.link, postId]
    );

    res.json(updated.rows[0]);
  } catch (e) {
    console.error('[blog-publish]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST import keywords for blog posts
app.post('/api/projects/:id/blog-posts/import-keywords', async (req, res) => {
  try {
    const { id: projectId } = req.params;
    const { keywords, target_post_id } = req.body; // keywords: [{keyword, volume, competition}]

    if (!keywords || !Array.isArray(keywords)) {
      return res.status(400).json({ error: 'Keywords array required' });
    }

    // If target_post_id specified, add to that post's target_keywords
    if (target_post_id) {
      const post = (await pool.query('SELECT * FROM content_queue WHERE id=$1 AND project_id=$2', [target_post_id, projectId])).rows[0];
      if (!post) return res.status(404).json({ error: 'Blog post not found' });

      const existing = post.target_keywords ? JSON.parse(post.target_keywords) : [];
      const newKeywords = keywords.map(k => k.keyword);
      const combined = [...new Set([...existing, ...newKeywords])];

      const r = await pool.query(
        `UPDATE content_queue SET target_keywords=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
        [JSON.stringify(combined), target_post_id]
      );
      return res.json(r.rows[0]);
    }

    // Otherwise create new blog posts from keywords
    const posts = [];
    for (const kw of keywords) {
      const shareToken = crypto.randomUUID();
      const r = await pool.query(
        `INSERT INTO content_queue
         (project_id, content_type, title, current_focus_keyword, target_keywords, current_word_count,
          share_token, status, client_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [projectId, 'blog', kw.keyword, kw.keyword, JSON.stringify([kw.keyword]), 1500, shareToken, 'draft', 'not_sent']
      );
      posts.push(r.rows[0]);
    }

    res.json({ created: posts.length, posts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== 15. SERVE ====================

// Health check
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('/api/debug/outbound-ip', async (req, res) => {
  try {
    const r = await fetch('https://api.ipify.org');
    const ip = await r.text();
    res.json({ outbound_ip: ip });
  } catch (e) { res.json({ error: e.message }); }
});

// Static files
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, etag: false }));

// Serve index.html for all other routes (SPA fallback)
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.type('html').send(INDEX_HTML);
});

// ==================== 16. STARTUP ====================

async function start() {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`[boot] SEO Room v5 listening on port ${PORT}`);
    });
  } catch (e) {
    console.error('[boot] Startup failed:', e.message);
    process.exit(1);
  }
}

start();
