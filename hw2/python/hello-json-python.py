#!/usr/bin/env python3
import os
import json
from datetime import datetime

print("Cache-Control: no-cache")
print("Content-Type: application/json")
print()

date = datetime.now().strftime("%a %b %d %H:%M:%S %Y")
address = os.environ.get("REMOTE_ADDR", "")

message = {
    "title": "Hello, Python! - Shekar Krishnamoorthy",
    "heading": "Hello, Python! - Shekar Krishnamoorthy",
    "message": "This page was generated with the Python programming language",
    "time": date,
    "IP": address,
}

print(json.dumps(message))
