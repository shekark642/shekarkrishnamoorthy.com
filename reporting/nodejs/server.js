const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use(express.json());

// Same analytics DB the collector's /collect endpoint writes to. Credentials
// come from the environment (EnvironmentFile= in the systemd unit) - never
// hardcoded here, since this file is public on GitHub.
const dbPool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'analytics_app',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'analytics',
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0
});

// --- Sections ---
//
// The whole authorization model hinges on "section" being something the
// SERVER decides, never something a client declares - otherwise a analyst
// restricted to one section could just lie about which section a request
// is "for" and read anything. So section is derived two ways, both
// server-controlled: (1) which route was hit (/api/performance/* vs
// /api/behavioral/*), for aggregate/list endpoints; (2) an event row's own
// `type` column, for by-id access to a specific event. Nothing about
// section ever comes from a query param or request body.
const ALL_SECTIONS = ['performance', 'behavioral'];

function sectionForEventType(type) {
  // 'load' events are the ones carrying page-load timing and Web Vitals
  // (total_load_time_ms, lcp/cls/inp) - that's the entirety of what
  // "performance" means in this data model. Everything else (enter, exit,
  // activity, submit_click, and any future custom type) describes what a
  // visitor did, which is "behavioral."
  return type === 'load' ? 'performance' : 'behavioral';
}

// --- Sessions ---
//
// Backed by the `sessions` table in the same analytics DB, not an in-memory
// Map: every `npm run deploy` restarts this process, and an in-memory store
// silently logged out anyone currently using the dashboard on every single
// deploy. A DB-backed token lookup is one indexed primary-key read - on a
// local (127.0.0.1) connection pool this costs well under a millisecond,
// not a meaningful bottleneck for a low-traffic reporting dashboard - and
// survives restarts like everything else this table already backs.
const SESSION_COOKIE = 'reporting_session';
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

async function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS);
  // sessions.is_admin predates the role system and is left at its default
  // (unused) - role is always looked up fresh from `users` in getSession,
  // via the JOIN below, so a role change takes effect on a user's very
  // next request rather than only at their next login.
  await dbPool.execute(
    'INSERT INTO sessions (token, user_id, username, expires_at) VALUES (?, ?, ?, ?)',
    [token, user.id, user.username, expiresAt]
  );
  return token;
}

async function getSession(token) {
  if (!token) return null;
  const [rows] = await dbPool.query(
    `SELECT s.user_id AS userId, s.username, u.role AS role
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > NOW()`,
    [token]
  );
  if (!rows.length) return null;
  return { userId: rows[0].userId, username: rows[0].username, role: rows[0].role };
}

async function deleteSession(token) {
  if (!token) return;
  await dbPool.execute('DELETE FROM sessions WHERE token = ?', [token]);
}

// Expired rows are already excluded from getSession's WHERE clause, so this
// sweep is just table hygiene (keeps it from growing forever), not a
// correctness requirement - safe to run infrequently.
setInterval(() => {
  dbPool.execute('DELETE FROM sessions WHERE expires_at < NOW()').catch((err) => {
    console.error('[session cleanup] error:', err.message);
  });
}, 60 * 60 * 1000);

// --- IP retention ---
//
// events.ip has no legitimate long-term use beyond abuse investigation
// shortly after the fact - every report/aggregate this dashboard computes
// (totals, byGroup, sessions) reads type/url/timestamps/payload, never ip.
// Keeping raw IPs indefinitely is pure liability with no analytical
// upside, so anonymize (not delete - the event itself is still valid
// analytics data) anything past a 90-day window, a common baseline
// retention period for raw IPs. Runs once at startup and once a day after.
const IP_RETENTION_DAYS = 90;
function anonymizeOldIps() {
  dbPool.execute(
    'UPDATE events SET ip = NULL WHERE ip IS NOT NULL AND server_timestamp < NOW() - INTERVAL ? DAY',
    [IP_RETENTION_DAYS]
  ).then(([result]) => {
    if (result.affectedRows) console.log(`[ip retention] anonymized ${result.affectedRows} row(s) older than ${IP_RETENTION_DAYS} days`);
  }).catch((err) => {
    console.error('[ip retention] error:', err.message);
  });
}
anonymizeOldIps();
setInterval(anonymizeOldIps, 24 * 60 * 60 * 1000);

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    try { out[key] = decodeURIComponent(val); } catch { out[key] = val; }
  });
  return out;
}

// Attaches req.session (or null) on every request, before anything else runs.
// A DB error here fails closed (session stays null, same as no cookie at
// all) rather than crashing the request - an auth-store hiccup should mean
// "logged out," never a 500 for every page on the site.
app.use(async (req, res, next) => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  try {
    req.session = await getSession(token);
  } catch (err) {
    console.error('[session lookup] error:', err.message);
    req.session = null;
  }
  next();
});

// --- Authorization ---
//
// Three roles: super_admin (everything, including user management),
// analyst (everything except user management, optionally restricted to a
// subset of sections), viewer (saved reports only - no direct section
// access at all, ever).
//
// An analyst with zero rows in user_scopes is unrestricted ("An analyst
// can do anything and look at anything" - the default). Adding rows
// narrows them to exactly those sections ("may be defined... to look at a
// defined set of sections").
async function getAllowedSections(session) {
  if (session.role === 'super_admin') return ALL_SECTIONS;
  if (session.role === 'analyst') {
    const [rows] = await dbPool.query('SELECT section FROM user_scopes WHERE user_id = ?', [session.userId]);
    return rows.length ? rows.map((r) => r.section) : ALL_SECTIONS;
  }
  return []; // viewer: no section access, only saved reports
}

