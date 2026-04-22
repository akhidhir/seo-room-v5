const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
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

// External APIs
const DATAFORSEO_LOGIN = process.env.DATAFORSEO_LOGIN;
const DATAFORSEO_PASSWORD = process.env.DATAFORSEO_PASSWORD;
const LOCAL_FALCON_KEY = process.env.LOCAL_FALCON_KEY;

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
if (!DATAFORSEO_LOGIN) console.warn('[boot] DATAFORSEO_LOGIN not set — SERP rank tracking disabled');
if (!LOCAL_FALCON_KEY) console.warn('[boot] LOCAL_FALCON_KEY not set — Maps rank tracking disabled');
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
app.use(express.json({ limit: '10mb' }));

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
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Project integrations (GBP, GSC, DataForSEO, Local Falcon, WordPress, Ahrefs)
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
  const token = req.headers.authorization?.split(' ')[1];
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
  const whitelistPaths = ['/api/auth/register', '/api/auth/login', '/api/health', '/api/gsc/callback'];
  if (whitelistPaths.includes(req.path)) return next();
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
  const { name, domain, business_name, industry, location, competitors, is_local_business } = req.body;
  if (!name || !domain) return res.status(400).json({ error: 'Name and domain required' });
  try {
    const result = await pool.query(
      `INSERT INTO projects (user_id, name, domain, business_name, industry, location, competitors, is_local_business)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [req.auth.userId, name, domain, business_name || null, industry || null, location || null, competitors || [], is_local_business !== false]
    );
    res.status(201).json({ project: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get project
app.get('/api/projects/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM projects WHERE id=$1 AND user_id=$2',
      [req.params.id, req.auth.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    res.json({ project: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update project
app.put('/api/projects/:id', async (req, res) => {
  const { name, domain, business_name, industry, location, competitors, is_local_business } = req.body;
  try {
    const result = await pool.query(
      `UPDATE projects
       SET name=COALESCE($2, name), domain=COALESCE($3, domain), business_name=COALESCE($4, business_name),
           industry=COALESCE($5, industry), location=COALESCE($6, location), competitors=COALESCE($7, competitors),
           is_local_business=COALESCE($8, is_local_business)
       WHERE id=$1 AND user_id=$9
       RETURNING *`,
      [req.params.id, name, domain, business_name, industry, location, competitors, is_local_business, req.auth.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    res.json({ project: result.rows[0] });
  } catch (e) {
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

// Get/set service areas for a project
app.get('/api/projects/:id/service-areas', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT service_areas FROM projects WHERE id=$1 AND user_id=$2',
      [req.params.id, req.auth.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    res.json({ service_areas: result.rows[0].service_areas || [] });
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

// List findings for a project
app.get('/api/projects/:id/audit-findings', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM audit_findings WHERE project_id=$1 ORDER BY created_at DESC',
      [req.params.id]
    );
    res.json({ findings: result.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update finding status (approve/reject)
app.put('/api/audit-findings/:id', async (req, res) => {
  const { status } = req.body;
  try {
    const result = await pool.query(
      'UPDATE audit_findings SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING *',
      [status, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Finding not found' });
    res.json({ finding: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== 7. ACTION PLAN ====================

// Get action items for a project
app.get('/api/projects/:id/action-items', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM action_items WHERE project_id=$1 ORDER BY created_at DESC',
      [req.params.id]
    );
    res.json({ action_items: result.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update action item (approve/skip/mark done)
app.put('/api/action-items/:id', async (req, res) => {
  const { status, approved_at } = req.body;
  try {
    const result = await pool.query(
      `UPDATE action_items
       SET status=$1, approved_at=COALESCE($2, approved_at)
       WHERE id=$3 RETURNING *`,
      [status, approved_at || null, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Action item not found' });
    res.json({ action_item: result.rows[0] });
  } catch (e) {
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

// ==================== 8. MAPS RANKINGS ====================

// Get Maps keywords for a project
app.get('/api/projects/:id/maps/keywords', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM rank_keywords
       WHERE project_id=$1 AND location IS NOT NULL AND location != ''
       ORDER BY added_at DESC`,
      [req.params.id]
    );
    res.json({ keywords: result.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Add Maps keywords
app.post('/api/projects/:id/maps/keywords', async (req, res) => {
  const { keywords, location, location_code } = req.body;
  if (!Array.isArray(keywords) || !location) {
    return res.status(400).json({ error: 'keywords array and location required' });
  }
  try {
    let added = 0;
    for (const kw of keywords) {
      if (!kw || typeof kw !== 'string') continue;
      await pool.query(
        `INSERT INTO rank_keywords (project_id, keyword, location, location_code)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (project_id, keyword, location) DO NOTHING`,
        [req.params.id, kw.trim(), location, location_code || 2036]
      );
      added++;
    }
    res.json({ ok: true, added });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete a Maps keyword
app.delete('/api/maps/keywords/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM rank_keywords WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Sync Maps keywords with Local Falcon
app.post('/api/projects/:id/maps/sync-localfalcon', async (req, res) => {
  if (!LOCAL_FALCON_KEY) {
    return res.status(503).json({ error: 'LOCAL_FALCON_KEY not configured' });
  }
  const { id: projectId } = req.params;
  try {
    // Get project details
    const projResult = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    if (projResult.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = projResult.rows[0];

    // Fetch reports from Local Falcon
    const lfResp = await fetch(`https://api.localfalcon.com/v1/reports?api_key=${LOCAL_FALCON_KEY}`, {
      headers: { 'Accept': 'application/json' }
    });
    const lfData = await lfResp.json();
    if (!lfData.success) return res.status(400).json({ error: lfData.message || 'Local Falcon API error' });

    const reports = lfData.data?.reports || [];
    console.log(`[maps-localfalcon] Got ${reports.length} reports for project ${projectId}`);

    // Sync each report into rank_keywords and rank_tracking
    let synced = 0;
    const baseTime = Date.now();
    for (let i = 0; i < reports.length; i++) {
      const report = reports[i];
      const keyword = report.keyword || '';
      if (!keyword) continue;

      // Parse keyword + location from report
      const parts = keyword.split(/\s+/);
      const kwBase = parts[0];
      const kwLocation = parts.slice(1).join(' ');

      // Ensure keyword exists
      await pool.query(
        `INSERT INTO rank_keywords (project_id, keyword, location)
         VALUES ($1, $2, $3)
         ON CONFLICT (project_id, keyword, location) DO NOTHING`,
        [projectId, kwBase, kwLocation]
      );

      // Insert tracking data (position, title, rating, etc. from report)
      const position = report.position || null;
      const title = report.location?.name || null;
      const rating = report.location?.rating || null;
      const reviews = report.location?.review_count || null;

      await pool.query(
        `INSERT INTO rank_tracking (project_id, keyword, location, maps_position, maps_title, maps_rating, maps_reviews, checked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [projectId, kwBase, kwLocation, position, title, rating, reviews, new Date(baseTime + i).toISOString()]
      );
      synced++;
    }

    res.json({ ok: true, synced, total: reports.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Clean all Maps data (keywords with location + tracking)
app.delete('/api/projects/:id/maps/clean', async (req, res) => {
  try {
    const trackDel = await pool.query(
      `DELETE FROM rank_tracking
       WHERE project_id=$1 AND location IS NOT NULL AND location != ''`,
      [req.params.id]
    );
    const kwDel = await pool.query(
      `DELETE FROM rank_keywords
       WHERE project_id=$1 AND location IS NOT NULL AND location != ''`,
      [req.params.id]
    );
    console.log(`[maps-clean] Cleaned ${kwDel.rowCount} keywords + ${trackDel.rowCount} tracking records`);
    res.json({ ok: true, keywords_deleted: kwDel.rowCount, tracking_deleted: trackDel.rowCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== 9. SERP RANKINGS ====================

// DataForSEO API helper
async function dataforseoRequest(endpoint, method, body) {
  if (!DATAFORSEO_LOGIN || !DATAFORSEO_PASSWORD) {
    throw new Error('DataForSEO credentials not configured');
  }
  const auth = Buffer.from(`${DATAFORSEO_LOGIN}:${DATAFORSEO_PASSWORD}`).toString('base64');
  const opts = {
    method,
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`https://api.dataforseo.com/v3${endpoint}`, opts);
  return r.json();
}

// Get SERP keywords for a project
app.get('/api/projects/:id/serp/keywords', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM rank_keywords
       WHERE project_id=$1 AND (location IS NULL OR location = '')
       ORDER BY added_at DESC`,
      [req.params.id]
    );
    res.json({ keywords: result.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Add SERP keywords
app.post('/api/projects/:id/serp/keywords', async (req, res) => {
  const { keywords } = req.body;
  if (!Array.isArray(keywords)) return res.status(400).json({ error: 'keywords must be array' });
  try {
    let added = 0;
    for (const kw of keywords) {
      if (!kw || typeof kw !== 'string') continue;
      await pool.query(
        `INSERT INTO rank_keywords (project_id, keyword, location, location_code)
         VALUES ($1, $2, '', 2036)
         ON CONFLICT (project_id, keyword, location) DO NOTHING`,
        [req.params.id, kw.trim()]
      );
      added++;
    }
    res.json({ ok: true, added });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Discover keywords via DataForSEO (what domain ranks for)
app.post('/api/projects/:id/serp/discover', async (req, res) => {
  if (!DATAFORSEO_LOGIN) return res.status(503).json({ error: 'DataForSEO not configured' });
  const { id: projectId } = req.params;
  try {
    const projResult = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    if (projResult.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = projResult.rows[0];
    const domain = project.domain.replace(/^https?:\/\//, '').replace(/\/$/, '').replace(/^www\./, '');

    // TODO: Call DataForSEO ranked_keywords endpoint
    // Parse results and bulk insert into rank_keywords
    res.json({ ok: true, message: 'Discovery queued' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Check SERP positions for keywords
app.post('/api/projects/:id/serp/check', async (req, res) => {
  // TODO: Implement SERP checking with DataForSEO or SERPapi
  // For each keyword, fetch top 10, extract our domain position, competitors
  // Store in rank_tracking table
  res.json({ ok: true, message: 'SERP check queued' });
});

// Import discovered keywords with position + volume
app.post('/api/projects/:id/serp/import', async (req, res) => {
  const { keywords } = req.body; // [{keyword, volume, position, url, competition}]
  if (!Array.isArray(keywords)) return res.status(400).json({ error: 'keywords must be array' });
  try {
    let added = 0;
    const baseTime = Date.now();
    for (let i = 0; i < keywords.length; i++) {
      const k = keywords[i];
      if (!k.keyword) continue;
      const kw = k.keyword.trim();

      // Upsert into rank_keywords
      await pool.query(
        `INSERT INTO rank_keywords (project_id, keyword, search_volume, competition)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (project_id, keyword, location) DO UPDATE
         SET search_volume=COALESCE(EXCLUDED.search_volume, rank_keywords.search_volume),
             competition=COALESCE(EXCLUDED.competition, rank_keywords.competition)`,
        [req.params.id, kw, k.volume || null, k.competition || null]
      );

      // Insert tracking record if position provided
      if (k.position) {
        const ts = new Date(baseTime + i).toISOString();
        await pool.query(
          `INSERT INTO rank_tracking (project_id, keyword, serp_position, serp_url, serp_title, checked_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (project_id, keyword, location, checked_at) DO NOTHING`,
          [req.params.id, kw, k.position, k.url || null, k.title || null, ts]
        );
      }
      added++;
    }
    res.json({ ok: true, added });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get GSC keywords for a project
app.get('/api/projects/:id/gsc/keywords', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM gsc_keywords WHERE project_id=$1 ORDER BY impressions DESC',
      [req.params.id]
    );
    res.json({ keywords: result.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Sync GSC keywords (from Google Search Console token)
app.post('/api/projects/:id/gsc/sync', async (req, res) => {
  // TODO: Implement GSC OAuth token refresh + API call to fetch top keywords
  // Parse CSV or JSON response, upsert into gsc_keywords
  res.json({ ok: true, message: 'GSC sync queued' });
});

// ==================== 10. REPORTS ====================

// Get monthly reports for a project
app.get('/api/projects/:id/reports', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM monthly_reports WHERE project_id=$1 ORDER BY month DESC',
      [req.params.id]
    );
    res.json({ reports: result.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Generate monthly report
app.post('/api/projects/:id/reports/generate', async (req, res) => {
  const { month } = req.body; // '2026-04'
  if (!month) return res.status(400).json({ error: 'month required (YYYY-MM)' });
  try {
    // TODO: Aggregate metrics from rank_tracking, gsc_keywords, audit_findings
    // Generate report data and store in monthly_reports
    res.json({ ok: true, message: 'Report generation queued' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== 11. GSC OAUTH ====================

// Get OAuth URL for GSC
app.get('/api/gsc/auth-url', (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(503).json({ error: 'Google OAuth not configured' });
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: GSC_SCOPES,
    access_type: 'offline'
  });
  res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` });
});

// GSC OAuth callback
app.get('/api/gsc/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.status(400).send('No auth code');
  try {
    // TODO: Exchange code for token, fetch user's GSC properties
    // Store token in project_integrations, redirect to dashboard
    res.redirect('/dashboard?gsc=connected');
  } catch (e) {
    res.status(500).send(`Error: ${e.message}`);
  }
});

// ==================== 12. SERVE ====================

// Health check
app.get('/api/health', (req, res) => res.json({ ok: true }));

// Static files
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, etag: false }));

// Serve index.html for all other routes (SPA fallback)
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.type('html').send(INDEX_HTML);
});

// ==================== 13. STARTUP ====================

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
