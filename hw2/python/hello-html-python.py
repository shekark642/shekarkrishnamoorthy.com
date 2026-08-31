#!/usr/bin/env python3
import os
from datetime import datetime
from html import escape

print("Cache-Control: no-cache")
print("Content-Type: text/html")
print()

date = datetime.now().strftime("%a %b %d %H:%M:%S %Y")
address = escape(os.environ.get("REMOTE_ADDR", ""))

print("<!DOCTYPE html>")
print("<html>")
print("<head><title>Hello CGI World - Shekar Krishnamoorthy</title></head>")
print("<body>")
print("<h1 align=center>Hello HTML World - Shekar Krishnamoorthy</h1><hr/>")
print("<p>Hello World, from Shekar Krishnamoorthy</p>")
print("<p>This page was generated with the Python programming language</p>")
print(f"<p>This program was generated at: {date}</p>")
print(f"<p>Your current IP Address is: {address}</p>")
print("</body>")
print("</html>")