// Two flavors of each guard: API routes get a JSON 401/403 (so fetch() calls
// can handle it programmatically), page routes get redirected to the login
// screen (so a browser navigating there directly lands somewhere sensible).
function requireAuthApi(req, res, next) {
  if (!req.session) return res.status(401).json({ error: 'not logged in' });
  next();
}
function requireRoleApi(...roles) {
  return (req, res, next) => {
    if (!req.session) return res.status(401).json({ error: 'not logged in' });
    if (!roles.includes(req.session.role)) return res.status(403).json({ error: 'insufficient role' });
    next();
  };
}
function requireSectionApi(section) {
  return async (req, res, next) => {
    if (!req.session) return res.status(401).json({ error: 'not logged in' });
    try {
      const allowed = await getAllowedSections(req.session);
      if (!allowed.includes(section)) return res.status(403).json({ error: `no access to section: ${section}` });
      next();
    } catch (err) {
      console.error('[requireSectionApi] error:', err.message);
      res.status(500).json({ error: 'server error' });
    }
  };
}
function requireAuthPage(req, res, next) {
  if (!req.session) return res.redirect('/login.html');
  next();
}
function requireRolePage(...roles) {
  return (req, res, next) => {
    if (!req.session) return res.redirect('/login.html');
    if (!roles.includes(req.session.role)) return res.status(403).type('html').send('<h1>403 Forbidden</h1><p>Your role does not have access to this page.</p>');
    next();
  };
}

// --- Auth routes ---

// A place to store anything a request/client did that reads as suspicious
// or malicious - repeated failed logins, injection-shaped inputs - not the
// routine stuff. Shared with hw2/nodejs's /collect, same table in the same
// analytics DB (each app writes through its own dbPool).
async function flagClient(req, reason, details, sessionId) {
  try {
    await dbPool.execute(
      'INSERT INTO flagged_clients (ip, user_agent, reason, endpoint, method, session_id, details) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        req.ip || null,
        (req.headers['user-agent'] || '').slice(0, 512) || null,
        reason,
        (req.originalUrl || req.path || '').slice(0, 255),
        req.method,
        typeof sessionId === 'string' ? sessionId.slice(0, 64) : null,
        JSON.stringify(details || {})
      ]
    );
  } catch (err) {
    console.error('[flagClient] error:', err.message);
  }
}

app.post('/auth/login', async (req, res) => {
  const body = req.body || {};
  const username = body.username;
  const password = body.password;
  if (typeof username !== 'string' || !username || typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  try {
    const [rows] = await dbPool.query(
      'SELECT id, username, password_hash, role FROM users WHERE username = ? LIMIT 1',
      [username]
    );
    if (!rows.length) {
      flagClient(req, 'failed_login', { usernameAttempted: username.slice(0, 64), cause: 'no such user' });
      return res.status(401).json({ error: 'invalid username or password' });
    }

    const user = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      flagClient(req, 'failed_login', { usernameAttempted: username.slice(0, 64), cause: 'wrong password' });
      return res.status(401).json({ error: 'invalid username or password' });
    }

    const token = await createSession(user);

    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: SESSION_MAX_AGE_MS,
      path: '/'
    });
    res.json({ success: true, username: user.username, role: user.role });
  } catch (err) {
    console.error('[POST /auth/login] error:', err.message);
    res.status(500).json({ error: 'server error' });
  }
});

app.post('/auth/logout', async (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  try {
    await deleteSession(token);
  } catch (err) {
    console.error('[POST /auth/logout] error:', err.message);
  }
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ success: true });
});

app.get('/auth/me', requireAuthApi, async (req, res) => {
  try {
    const sections = await getAllowedSections(req.session);
    res.json({ userId: req.session.userId, username: req.session.username, role: req.session.role, sections });
  } catch (err) {
    console.error('[GET /auth/me] error:', err.message);
    res.status(500).json({ error: 'server error' });
  }
});

