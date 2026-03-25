#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
URL="http://localhost:${PORT}/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf"

RESULT="$(timeout 45s python3 - <<'PY'
import json
from playwright.sync_api import sync_playwright

url = __import__("os").environ["URL"]

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 390, "height": 844})
    page.goto(url, wait_until="domcontentloaded", timeout=15000)
    page.wait_for_timeout(3000)
    page.get_by_text("Terminal", exact=True).click()
    page.wait_for_timeout(2000)
    metrics = page.evaluate(
        """() => {
            const screen = document.querySelector('.xterm-screen');
            if (!screen) return { hasScreen: false };
            const rect = screen.getBoundingClientRect();
            const rows = [...document.querySelectorAll('.xterm-rows > div')]
              .map((el) => (el.textContent || '').trim())
              .filter(Boolean)
              .slice(-5);
            return {
              hasScreen: true,
              viewportHeight: window.innerHeight,
              screenTop: rect.top,
              screenBottom: rect.bottom,
              overflowBottom: rect.bottom - window.innerHeight,
              rows,
            };
        }"""
    )
    browser.close()

print(json.dumps(metrics))
PY
)"

if [ -z "$RESULT" ]; then
  echo "BUG ABSENT: browser probe returned no metrics"
  exit 1
fi

export RESULT
python3 - <<'PY'
import json
import os
import sys

metrics = json.loads(os.environ["RESULT"])
if not metrics.get("hasScreen"):
    print("BUG ABSENT: terminal screen did not render")
    sys.exit(1)

overflow = float(metrics.get("overflowBottom", 0))
rows = metrics.get("rows", [])
if overflow > 1:
    print(
        f"BUG PRESENT: .xterm-screen overflows {overflow:.1f}px below the 844px mobile viewport; "
        f"tail rows={rows}"
    )
    sys.exit(0)

print(
    f"BUG ABSENT: .xterm-screen stays within the viewport "
    f"(bottom={metrics.get('screenBottom')}, viewport={metrics.get('viewportHeight')}); tail rows={rows}"
)
sys.exit(1)
PY
