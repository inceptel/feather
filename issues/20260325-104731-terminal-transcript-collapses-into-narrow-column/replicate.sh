#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3305}"
SESSION_ID="370e2f60-1399-4ebf-a182-7a8ba6c59ccf"
BASE="http://localhost:${PORT}"

python3 - "$BASE" "$SESSION_ID" <<'PY'
import json
import sys
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

base = sys.argv[1]
session_id = sys.argv[2]
needle = "Codex finder is a bug-finding machine"

with urllib.request.urlopen(f"{base}/api/sessions/{session_id}/messages?limit=200", timeout=10) as response:
    payload = json.load(response)

transcript_texts = []
for message in payload.get("messages", []):
    for block in message.get("content", []):
        if isinstance(block, dict) and isinstance(block.get("text"), str):
            transcript_texts.append(block["text"])

seeded_transcript_present = any(needle in text for text in transcript_texts)
if not seeded_transcript_present:
    print("BUG ABSENT: seeded transcript text is no longer present in /api/sessions output")
    raise SystemExit(1)

with sync_playwright() as p:
    browser = p.chromium.launch(args=["--no-sandbox"])
    page = browser.new_page(viewport={"width": 390, "height": 844}, is_mobile=True)
    page.goto(f"{base}/#{session_id}", wait_until="domcontentloaded")
    page.wait_for_timeout(2000)
    page.get_by_role("button", name="Terminal").click()
    page.wait_for_timeout(1500)

    screen = page.locator(".xterm-screen")
    rows = page.locator(".xterm-rows")

    width = None
    if screen.count():
        box = screen.bounding_box()
        if box:
            width = box["width"]

    rows_text = rows.inner_text(timeout=2000) if rows.count() else ""
    browser.close()

built_asset = Path("/home/user/feather-dev/w5/static/assets/index-BmzmEqFf.js").read_text(encoding="utf-8")
uses_prefixed_terminal_ws = "/new-dev/api/terminal" in built_asset

bug_present = bool(width is not None and width < 100 and needle.split()[0] in rows_text)

if bug_present:
    print(f"BUG PRESENT: terminal transcript rendered in a narrow column (xterm-screen width={width:.1f}px)")
    raise SystemExit(0)

print(
    "BUG ABSENT: mobile terminal did not collapse into a narrow transcript column; "
    f"xterm-screen width={width}, rows_text={rows_text[:40]!r}, "
    f"built_asset_uses_prefixed_terminal_ws={uses_prefixed_terminal_ws}"
)
raise SystemExit(1)
PY
