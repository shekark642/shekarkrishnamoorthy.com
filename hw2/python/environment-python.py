#!/usr/bin/env python3
import os
from html import escape

print("Cache-Control: no-cache")
print("Content-Type: text/html")
print()

print("<!DOCTYPE html>")
print("<html><head><title>Environment Variables - Python - Shekar Krishnamoorthy</title></head>")
print('<body><h1 align="center">Environment Variables - Python - Shekar Krishnamoorthy</h1><hr>')
for key in sorted(os.environ.keys()):
    print(f"<b>{escape(key)}:</b> {escape(os.environ[key])}<br />")
print("</body></html>")
