const express = require('express');
const mysql = require('mysql2/promise');

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

// The reporting dashboard (a future phase) will fetch this cross-origin,
// so this API allows any origin rather than assuming same-origin like a
// typical server-rendered app would.
app.use('/api', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Resource: /api/events, mapping directly onto the `events` table the
// collector's /collect endpoint writes into (session_id, type, url, ip,
// client_timestamp, server_timestamp, payload). A single flexible table
// with a JSON payload column, rather than separate static/performance/
// activity tables, was the Storage choice made in the collector phase -
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

// GET /api/events - every entry, optionally filtered by ?type= and/or
// ?session=, paginated with ?limit=&offset= (default 100 / 0).
app.get('/api/events', async (req, res) => {
  const clauses = [];
  const params = [];

  if (typeof req.query.type === 'string') {
    clauses.push('type = ?');
    params.push(req.query.type);
  }
  if (typeof req.query.session === 'string') {
    clauses.push('session_id = ?');
    params.push(req.query.session);
  }

  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 1000);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  try {
    const [rows] = await dbPool.query(
      `SELECT id, session_id, type, url, ip, client_timestamp, server_timestamp, payload
       FROM events ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    res.json(rows);
  } catch (err) {
    console.error('[GET /api/events] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// GET /api/events/:id - a single entry by id.
app.get('/api/events/:id', async (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;

  try {
    const [rows] = await dbPool.query(
      `SELECT id, session_id, type, url, ip, client_timestamp, server_timestamp, payload
       FROM events WHERE id = ?`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[GET /api/events/:id] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// POST /api/events - create a new entry. Must NOT include an id - the
// database assigns one.
app.post('/api/events', async (req, res) => {
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
app.put('/api/events/:id', async (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;

  const body = req.body || {};
  const payloadCheck = checkPayload(body.payload);
  if (!payloadCheck.ok) {
    return res.status(payloadCheck.status).json({ error: payloadCheck.error });
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

  try {
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
app.delete('/api/events/:id', async (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;

  try {
    const [result] = await dbPool.execute('DELETE FROM events WHERE id = ?', [id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'not found' });
    res.sendStatus(204);
  } catch (err) {
    console.error('[DELETE /api/events/:id] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

const PORT = process.env.PORT || 3011;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Reporting API listening on 127.0.0.1:${PORT}`);
});
