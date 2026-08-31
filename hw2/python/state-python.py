#!/usr/bin/env python3
import os
import sys
import secrets
import http.cookies
from html import escape
from urllib.parse import parse_qsl

SESSION_DIR = "/tmp/hw2-sessions"
os.makedirs(SESSION_DIR, mode=0o700, exist_ok=True)

cookie_header = os.environ.get("HTTP_COOKIE", "")
jar = http.cookies.SimpleCookie()
try:
    jar.load(cookie_header)
except http.cookies.CookieError:
    pass

session_id = jar["hw2_session"].value if "hw2_session" in jar else ""
new_cookie = None
# Session IDs are our own secrets.token_hex() output - only accept that exact
# shape from the cookie so a hostile value can never become a filename.
if len(session_id) != 32 or not all(c in "0123456789abcdef" for c in session_id):
    session_id = secrets.token_hex(16)
    new_cookie = session_id

session_file = os.path.join(SESSION_DIR, f"python-{session_id}")

method = os.environ.get("REQUEST_METHOD", "GET")
content_length = int(os.environ.get("CONTENT_LENGTH") or 0)
body = sys.stdin.read(content_length) if content_length > 0 else ""
form = dict(parse_qsl(body)) if body else {}

if method == "POST":
    if form.get("action") == "clear":
        if os.path.exists(session_file):
            os.remove(session_file)
    elif "value" in form:
        with open(session_file, "w") as f:
            f.write(form["value"][:500])

saved_value = ""
if os.path.exists(session_file):
    with open(session_file) as f:
        saved_value = f.read()

print("Cache-Control: no-cache")
if new_cookie:
    print(f"Set-Cookie: hw2_session={new_cookie}; Path=/; HttpOnly; SameSite=Lax")
print("Content-Type: text/html")
print()

print("<!DOCTYPE html>")
print("<html><head><title>State - Python - Shekar Krishnamoorthy</title></head>")
print('<body><h1 align="center">Server-Side State - Python</h1><hr>')
if saved_value:
    print(f"<p><b>Currently saved value:</b> {escape(saved_value)}</p>")
else:
    print("<p><b>Currently saved value:</b> (nothing saved yet)</p>")
print('<form method="POST">')
print('<input type="text" name="value" placeholder="Enter a value" maxlength="500">')
print('<button type="submit">Save</button>')
print('</form>')
print('<form method="POST" style="margin-top:10px">')
print('<input type="hidden" name="action" value="clear">')
print('<button type="submit">Clear</button>')
print('</form>')
print(f"<p style='margin-top:20px;color:#666'>Session ID: {escape(session_id)}</p>")
print("<p>Reload this page after saving a value &mdash; it persists across separate requests via a server-side file keyed by your session cookie, not via localStorage.</p>")
print("</body></html>")
