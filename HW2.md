# Homework 2 — Multi-Language Web Demos

Five example types — `hello-html`, `hello-json`, `environment`, `echo`, and `state`
(server-side session) — implemented in three languages: **NodeJS (Express)**,
**Python**, and **C**. Perl versions of the same demos were provided by the course
as a reference and aren't part of this assignment's graded set.

Live index of every endpoint: [hw2/index.html](hw2/index.html).

## Architecture: two execution models, one Apache vhost

Python and C run as **one-shot CGI**, the same model as the reference Perl demos —
Apache's `mod_cgid` forks a fresh process per request, matched via an exact-path
`ScriptAlias` line per endpoint (e.g. `ScriptAlias /hello-html-python
/var/www/.../hw2/python/hello-html-python.py`).

NodeJS/Express is different: it's a **persistent process**, not CGI, so it can't
live inside `public_html` — the deploy pipeline's `rsync -a --delete` would fight a
running process's files, the same reason Matomo lives outside the deploy tree. The
Express app's source stays in git (`hw2/nodejs/`), but it runs as its own long-lived
process on `127.0.0.1:3010`, reverse-proxied by Apache via exact-path
`ProxyPass`/`ProxyPassReverse` lines (one pair per route), and restarted — not
rsynced over — on every deploy.

**Running Node without new sudo access:** the deploy webhook runs unprivileged as
`shekar` with no interactive sudo. Rather than add a NOPASSWD sudoers hole, Express
runs as a **systemd `--user` service**
(`~/.config/systemd/user/hw2-nodejs.service`), which `shekar` can restart with zero
privilege. This needed a one-time `sudo loginctl enable-linger shekar` so the
service survives after logout, plus explicitly exporting `XDG_RUNTIME_DIR` inside
`deploy-site.sh` — the webhook invokes the deploy script with a stripped
environment, so `systemctl --user` can't find the session bus otherwise.

**C is compiled fresh on every deploy.** Source (`.c`/`.h`) and a `Makefile` are
committed; the compiled binaries are gitignored. `deploy-site.sh` runs `make -C
hw2/c` right after `git reset --hard`, before the rsync loop — the Makefile chmods
outputs `+x`, and rsync (which preserves permissions) carries the executable bit
into `public_html/hw2/c/` automatically. A broken C (or Node) commit doesn't take
down the rest of the site's deploy — both build steps are wrapped so their failure
is logged but non-fatal, after discovering the hard way that `deploy-site.sh`'s
`set -e` would otherwise abort the *entire* deploy, including unrelated static
files, over one bad commit in either language.

## Security: escaping and session-ID validation

Every `echo`/`environment`/`state` endpoint reflects attacker-controllable input
back into HTML — form fields, query strings, headers like `User-Agent`. All three
languages HTML-escape that output before it's written (Python's `html.escape`,
a hand-rolled `print_html_escaped` in C, `escapeHtml` in Node) — verified directly
with `<script>` payloads in testing, not just assumed safe.

Session cookies carry an opaque ID, never raw data. Server-side, that ID is
validated against a strict shape (32 lowercase hex characters, matching
`secrets.token_hex(16)`'s output) *before* it's ever used to build a filesystem
path (Python/C, which store session data as `/tmp/hw2-sessions/<id>` files) — this
was checked against an actual path-traversal cookie value
(`hw2_session=../../../etc/passwd`) during testing, which correctly falls through
to "unrecognized session, issue a new one" instead of touching any path outside the
session directory.

## The echo demo and its shared form

`echo-<language>` accepts GET/POST/PUT/DELETE and both
`application/x-www-form-urlencoded` and `application/json` bodies, echoing back
what it received plus hostname, timestamp, `User-Agent`, and the caller's IP.

[hw2/echo-form.html](hw2/echo-form.html) is one shared page that drives all three
backends via language/method/encoding pulldowns. Native `<form>` elements can only
do GET/POST with urlencoded data — there's no HTML-native way to do PUT/DELETE or a
JSON body — so the page is built as progressive enhancement: the plain form (no JS)
always works as a POST/urlencoded submission to one default backend; vanilla
JavaScript then intercepts submission and uses `fetch()` for anything the native
form can't do, rendering the response inline instead of navigating away.

## The state (session) demo

Each language's `state-<language>` shows a currently-saved value, a form to update
it, and a Clear button — one dynamic page rather than separate save/view pages, per
the design decision going in. Session identification is cookie-based, matching the
provided Perl reference demo's own approach:

- **Python/C** (one-shot CGI, no memory shared between requests): session data is
  a small file per session under `/tmp/hw2-sessions/`, the same spirit as the Perl
  demo's `CGI::Session driver:File`.
- **Node** (long-lived process): an in-memory `Map` keyed by the cookie ID — no
  extra dependency needed for a demo this size. Trade-off: it resets if the Node
  service restarts, where the file-backed Python/C sessions don't.

## Extra credit: fingerprinting + cookie reassociation

Separate write-up: [EXTRA_CREDIT_FINGERPRINT.md](EXTRA_CREDIT_FINGERPRINT.md).
Short version: [fingerprint-demo/](fingerprint-demo/) extends the Node app with
[FingerprintJS](https://github.com/fingerprintjs/fingerprintjs) (open-source,
client-side) to show that a returning visitor can still be recognized — and
reassociated with their previous session's data — even after their cookie is
cleared, entirely isolated from the graded `state-nodejs` route (separate cookie
name, separate in-memory store, separate route prefix).
