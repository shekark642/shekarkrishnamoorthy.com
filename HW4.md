
## HW4 — Analytics Viz Platform

**Site URL:** https://reporting.shekarkrishnamoorthy.com/

### Authentication

Auth is hand-rolled in Node/Express rather than a third-party library
(Passport, `express-session`, etc.) — for a single-service project with one
simple session shape, a library would have added configuration surface
without saving meaningful code. It also let API-route gating and page-route
gating share the exact same session lookup, differing only in what happens
on failure (a JSON 401/403 vs. a redirect to `/login.html`).

**How it works:**
- `users` table in the same MySQL database the collector already writes to
  (`username`, `email`, `password_hash`, `is_admin`, `created_at`).
- Passwords hashed with `bcryptjs` (a pure-JS bcrypt implementation — chosen
  over native `bcrypt` specifically to avoid a native-module build step in
  the deploy pipeline, which only runs a plain `npm install`, no compiler
  toolchain guaranteed).
- On login, the username-or-email field is checked against *both* columns
  in one query (`WHERE username = ? OR email = ?`) so the same field
  genuinely accepts either, matching how most real sites' login forms work.
- A random session token (`crypto.randomBytes(32)`) is generated and stored
  server-side in an in-memory `Map` (token → `{userId, username, isAdmin}`),
  set as an `httpOnly`, `secure`, `SameSite=Lax` cookie. In-memory sessions
  are the same durability tradeoff already used elsewhere in this project
  (HW2's `state-nodejs`, the fingerprint demo) — a process restart logs
  everyone out, which is an acceptable cost here and happens automatically
  on every deploy anyway.
- Every `/api/*` route requires a valid session, and every protected page
  route checks the session before serving the file — not just before
  rendering a link to it. This distinction mattered in practice: it would
  have been easy to gate only the *pages* and leave the underlying API
  reachable directly, which would let anyone bypass the login wall entirely
  by hitting `/api/events` with `curl` instead of opening the dashboard in a
  browser. Both layers are gated for that reason.
- A real architectural change was needed to make page-level gating possible
  at all: originally, Apache served `reporting.shekarkrishnamoorthy.com`'s
  static HTML directly and only proxied `/api/` to Node. Static files can't
  check a session, so the proxy was expanded to send the *entire* vhost to
  Node, which now owns serving every page and can redirect to `/login.html`
  before a byte of protected content is ever sent.
- Admin-only routes (`/users.html`, `/api/users/*`) add one more check
  (`isAdmin`) on top of the same session — confirmed live that a basic
  account gets a 403 page hitting `/users.html` directly, and that the
  "User Management" nav link is only rendered on the dashboard for admins
  (checked via `GET /auth/me`, not just assumed client-side).

### Dashboard

Three metrics, three different presentations (the assignment's minimum:
2 charts + 1 grid):

1. **Events by type → bar chart.** Categorical comparison across a small,
   fixed set of labels (`load`, `activity`, `enter`, `exit`, ...) — a bar
   chart is the right tool for comparing discrete categories side by side;
   a line chart would have implied an ordering between categories that
   doesn't exist.
2. **Page load time across the last 20 loads → line chart.** This is a
   value that changes across a sequence (successive page loads over time),
   which is exactly what a line chart is for — a bar chart here would have
   obscured the trend/spikes that the line makes immediately visible.
3. **Recent activity → grid.** Individual record inspection (which
   session, which URL, what time) has no meaningful chart representation at
   all; a table is the correct - not just simplest - choice here.

All three are computed via the reporting API's heavy-SQL summary endpoint
(`GET /api/reports/summary`, `COUNT`/`AVG`/`GROUP BY` against indexed
generated columns) and the general CRUD endpoint (`GET /api/events`) for
the raw rows the grid and line chart need. Charts are rendered with
Chart.js (canvas) — a real improvement over the HW3 dashboard skeleton,
which only drew bars with plain CSS `<div>` widths and had no line-chart
capability at all.

The dashboard also checks `GET /auth/me` on load and only shows the "User
Management" link when the session is an admin, satisfying the requirement
to link to Part 2 conditionally rather than unconditionally.

### Report

**File:** `/performance.html`, linked from the dashboard's "Generate
Detailed Report" button.

**Guiding question:** *Is the site loading fast enough, and are Core Web
Vitals in a healthy range?* Chosen because performance is the metric with
the clearest, most defensible "healthy vs. not" answer — the collector
already computes Web Vitals scores client-side against published
thresholds (good/needs-improvement/poor), so the report can reuse those
exact same thresholds server-side rather than inventing a different
standard for what "fast enough" means.

- **Score cards** for average load time, LCP, CLS, and INP, each labeled
  with the same good/needs-improvement/poor thresholds `collector.js`
  itself uses — so a "Good" badge on the report means the same thing it
  means in the raw beacon data, not a report-specific reinterpretation.
- **A load-time histogram** (bucketed bar chart: 0-200ms, 200-500ms, etc.)
  — deliberately a *different* view than the dashboard's sequential trend
  line. The dashboard shows *when* load times changed; the report shows the
  *shape* of the whole distribution (how many visits fall in each speed
  bucket), which the trend line alone can't answer.
- **A grid** of individual load events with a per-row score, so an outlier
  (e.g. one 1501ms load flagged "Needs Improvement" against a majority of
  sub-700ms loads) is traceable back to a specific session and timestamp,
  not just visible as an aggregate number.
- **A written discussion** on the page itself computes the actual answer
  from live numbers (e.g. *"the average page load time is 455.43ms, which
  scores as Good... Answer: yes, the site is loading fast enough on
  average"*) rather than describing what the charts show in the abstract.

### Source files written for this assignment

- `reporting/nodejs/server.js` — sessions, auth routes (`/auth/login`,
  `/auth/logout`, `/auth/me`), `requireAuth*`/`requireAdmin*` middleware,
  `/api/users` CRUD, page-serving routes for every page below, and the
  generalized `/api/reports/summary` endpoint the dashboard/report use.
- `reporting/nodejs/pages/login.html`
- `reporting/nodejs/pages/logout.html`
- `reporting/nodejs/pages/
