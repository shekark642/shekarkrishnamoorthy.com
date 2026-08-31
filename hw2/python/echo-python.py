#!/usr/bin/env python3
import os
import sys
import json
import socket
from datetime import datetime
from html import escape
from urllib.parse import parse_qsl

method = os.environ.get("REQUEST_METHOD", "GET")
content_type = os.environ.get("CONTENT_TYPE", "")
query_string = os.environ.get("QUERY_STRING", "")
content_length = int(os.environ.get("CONTENT_LENGTH") or 0)

body = ""
if content_length > 0:
    body = sys.stdin.read(content_length)

received = {}
source = ""
if method in ("POST", "PUT") and body:
    source = "request body"
    if "application/json" in content_type:
        try:
            parsed = json.loads(body)
            if isinstance(parsed, dict):
                received = parsed
            else:
                received = {"_raw": parsed}
        except ValueError:
            received = {"_raw": body}
    else:
        received = dict(parse_qsl(body))
elif query_string:
    source = "query string"
    received = dict(parse_qsl(query_string))

date = datetime.now().strftime("%a %b %d %H:%M:%S %Y")
address = os.environ.get("REMOTE_ADDR", "")
user_agent = os.environ.get("HTTP_USER_AGENT", "")
hostname = socket.gethostname()

print("Cache-Control: no-cache")
print("Content-Type: text/html")
print()

print("<!DOCTYPE html>")
print("<html><head><title>Echo - Python - Shekar Krishnamoorthy</title></head>")
print('<body><h1 align="center">Echo Request - Python</h1><hr>')
print(f"<p><b>HTTP Method:</b> {escape(method)}</p>")
print(f"<p><b>Content-Type received:</b> {escape(content_type) if content_type else '(none)'}</p>")
print(f"<p><b>Data source:</b> {escape(source) if source else '(none)'}</p>")
print("<p><b>Received data:</b></p><ul>")
if received:
    for k, v in received.items():
        print(f"<li>{escape(str(k))} = {escape(str(v))}</li>")
else:
    print("<li>(nothing received)</li>")
print("</ul>")
print(f"<p><b>Server hostname:</b> {escape(hostname)}</p>")
print(f"<p><b>Date/time:</b> {escape(date)}</p>")
print(f"<p><b>User-Agent:</b> {escape(user_agent)}</p>")
print(f"<p><b>Your IP Address:</b> {escape(address)}</p>")
print("</body></html>")
