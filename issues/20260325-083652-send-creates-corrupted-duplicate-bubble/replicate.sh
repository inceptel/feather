#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
SESSION_ID="370e2f60-1399-4ebf-a182-7a8ba6c59ccf"
PAGE_URL="http://localhost:${PORT}/#${SESSION_ID}"

python3 - <<'PY'
from playwright.sync_api import sync_playwright
import time
import sys

port = int(__import__("os").environ.get("PORT", "3301"))
session_id = "370e2f60-1399-4ebf-a182-7a8ba6c59ccf"
url = f"http://localhost:{port}/#{session_id}"
msg = f"worker5-duplicate-probe-{int(time.time() * 1000)}"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path="/usr/bin/google-chrome")
    page = browser.new_page(viewport={"width": 390, "height": 844}, is_mobile=True)
    page.goto(url, wait_until="load", timeout=30000)
    page.wait_for_timeout(2500)
    page.locator("textarea").first.fill(msg)
    page.get_by_role("button", name="Send").click(timeout=5000)
    page.wait_for_timeout(2500)
    bubbles = page.evaluate(
        """(msg) => {
          return [...document.querySelectorAll('div')]
            .filter((el) => {
              const style = getComputedStyle(el)
              return style.backgroundColor === 'rgba(74, 186, 106, 0.15)' && (el.textContent || '').includes(msg)
            })
            .map((el) => (el.textContent || '').trim())
        }""",
        msg,
    )
    browser.close()

exact = msg in bubbles
corrupted = f"\x01d{msg}" in bubbles

if exact and corrupted:
    print(f"BUG PRESENT: found both {msg!r} and prefixed duplicate in user bubbles")
    sys.exit(0)

print(f"BUG ABSENT: bubbles={bubbles!r}")
sys.exit(1)
PY
