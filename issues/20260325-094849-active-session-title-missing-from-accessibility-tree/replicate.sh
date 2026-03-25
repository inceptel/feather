#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3305}"
BASE="http://localhost:${PORT}"
APP_FILE="/home/user/feather-dev/w5/frontend/src/App.tsx"

TARGET_JSON="$(curl -fsS "$BASE/api/sessions" | python3 -c 'import json, sys; sessions = json.load(sys.stdin)["sessions"]; target = next((s for s in sessions if s.get("isActive")), sessions[0] if sessions else None); print(json.dumps(target or {}))')"
TARGET_ID="$(printf '%s' "$TARGET_JSON" | python3 -c 'import json, sys; print(json.load(sys.stdin).get("id", ""))')"
TARGET_TITLE="$(printf '%s' "$TARGET_JSON" | python3 -c 'import json, sys; print(json.load(sys.stdin).get("title", ""))')"

if [ -z "$TARGET_ID" ] || [ -z "$TARGET_TITLE" ]; then
  echo "BUG ABSENT: no session with a visible title is available from $BASE/api/sessions"
  exit 1
fi

SOURCE_EVIDENCE="$(python3 - "$APP_FILE" <<'PY'
import json
import pathlib
import sys

src = pathlib.Path(sys.argv[1]).read_text()
print(json.dumps({
    "headerFallbackPresent": "Select a session" in src,
    "headerTitleSpanPresent": "{s().title}" in src,
    "headerUsesHeading": "<h1" in src or 'role="heading"' in src or "aria-level" in src,
}))
PY
)"

BROWSER_RESULT="$(python3 - "$PORT" "$TARGET_ID" "$TARGET_TITLE" <<'PY'
import json
import sys
from playwright.sync_api import sync_playwright

port, target_id, target_title = sys.argv[1:4]
origin = f"http://localhost:{port}"

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 390, "height": 844})
    page.goto(f"{origin}/#{target_id}", wait_until="domcontentloaded", timeout=15000)
    page.wait_for_timeout(3000)

    result = page.evaluate(
        """(expectedTitle) => {
          const spans = [...document.querySelectorAll('span')];
          const headerTitle = spans.find((node) => {
            const text = (node.textContent || '').trim();
            if (text !== expectedTitle) return false;
            if (node.closest('button')) return false;
            const rect = node.getBoundingClientRect();
            return rect.top >= 0 && rect.top < 90 && rect.width > 0 && rect.height > 0;
          });
          if (!headerTitle) {
            return { foundVisibleHeaderTitle: false };
          }
          const rect = headerTitle.getBoundingClientRect();
          return {
            foundVisibleHeaderTitle: true,
            visibleTitle: (headerTitle.textContent || '').trim(),
            top: Math.round(rect.top),
            left: Math.round(rect.left),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          };
        }""",
        target_title,
    )
    aria_snapshot = page.locator("body").aria_snapshot(timeout=15000)
    browser.close()

print(json.dumps({
    "result": result,
    "ariaHasTitle": target_title in aria_snapshot,
    "ariaPreview": aria_snapshot[:1200],
}))
PY
)"

printf '%s\n' "$SOURCE_EVIDENCE"
printf '%s\n' "$BROWSER_RESULT"

python3 - "$SOURCE_EVIDENCE" "$BROWSER_RESULT" "$TARGET_TITLE" <<'PY'
import json
import sys

source = json.loads(sys.argv[1])
browser = json.loads(sys.argv[2])
target_title = sys.argv[3]
result = browser.get("result") or {}

bug_present = (
    source.get("headerTitleSpanPresent")
    and result.get("foundVisibleHeaderTitle")
    and result.get("visibleTitle") == target_title
    and not browser.get("ariaHasTitle")
)

if bug_present:
    print("BUG PRESENT: the mobile header visibly renders the active session title, but the ARIA snapshot still omits that text")
    raise SystemExit(0)

print("BUG ABSENT: the mobile header title is visible and the current ARIA snapshot includes it")
raise SystemExit(1)
PY
