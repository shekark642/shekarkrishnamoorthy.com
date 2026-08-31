const express = require('express');
const crypto = require('crypto');
const os = require('os');

const app = express();

// Apache proxies to us over loopback and adds X-Forwarded-For; trust that so
// req.ip reflects the real client, not 127.0.0.1.
app.set('trust proxy', 'loopback');
app.disable('x-powered-by');

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// In-memory only: this is a long-running process (unlike the one-shot Python/C
// CGI scripts), so a plain Map keyed by session id is enough - no file store
// needed. Trade-off: it resets if the process restarts.
const sessions = new Map();

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function currentTime() {
  return new Date().toString().replace(/ \(.*\)$/, '');
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  });
  return out;
}

app.get('/hello-html-nodejs', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(`<!DOCTYPE html>
<html>
<head><title>Hello CGI World - Shekar Krishnamoorthy</title></head>
<body>
<h1 align=center>Hello HTML World - Shekar Krishnamoorthy</h1><hr/>
<p>Hello World, from Shekar Krishnamoorthy</p>
<p>This page was generated with the NodeJS (Express) programming language</p>
<p>This program was generated at: ${escapeHtml(currentTime())}</p>
<p>Your current IP Address is: ${escapeHtml(req.ip)}</p>
</body>
</html>`);
});

app.get('/hello-json-nodejs', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.json({
    title: 'Hello, NodeJS! - Shekar Krishnamoorthy',
    heading: 'Hello, NodeJS! - Shekar Krishnamoorthy',
    message: 'This page was generated with the NodeJS (Express) programming language',
    time: currentTime(),
    IP: req.ip,
  });
});

app.get('/environment-nodejs', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  const keys = Object.keys(req.headers).sort();
  let rows = '';
  for (const k of keys) {
    rows += `<b>${escapeHtml(k)}:</b> ${escapeHtml(req.headers[k])}<br />\n`;
  }
  rows += `<b>method:</b> ${escapeHtml(req.method)}<br />\n`;
  rows += `<b>url:</b> ${escapeHtml(req.originalUrl)}<br />\n`;
  rows += `<b>remoteAddress:</b> ${escapeHtml(req.ip)}<br />\n`;

  res.type('html').send(`<!DOCTYPE html>
<html><head><title>Environment Variables - NodeJS - Shekar Krishnamoorthy</title></head>
<body><h1 align="center">Environment Variables - NodeJS - Shekar Krishnamoorthy</h1><hr>
<p><em>Express is a long-running server, not one-shot CGI, so there's no per-request
OS environment block the way Perl/Python/C get one. The closest real equivalent is
the incoming HTTP request itself - headers and request line, shown below.</em></p>
${rows}
</body></html>`);
});

app.all('/echo-nodejs', (req, res) => {
  res.set('Cache-Control', 'no-cache');

  let received = {};
  let source = '';
  if ((req.method === 'POST' || req.method === 'PUT') && req.body && Object.keys(req.body).length) {
    received = req.body;
    source = 'request body';
  } else if (req.query && Object.keys(req.query).length) {
    received = req.query;
    source = 'query string';
  }

  const keys = Object.keys(received);
  let rows = keys.length
    ? keys.map((k) => `<li>${escapeHtml(k)} = ${escapeHtml(received[k])}</li>`).join('\n')
    : '<li>(nothing received)</li>';

  res.type('html').send(`<!DOCTYPE html>
<html><head><title>Echo - NodeJS - Shekar Krishnamoorthy</title></head>
<body><h1 align="center">Echo Request - NodeJS</h1><hr>
<p><b>HTTP Method:</b> ${escapeHtml(req.method)}</p>
<p><b>Content-Type received:</b> ${escapeHtml(req.headers['content-type'] || '(none)')}</p>
<p><b>Data source:</b> ${escapeHtml(source || '(none)')}</p>
<p><b>Received data:</b></p><ul>
${rows}
</ul>
<p><b>Server hostname:</b> ${escapeHtml(os.hostname())}</p>
<p><b>Date/time:</b> ${escapeHtml(currentTime())}</p>
<p><b>User-Agent:</b> ${escapeHtml(req.headers['user-agent'] || '')}</p>
<p><b>Your IP Address:</b> ${escapeHtml(req.ip)}</p>
</body></html>`);
});

function handleState(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  let sessionId = cookies.hw2_session;
  let isNew = false;
  if (!sessionId || !/^[0-9a-f]{32}$/.test(sessionId)) {
    sessionId = crypto.randomBytes(16).toString('hex');
    isNew = true;
  }

  if (req.method === 'POST' && req.body) {
    if (req.body.action === 'clear') {
      sessions.delete(sessionId);
    } else if (typeof req.body.value === 'string') {
      sessions.set(sessionId, req.body.value.slice(0, 500));
    }
  }

  const savedValue = sessions.get(sessionId) || '';

  res.set('Cache-Control', 'no-cache');
  if (isNew) {
    res.cookie('hw2_session', sessionId, { httpOnly: true, sameSite: 'Lax', path: '/' });
  }

  res.type('html').send(`<!DOCTYPE html>
<html><head><title>State - NodeJS - Shekar Krishnamoorthy</title></head>
<body><h1 align="center">Server-Side State - NodeJS</h1><hr>
<p><b>Currently saved value:</b> ${savedValue ? escapeHtml(savedValue) : '(nothing saved yet)'}</p>
<form method="POST">
<input type="text" name="value" placeholder="Enter a value" maxlength="500">
<button type="submit">Save</button>
</form>
<form method="POST" style="margin-top:10px">
<input type="hidden" name="action" value="clear">
<button type="submit">Clear</button>
</form>
<p style="margin-top:20px;color:#666">Session ID: ${escapeHtml(sessionId)}</p>
<p>Reload this page after saving a value &mdash; it persists across separate requests
via a server-side in-memory Map keyed by your session cookie, not localStorage.
Unlike the file-backed Python/C sessions, this resets if the Node process restarts.</p>
</body></html>`);
}

app.get('/state-nodejs', handleState);
app.post('/state-nodejs', handleState);

// Body-parser errors (malformed JSON, etc.) land here instead of Express's
// default error page.
app.use((err, req, res, next) => {
  res.status(400).type('html').send(`<p>Bad request: ${escapeHtml(err.message)}</p>`);
});

const PORT = process.env.PORT || 3010;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`HW2 Node/Express demo listening on 127.0.0.1:${PORT}`);
});