// The reporting dashboard fetches these same-origin (it's served by this
// same app - see the page routes further down), so CORS isn't actually
// needed for normal use. It's kept permissive for non-browser tools
// (curl/Postman) that don't enforce CORS anyway; the real access control is
// requireAuthApi/requireRoleApi/requireSectionApi below, not this header -
// CORS only affects whether a *browser* running someone else's JS can read
// the response, not whether a request reaches the server at all.
app.use('/api', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Every /api/* route requires at least a logged-in session - role and
// section checks layer on top of this per-route below.
app.use('/api', requireAuthApi);

// Resource: /api/events, mapping directly onto the `events` table the
// collector's /collect endpoint writes into (session_id, type, url, ip,
// client_timestamp, server_timestamp, payload). A single flexible table
// with a JSON payload column, rather than separate static/performance/
// activity tables, was the storage choice made in the collector phase -
// this API reflects that same shape rather than inventing a different one.

function parseId(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'id must be a positive integer' });
    return null;
  }
  return id;
}

// Same 50KB cap /collect already enforces - this API can be hit directly
// (not just through collector.js), so it needs the same guard against an
// oversized payload landing straight in the JSON column unchecked.
const MAX_PAYLOAD_BYTES = 50 * 1024;

function checkPayload(payload) {
  if (payload === undefined) return { ok: true };
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, status: 400, error: 'payload must be a JSON object' };
  }
  const size = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (size > MAX_PAYLOAD_BYTES) {
    return { ok: false, status: 413, error: 'payload too large (max 50KB)' };
  }
  return { ok: true };
}

// Single-record CRUD by id is gated by the SECTION THE ROW ITSELF BELONGS
// TO (derived from its type), checked against the caller's allowed
// sections - not by a client-supplied section, which could just be a lie.
// requireRoleApi keeps viewers out entirely (they only ever read saved
// reports, never raw rows).

app.get('/api/events/:id', requireRoleApi('super_admin', 'analyst'), async (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;

  try {
    const [rows] = await dbPool.query(
      `SELECT id, session_id, type, url, ip, client_timestamp, server_timestamp, payload
       FROM events WHERE id = ?`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });

    const allowed = await getAllowedSections(req.session);
    if (!allowed.includes(sectionForEventType(rows[0].type))) {
      return res.status(403).json({ error: 'no access to this event\'s section' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('[GET /api/events/:id] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// POST /api/events - create a new entry. Must NOT include an id - the
// database assigns one.
app.post('/api/events', requireRoleApi('super_admin', 'analyst'), async (req, res) => {
  const body = req.body || {};
  if ('id' in body) {
    return res.status(400).json({ error: 'POST must not include an id - the database assigns one' });
  }
  if (typeof body.type !== 'string' || !body.type) {
    return res.status(400).json({ error: 'type is required' });
  }
  const payloadCheck = checkPayload(body.payload);
  if (!payloadCheck.ok) {
    return res.status(payloadCheck.status).json({ error: payloadCheck.error });
  }

  try {
    const allowed = await getAllowedSections(req.session);
    if (!allowed.includes(sectionForEventType(body.type))) {
      return res.status(403).json({ error: 'no access to this event\'s section' });
    }

    const [result] = await dbPool.execute(
      `INSERT INTO events (session_id, type, url, ip, client_timestamp, payload)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        typeof body.session_id === 'string' ? body.session_id.slice(0, 64) : null,
        body.type.slice(0, 32),
        typeof body.url === 'string' ? body.url : null,
        typeof body.ip === 'string' ? body.ip : null,
        body.client_timestamp ? new Date(body.client_timestamp) : null,
        JSON.stringify(body.payload !== undefined ? body.payload : {})
      ]
    );
    const [rows] = await dbPool.query(
      `SELECT id, session_id, type, url, ip, client_timestamp, server_timestamp, payload
       FROM events WHERE id = ?`,
      [result.insertId]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[POST /api/events] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// PUT /api/events/:id - update an existing entry. Must include an id.
app.put('/api/events/:id', requireRoleApi('super_admin', 'analyst'), async (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;

  const body = req.body || {};
  const payloadCheck = checkPayload(body.payload);
  if (!payloadCheck.ok) {
    return res.status(payloadCheck.status).json({ error: payloadCheck.error });
  }

  try {
    const [existingRows] = await dbPool.query('SELECT type FROM events WHERE id = ?', [id]);
    if (!existingRows.length) return res.status(404).json({ error: 'not found' });

    const allowed = await getAllowedSections(req.session);
    const targetType = typeof body.type === 'string' ? body.type : existingRows[0].type;
    if (!allowed.includes(sectionForEventType(existingRows[0].type)) || !allowed.includes(sectionForEventType(targetType))) {
      return res.status(403).json({ error: 'no access to this event\'s section' });
    }

    const fields = [];
    const params = [];
    if (typeof body.type === 'string') { fields.push('type = ?'); params.push(body.type.slice(0, 32)); }
    if (typeof body.url === 'string') { fields.push('url = ?'); params.push(body.url); }
    if (typeof body.ip === 'string') { fields.push('ip = ?'); params.push(body.ip); }
    if (typeof body.session_id === 'string') { fields.push('session_id = ?'); params.push(body.session_id.slice(0, 64)); }
    if (body.payload !== undefined) { fields.push('payload = ?'); params.push(JSON.stringify(body.payload)); }

    if (!fields.length) {
      return res.status(400).json({ error: 'no updatable fields provided' });
    }

    const [result] = await dbPool.execute(
      `UPDATE events SET ${fields.join(', ')} WHERE id = ?`,
      [...params, id]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'not found' });

    const [rows] = await dbPool.query(
      `SELECT id, session_id, type, url, ip, client_timestamp, server_timestamp, payload
       FROM events WHERE id = ?`,
      [id]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('[PUT /api/events/:id] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// DELETE /api/events/:id - remove an entry. Must include an id.
app.delete('/api/events/:id', requireRoleApi('super_admin', 'analyst'), async (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;

  try {
    const [existingRows] = await dbPool.query('SELECT type FROM events WHERE id = ?', [id]);
    if (!existingRows.length) return res.status(404).json({ error: 'not found' });

    const allowed = await getAllowedSections(req.session);
    if (!allowed.includes(sectionForEventType(existingRows[0].type))) {
      return res.status(403).json({ error: 'no access to this event\'s section' });
    }

    const [result] = await dbPool.execute('DELETE FROM events WHERE id = ?', [id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'not found' });
    res.sendStatus(204);
  } catch (err) {
    console.error('[DELETE /api/events/:id] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// --- Section-scoped reporting ---
//
// These replace the old generic /api/events (list), /api/reports/summary,
// and /api/reports/sessions endpoints. Each one is hardcoded to one
// section's WHERE clause server-side (type = 'load' for performance,
// type != 'load' for behavioral) and gated by requireSectionApi - there is
// no generic "give me everything" list endpoint left that a
// section-restricted analyst could fall back to as a bypass.
//
// ?urlPrefix= still scopes to one site/page; the arbitrary ?metricPath=/
// ?metricAgg= aggregation still works exactly as before, just applied
// within whichever section's WHERE clause is already active - so a
// behavioral-restricted analyst can aggregate any JSON path they want,
// but only across behavioral-type rows, never across 'load' rows.
const ALLOWED_AGG = ['avg', 'sum', 'min', 'max', 'count'];
const ALLOWED_GROUP_BY = ['type', 'session_id', 'url'];
const JSON_PATH_RE = /^\$(\.[A-Za-z0-9_]+|\[\d+\])*$/; // e.g. $.vitals.lcp.value

function buildUrlPrefixClause(req) {
  if (typeof req.query.urlPrefix === 'string' && req.query.urlPrefix) {
    return { clause: 'url LIKE ?', param: req.query.urlPrefix + '%' };
  }
  return null;
}

// Characters/keywords that show up in an actual injection attempt but never
// in a legitimate JSON path (which is just $.foo.bar[0] segments) - a typo'd
// path fails JSON_PATH_RE too, but this narrower check is what separates
// "made a mistake" from "tried something."
const INJECTION_SHAPED_RE = /['";]|--|\/\*|\bunion\b|\bselect\b|\bdrop\b|\bor\s+1=1\b/i;

async function runCustomMetric(whereSql, params, req, res) {
  const metricPath = req.query.metricPath;
  const metricAgg = (req.query.metricAgg || 'avg').toLowerCase();
  if (typeof metricPath !== 'string' || !metricPath) return { customMetric: null };

  if (!JSON_PATH_RE.test(metricPath)) {
    if (INJECTION_SHAPED_RE.test(metricPath)) {
      flagClient(req, 'injection_attempt', { field: 'metricPath', value: metricPath.slice(0, 500) });
    }
    res.status(400).json({ error: 'metricPath must look like a JSON path, e.g. $.vitals.lcp.value' });
    return { handled: true };
  }
  if (!ALLOWED_AGG.includes(metricAgg)) {
    res.status(400).json({ error: 'metricAgg must be one of: ' + ALLOWED_AGG.join(', ') });
    return { handled: true };
  }
  const aggSql = metricAgg === 'count'
    ? 'COUNT(payload->>?)'
    : `${metricAgg.toUpperCase()}(CAST(payload->>? AS DOUBLE))`;
  const [[row]] = await dbPool.query(`SELECT ${aggSql} AS value FROM events ${whereSql}`, [metricPath, ...params]);
  return { customMetric: { path: metricPath, agg: metricAgg, value: row.value } };
}

// GET /api/performance/summary - averages across page-load (Web Vitals)
// events only.
app.get('/api/performance/summary', requireSectionApi('performance'), async (req, res) => {
  const where = ["type = 'load'"];
  const params = [];
  const prefix = buildUrlPrefixClause(req);
  if (prefix) { where.push(prefix.clause); params.push(prefix.param); }
  const whereSql = 'WHERE ' + where.join(' AND ');

  try {
    const [[totals]] = await dbPool.query(
      `SELECT
         COUNT(*) AS totalEvents,
         COUNT(DISTINCT session_id) AS uniqueSessions,
         AVG(total_load_time_ms) AS avgLoadTimeMs,
         AVG(lcp_value) AS avgLcp,
         AVG(cls_value) AS avgCls,
         AVG(inp_value) AS avgInp
       FROM events ${whereSql}`,
      params
    );

    const metricResult = await runCustomMetric(whereSql, params, req, res);
    if (metricResult.handled) return;

    res.json({ totals, customMetric: metricResult.customMetric });
  } catch (err) {
    console.error('[GET /api/performance/summary] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// GET /api/performance/events - the load-event list (used for the load
// time trend/histogram/table views).
app.get('/api/performance/events', requireSectionApi('performance'), async (req, res) => {
  const where = ["type = 'load'"];
  const params = [];
  const prefix = buildUrlPrefixClause(req);
  if (prefix) { where.push(prefix.clause); params.push(prefix.param); }
  const whereSql = 'WHERE ' + where.join(' AND ');

  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 1000);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const includePayload = req.query.includePayload === 'true';
  const columns = 'id, session_id, type, url, ip, client_timestamp, server_timestamp, ' +
    'total_load_time_ms, lcp_value, cls_value, inp_value' + (includePayload ? ', payload' : '');

  try {
    const [rows] = await dbPool.query(
      `SELECT ${columns} FROM events ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    res.json(rows);
  } catch (err) {
    console.error('[GET /api/performance/events] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// GET /api/behavioral/summary - type breakdown + totals across everything
// that isn't a page-load event.
app.get('/api/behavioral/summary', requireSectionApi('behavioral'), async (req, res) => {
  const where = ["type != 'load'"];
  const params = [];
  const prefix = buildUrlPrefixClause(req);
  if (prefix) { where.push(prefix.clause); params.push(prefix.param); }
  const whereSql = 'WHERE ' + where.join(' AND ');

  const groupBy = ALLOWED_GROUP_BY.includes(req.query.groupBy) ? req.query.groupBy : 'type';

  try {
    const [[totals]] = await dbPool.query(
      `SELECT COUNT(*) AS totalEvents, COUNT(DISTINCT session_id) AS uniqueSessions FROM events ${whereSql}`,
      params
    );

    const [byGroup] = await dbPool.query(
      `SELECT ${groupBy} AS \`key\`, COUNT(*) AS count FROM events ${whereSql}
       GROUP BY ${groupBy} ORDER BY count DESC LIMIT 50`,
      params
    );

    const metricResult = await runCustomMetric(whereSql, params, req, res);
    if (metricResult.handled) return;

    res.json({ totals, groupBy, byGroup, customMetric: metricResult.customMetric });
  } catch (err) {
    console.error('[GET /api/behavioral/summary] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// GET /api/behavioral/events - the general activity/recent-events list.
app.get('/api/behavioral/events', requireSectionApi('behavioral'), async (req, res) => {
  const where = ["type != 'load'"];
  const params = [];
  if (typeof req.query.type === 'string') {
    where.push('type = ?');
    params.push(req.query.type);
  }
  if (typeof req.query.session === 'string') {
    where.push('session_id = ?');
    params.push(req.query.session);
  }
  const whereSql = 'WHERE ' + where.join(' AND ');

  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 1000);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const includePayload = req.query.includePayload === 'true';
  const columns = 'id, session_id, type, url, ip, client_timestamp, server_timestamp' + (includePayload ? ', payload' : '');

  try {
    const [rows] = await dbPool.query(
      `SELECT ${columns} FROM events ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    res.json(rows);
  } catch (err) {
    console.error('[GET /api/behavioral/events] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// GET /api/behavioral/sessions - cross-references every session's
// scattered behavioral events (enter/activity/exit/submit_click/...) into
// one row per session. Deliberately built only from behavioral-type rows
// (excludes 'load'), so a behavioral-only analyst can't infer performance
// signal (e.g. whether/when a load event happened) through this view.
app.get('/api/behavioral/sessions', requireSectionApi('behavioral'), async (req, res) => {
  const where = ["type != 'load'", 'session_id IS NOT NULL'];
  const params = [];
  const prefix = buildUrlPrefixClause(req);
  if (prefix) { where.push(prefix.clause); params.push(prefix.param); }
  const whereSql = 'WHERE ' + where.join(' AND ');
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);

  try {
    const [rows] = await dbPool.query(
      `SELECT
         session_id,
         MIN(COALESCE(client_timestamp, server_timestamp)) AS firstSeen,
         MAX(COALESCE(client_timestamp, server_timestamp)) AS lastSeen,
         TIMESTAMPDIFF(SECOND,
           MIN(COALESCE(client_timestamp, server_timestamp)),
           MAX(COALESCE(client_timestamp, server_timestamp))) AS durationSecs,
         COUNT(*) AS eventCount,
         COUNT(DISTINCT url) AS pagesVisited,
         MAX(url) AS lastUrl,
         MAX(CASE WHEN type = 'submit_click' THEN 1 ELSE 0 END) = 1 AS submitted
       FROM events
       ${whereSql}
       GROUP BY session_id
       ORDER BY lastSeen DESC
       LIMIT ?`,
      [...params, limit]
    );
    res.json(rows);
  } catch (err) {
    console.error('[GET /api/behavioral/sessions] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// GET /api/behavioral/visitor-types - bot vs. human, one classification per
// session (not per event). is_bot is a generated column on `events`,
// computed straight from each 'load' event's own JSON payload - true if
// navigator.webdriver was set (the default for Selenium/Puppeteer/
// Playwright) or the User-Agent string matches a known bot/crawler/tool
// pattern. A session can have more than one 'load' event (one per page
// visited); MAX() means one bot-flagged page load is enough to call the
// whole session a bot. This is a heuristic, not a guarantee - a bot that
// spoofs a normal browser UA and clears navigator.webdriver evades both
// signals, same limitation every client-side bot detector has.
app.get('/api/behavioral/visitor-types', requireSectionApi('behavioral'), async (req, res) => {
  try {
    const [[row]] = await dbPool.query(`
      SELECT
        SUM(sessionIsBot = 1) AS botSessions,
        SUM(sessionIsBot = 0) AS humanSessions
      FROM (
        SELECT session_id, MAX(is_bot) AS sessionIsBot
        FROM events
        WHERE type = 'load' AND session_id IS NOT NULL
        GROUP BY session_id
      ) t
    `);
    res.json({ bot: Number(row.botSessions) || 0, human: Number(row.humanSessions) || 0 });
  } catch (err) {
    console.error('[GET /api/behavioral/visitor-types] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// --- Saved reports ---
//
// "A viewer can only look at saved reports, which are just set views, even
// if they are made static." A report is a named, section-scoped query
// definition (kind + params) an analyst or super_admin defines once;
// anyone with read access to it can view its result without needing raw
// section access themselves. is_static freezes the result at save/refresh
// time into `snapshot`; a non-static report re-runs its query live on
// every view instead.
const ALLOWED_KINDS_BY_SECTION = {
  performance: ['summary', 'events'],
  behavioral: ['summary', 'events', 'sessions']
};

// Runs the same underlying query logic the live section endpoints use,
// directly against dbPool (not via HTTP), so a saved report's section is
// still enforced by which function gets called - never by trusting the
// report row's own `section` column to already be correct end-to-end.
async function runReportQuery(section, kind, params) {
  const where = section === 'performance' ? ["type = 'load'"] : ["type != 'load'"];
  const sqlParams = [];
  if (typeof params.urlPrefix === 'string' && params.urlPrefix) {
    where.push('url LIKE ?');
    sqlParams.push(params.urlPrefix + '%');
  }
  const whereSql = 'WHERE ' + where.join(' AND ');

  if (kind === 'summary') {
    if (section === 'performance') {
      const [[totals]] = await dbPool.query(
        `SELECT COUNT(*) AS totalEvents, COUNT(DISTINCT session_id) AS uniqueSessions,
                AVG(total_load_time_ms) AS avgLoadTimeMs, AVG(lcp_value) AS avgLcp,
                AVG(cls_value) AS avgCls, AVG(inp_value) AS avgInp
         FROM events ${whereSql}`,
        sqlParams
      );
      return { totals };
    }
    const groupBy = ALLOWED_GROUP_BY.includes(params.groupBy) ? params.groupBy : 'type';
    const [[totals]] = await dbPool.query(
      `SELECT COUNT(*) AS totalEvents, COUNT(DISTINCT session_id) AS uniqueSessions FROM events ${whereSql}`,
      sqlParams
    );
    const [byGroup] = await dbPool.query(
      `SELECT ${groupBy} AS \`key\`, COUNT(*) AS count FROM events ${whereSql} GROUP BY ${groupBy} ORDER BY count DESC LIMIT 50`,
      sqlParams
    );
    return { totals, groupBy, byGroup };
  }

  if (kind === 'events') {
    const limit = Math.min(Math.max(parseInt(params.limit, 10) || 100, 1), 1000);
    const columns = section === 'performance'
      ? 'id, session_id, type, url, client_timestamp, server_timestamp, total_load_time_ms, lcp_value, cls_value, inp_value'
      : 'id, session_id, type, url, client_timestamp, server_timestamp';
    const [rows] = await dbPool.query(
      `SELECT ${columns} FROM events ${whereSql} ORDER BY id DESC LIMIT ?`,
      [...sqlParams, limit]
    );
    return rows;
  }

  if (kind === 'sessions') {
    const limit = Math.min(Math.max(parseInt(params.limit, 10) || 50, 1), 500);
    const [rows] = await dbPool.query(
      `SELECT session_id,
              MIN(COALESCE(client_timestamp, server_timestamp)) AS firstSeen,
              MAX(COALESCE(client_timestamp, server_timestamp)) AS lastSeen,
              TIMESTAMPDIFF(SECOND, MIN(COALESCE(client_timestamp, server_timestamp)), MAX(COALESCE(client_timestamp, server_timestamp))) AS durationSecs,
              COUNT(*) AS eventCount, COUNT(DISTINCT url) AS pagesVisited,
              MAX(CASE WHEN type = 'submit_click' THEN 1 ELSE 0 END) = 1 AS submitted
       FROM events ${whereSql} AND session_id IS NOT NULL
       GROUP BY session_id ORDER BY lastSeen DESC LIMIT ?`,
      [...sqlParams, limit]
    );
    return rows;
  }

  throw new Error(`unknown report kind: ${kind}`);
}

function validateReportBody(body) {
  if (typeof body.name !== 'string' || !body.name.trim()) return 'name is required';
  if (!ALL_SECTIONS.includes(body.section)) return 'section must be one of: ' + ALL_SECTIONS.join(', ');
  const allowedKinds = ALLOWED_KINDS_BY_SECTION[body.section] || [];
  if (!allowedKinds.includes(body.kind)) return `kind must be one of: ${allowedKinds.join(', ')} for section ${body.section}`;
  if (body.params !== undefined && (typeof body.params !== 'object' || body.params === null || Array.isArray(body.params))) {
    return 'params must be a JSON object';
  }
  return null;
}

// GET /api/saved-reports - list. Viewers see every report (it's their only
// capability). Analysts/super_admins see reports in sections they can
// access (super_admin = all).
app.get('/api/saved-reports', async (req, res) => {
  try {
    let rows;
    if (req.session.role === 'viewer') {
      [rows] = await dbPool.query(
        'SELECT id, name, section, kind, is_static, created_by, created_at FROM saved_reports ORDER BY id DESC'
      );
    } else {
      const allowed = await getAllowedSections(req.session);
      if (!allowed.length) return res.json([]);
      [rows] = await dbPool.query(
        `SELECT id, name, section, kind, is_static, created_by, created_at FROM saved_reports
         WHERE section IN (${allowed.map(() => '?').join(',')}) ORDER BY id DESC`,
        allowed
      );
    }
    res.json(rows);
  } catch (err) {
    console.error('[GET /api/saved-reports] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// GET /api/saved-reports/:id - view one report's data: the frozen snapshot
// if static, otherwise the live query result.
app.get('/api/saved-reports/:id', async (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;

  try {
    const [rows] = await dbPool.query('SELECT * FROM saved_reports WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    const report = rows[0];

    if (req.session.role !== 'viewer') {
      const allowed = await getAllowedSections(req.session);
      if (!allowed.includes(report.section)) return res.status(403).json({ error: 'no access to this report\'s section' });
    }

    const data = report.is_static ? report.snapshot : await runReportQuery(report.section, report.kind, report.params || {});
    res.json({
      id: report.id,
      name: report.name,
      section: report.section,
      kind: report.kind,
      isStatic: !!report.is_static,
      data
    });
  } catch (err) {
    console.error('[GET /api/saved-reports/:id] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// POST /api/saved-reports - create. Only super_admin/analyst, and an
// analyst may only create a report in a section they themselves can access
// - otherwise they could hand a viewer access to data they can't see.
app.post('/api/saved-reports', requireRoleApi('super_admin', 'analyst'), async (req, res) => {
  const body = req.body || {};
  const validationError = validateReportBody(body);
  if (validationError) return res.status(400).json({ error: validationError });

  try {
    const allowed = await getAllowedSections(req.session);
    if (!allowed.includes(body.section)) return res.status(403).json({ error: 'no access to this section' });

    const params = body.params || {};
    const isStatic = !!body.isStatic;
    const snapshot = isStatic ? JSON.stringify(await runReportQuery(body.section, body.kind, params)) : null;

    const [result] = await dbPool.execute(
      'INSERT INTO saved_reports (name, section, kind, params, is_static, snapshot, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [body.name.trim().slice(0, 255), body.section, body.kind, JSON.stringify(params), isStatic ? 1 : 0, snapshot, req.session.userId]
    );
    const [rows] = await dbPool.query('SELECT id, name, section, kind, is_static, created_by, created_at FROM saved_reports WHERE id = ?', [result.insertId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[POST /api/saved-reports] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

async function canManageReport(session, report) {
  if (session.role === 'super_admin') return true;
  if (session.role !== 'analyst') return false;
  if (report.created_by !== session.userId) return false; // analysts manage their own reports only
  const allowed = await getAllowedSections(session);
  return allowed.includes(report.section);
}

// PUT /api/saved-reports/:id - update. Also how a static report gets
// re-frozen: pass the same (or new) params with isStatic:true to re-run
// and re-capture the snapshot on demand.
app.put('/api/saved-reports/:id', requireRoleApi('super_admin', 'analyst'), async (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;

  try {
    const [existing] = await dbPool.query('SELECT * FROM saved_reports WHERE id = ?', [id]);
    if (!existing.length) return res.status(404).json({ error: 'not found' });
    const report = existing[0];

    if (!(await canManageReport(req.session, report))) {
      return res.status(403).json({ error: 'you do not have permission to edit this report' });
    }

    const body = req.body || {};
    const section = body.section !== undefined ? body.section : report.section;
    const kind = body.kind !== undefined ? body.kind : report.kind;
    const params = body.params !== undefined ? body.params : report.params;
    const validationError = validateReportBody({ name: body.name !== undefined ? body.name : report.name, section, kind, params });
    if (validationError) return res.status(400).json({ error: validationError });

    if (section !== report.section) {
      const allowed = await getAllowedSections(req.session);
      if (!allowed.includes(section)) return res.status(403).json({ error: 'no access to that section' });
    }

    const isStatic = body.isStatic !== undefined ? !!body.isStatic : !!report.is_static;
    const snapshot = isStatic ? JSON.stringify(await runReportQuery(section, kind, params)) : null;

    await dbPool.execute(
      'UPDATE saved_reports SET name = ?, section = ?, kind = ?, params = ?, is_static = ?, snapshot = ? WHERE id = ?',
      [(body.name !== undefined ? body.name : report.name).trim().slice(0, 255), section, kind, JSON.stringify(params), isStatic ? 1 : 0, snapshot, id]
    );
    const [rows] = await dbPool.query('SELECT id, name, section, kind, is_static, created_by, created_at FROM saved_reports WHERE id = ?', [id]);
    res.json(rows[0]);
  } catch (err) {
    console.error('[PUT /api/saved-reports/:id] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

app.delete('/api/saved-reports/:id', requireRoleApi('super_admin', 'analyst'), async (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;

  try {
    const [existing] = await dbPool.query('SELECT * FROM saved_reports WHERE id = ?', [id]);
    if (!existing.length) return res.status(404).json({ error: 'not found' });

    if (!(await canManageReport(req.session, existing[0]))) {
      return res.status(403).json({ error: 'you do not have permission to delete this report' });
    }

    await dbPool.execute('DELETE FROM saved_reports WHERE id = ?', [id]);
    res.sendStatus(204);
  } catch (err) {
    console.error('[DELETE /api/saved-reports/:id] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// --- Flagged clients ---
//
// Read access, super_admin only - this is who-did-what-suspicious data
// (IPs, user agents, attempted usernames), not a business-analytics
// section, so it doesn't fit the performance/behavioral scope model at all.
app.get('/api/flagged-clients', requireRoleApi('super_admin'), async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 1000);
  try {
    const [rows] = await dbPool.query(
      'SELECT id, ip, user_agent, reason, endpoint, method, session_id, details, flagged_at FROM flagged_clients ORDER BY id DESC LIMIT ?',
      [limit]
    );
    res.json(rows);
  } catch (err) {
    console.error('[GET /api/flagged-clients] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// --- User management ---
//
// Full CRUD on the `users` table, super_admin only - "A super admin can do
// anything, including managing users." Includes each analyst's section
// scopes (empty array = unrestricted).

async function getScopesByUser(userIds) {
  if (!userIds.length) return {};
  const [rows] = await dbPool.query(
    `SELECT user_id, section FROM user_scopes WHERE user_id IN (${userIds.map(() => '?').join(',')})`,
    userIds
  );
  const out = {};
  rows.forEach((r) => { (out[r.user_id] = out[r.user_id] || []).push(r.section); });
  return out;
}

function validateScopes(scopes) {
  if (scopes === undefined) return [];
  if (!Array.isArray(scopes)) return null;
  if (!scopes.every((s) => ALL_SECTIONS.includes(s))) return null;
  return scopes;
}

async function setUserScopes(userId, scopes) {
  await dbPool.execute('DELETE FROM user_scopes WHERE user_id = ?', [userId]);
  if (scopes.length) {
    const values = scopes.map(() => '(?, ?)').join(',');
    const params = scopes.flatMap((s) => [userId, s]);
    await dbPool.execute(`INSERT INTO user_scopes (user_id, section) VALUES ${values}`, params);
  }
}

const USER_FIELDS = 'id, username, role, created_at';

app.get('/api/users', requireRoleApi('super_admin'), async (req, res) => {
  try {
    const [rows] = await dbPool.query(`SELECT ${USER_FIELDS} FROM users ORDER BY id`);
    const scopesByUser = await getScopesByUser(rows.map((u) => u.id));
    res.json(rows.map((u) => ({ ...u, scopes: scopesByUser[u.id] || [] })));
  } catch (err) {
    console.error('[GET /api/users] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

app.get('/api/users/:id', requireRoleApi('super_admin'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id must be a positive integer' });
  try {
    const [rows] = await dbPool.query(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    const scopesByUser = await getScopesByUser([id]);
    res.json({ ...rows[0], scopes: scopesByUser[id] || [] });
  } catch (err) {
    console.error('[GET /api/users/:id] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

app.post('/api/users', requireRoleApi('super_admin'), async (req, res) => {
  const body = req.body || {};
  if ('id' in body) return res.status(400).json({ error: 'POST must not include an id - the database assigns one' });
  if (typeof body.username !== 'string' || !body.username) return res.status(400).json({ error: 'username is required' });
  if (typeof body.password !== 'string' || body.password.length < 8) {
    return res.status(400).json({ error: 'password is required and must be at least 8 characters' });
  }
  if (!['super_admin', 'analyst', 'viewer'].includes(body.role)) {
    return res.status(400).json({ error: 'role must be one of: super_admin, analyst, viewer' });
  }
  const scopes = validateScopes(body.scopes);
  if (scopes === null) return res.status(400).json({ error: 'scopes must be an array of: ' + ALL_SECTIONS.join(', ') });

  try {
    const hash = await bcrypt.hash(body.password, 10);
    const [result] = await dbPool.execute(
      'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)',
      [body.username.slice(0, 64), hash, body.role]
    );
    if (body.role === 'analyst' && scopes.length) await setUserScopes(result.insertId, scopes);

    const [rows] = await dbPool.query(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`, [result.insertId]);
    res.status(201).json({ ...rows[0], scopes: body.role === 'analyst' ? scopes : [] });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'username already exists' });
    }
    console.error('[POST /api/users] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

app.put('/api/users/:id', requireRoleApi('super_admin'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id must be a positive integer' });

  const body = req.body || {};
  const fields = [];
  const params = [];

  if (typeof body.username === 'string' && body.username) { fields.push('username = ?'); params.push(body.username.slice(0, 64)); }
  if (body.role !== undefined) {
    if (!['super_admin', 'analyst', 'viewer'].includes(body.role)) {
      return res.status(400).json({ error: 'role must be one of: super_admin, analyst, viewer' });
    }
    fields.push('role = ?'); params.push(body.role);
  }
  if (typeof body.password === 'string' && body.password) {
    if (body.password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
    fields.push('password_hash = ?');
    params.push(await bcrypt.hash(body.password, 10));
  }

  const scopes = validateScopes(body.scopes);
  if (scopes === null) return res.status(400).json({ error: 'scopes must be an array of: ' + ALL_SECTIONS.join(', ') });

  if (!fields.length && body.scopes === undefined) return res.status(400).json({ error: 'no updatable fields provided' });

  try {
    if (fields.length) {
      const [result] = await dbPool.execute(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, [...params, id]);
      if (!result.affectedRows) return res.status(404).json({ error: 'not found' });
    } else {
      const [existing] = await dbPool.query('SELECT id FROM users WHERE id = ?', [id]);
      if (!existing.length) return res.status(404).json({ error: 'not found' });
    }
    if (body.scopes !== undefined) await setUserScopes(id, scopes);

    const [rows] = await dbPool.query(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`, [id]);
    const scopesByUser = await getScopesByUser([id]);
    res.json({ ...rows[0], scopes: scopesByUser[id] || [] });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'username already exists' });
    }
    console.error('[PUT /api/users/:id] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

app.delete('/api/users/:id', requireRoleApi('super_admin'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id must be a positive integer' });
  if (req.session.userId === id) {
    return res.status(400).json({ error: 'cannot delete your own currently logged-in account' });
  }
  try {
    const [result] = await dbPool.execute('DELETE FROM users WHERE id = ?', [id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'not found' });
    res.sendStatus(204);
  } catch (err) {
    console.error('[DELETE /api/users/:id] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// --- Page serving ---
//
// Apache proxies the entire vhost here now (not just /api/ and /auth/), so
// this app owns serving every page - which is what lets login actually be
// enforced server-side instead of just hiding a link client-side. The pages
// live in ./pages, outside anything Apache would otherwise serve as a
// static file directly (deploy-site.sh excludes /nodejs from the rsync into
// public_html), so res.sendFile is the only way they're reachable.
const PAGES_DIR = path.join(__dirname, 'pages');

app.get('/', (req, res) => {
  if (!req.session) return res.redirect('/login.html');
  res.redirect(req.session.role === 'viewer' ? '/reports.html' : '/index.html');
});

app.get('/login.html', (req, res) => {
  if (req.session) return res.redirect(req.session.role === 'viewer' ? '/reports.html' : '/index.html');
  res.sendFile(path.join(PAGES_DIR, 'login.html'));
});

app.get('/logout.html', (req, res) => {
  res.sendFile(path.join(PAGES_DIR, 'logout.html'));
});

app.get('/index.html', requireRolePage('super_admin', 'analyst'), (req, res) => {
  res.sendFile(path.join(PAGES_DIR, 'index.html'));
});

app.get('/users.html', requireRolePage('super_admin'), (req, res) => {
  res.sendFile(path.join(PAGES_DIR, 'users.html'));
});

app.get('/performance.html', requireRolePage('super_admin', 'analyst'), (req, res) => {
  res.sendFile(path.join(PAGES_DIR, 'performance.html'));
});

// Reachable by all three roles: it's the viewer's only page, but analysts
// and super_admins also use it to browse/create/manage saved reports.
app.get('/reports.html', requireAuthPage, (req, res) => {
  res.sendFile(path.join(PAGES_DIR, 'reports.html'));
});

const PORT = process.env.PORT || 3011;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Reporting API listening on 127.0.0.1:${PORT}`);
});
