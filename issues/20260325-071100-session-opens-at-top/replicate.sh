#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
TARGET_ID="4baa1292-7fdf-4e87-af47-6731e459b3cd"
TARGET_TITLE="worker 4 probe"
URL="http://localhost:${PORT}/#${TARGET_ID}"

python3 - "$PORT" "$TARGET_ID" "$TARGET_TITLE" "$URL" <<'PY'
import json
import sys
import urllib.request
from playwright.sync_api import sync_playwright

port, target_id, target_title, url = sys.argv[1:5]
origin = f"http://localhost:{port}"

with urllib.request.urlopen(f"{origin}/api/sessions?limit=500") as response:
    sessions_payload = json.load(response)

sessions = sessions_payload.get("sessions", [])
target_session = next((session for session in sessions if session.get("id") == target_id), None)
if not target_session:
    print(f"BUG ABSENT: session {target_id} not found in {origin}/api/sessions?limit=500")
    sys.exit(1)

if target_session.get("title") != target_title:
    print(
        "BUG ABSENT: "
        f"session {target_id} title was {target_session.get('title')!r}, expected {target_title!r}"
    )
    sys.exit(1)

with urllib.request.urlopen(f"{origin}/api/sessions/{target_id}/messages") as response:
    messages_payload = json.load(response)

messages = messages_payload.get("messages", [])
if len(messages) < 50:
    print(f"BUG ABSENT: transcript only has {len(messages)} messages, not the long session from the report")
    sys.exit(1)

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 390, "height": 844})
    page.goto(url, wait_until="domcontentloaded", timeout=15000)
    page.wait_for_timeout(5000)
    result = page.evaluate(
        """() => {
          const scrollers = [...document.querySelectorAll('div')]
            .filter((el) => getComputedStyle(el).overflowY !== 'visible' && el.scrollHeight > el.clientHeight + 1000)
            .sort((a, b) => b.scrollHeight - a.scrollHeight)
          const scroller = scrollers[0]
          if (!scroller) {
            return { found: false, bugPresent: false }
          }
          return {
            found: true,
            href: location.href,
            title: document.title,
            scrollTop: scroller.scrollTop,
            scrollHeight: scroller.scrollHeight,
            clientHeight: scroller.clientHeight,
            bugPresent: scroller.scrollTop <= 100
          }
        }"""
    )
    browser.close()

if result.get("bugPresent"):
    print("BUG PRESENT:", json.dumps(result, sort_keys=True))
    sys.exit(0)

print("BUG ABSENT:", json.dumps(result, sort_keys=True))
sys.exit(1)
PY
