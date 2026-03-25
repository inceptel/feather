#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3305}"
BASE="http://localhost:${PORT}"
ISSUE_DIR="/home/user/feather-dev/w5/issues/20260325-071717-composer-draft-leaks-across-sessions"
APP_FILE="/home/user/feather-dev/w5/frontend/src/App.tsx"
TARGET_ID="4baa1292-7fdf-4e87-af47-6731e459b3cd"
PROBE="worker4 iter28 delivery state probe"

TARGET_TITLE="$(curl -fsS "$BASE/api/sessions?limit=500" | jq -r --arg id "$TARGET_ID" 'first((.sessions // [])[] | select(.id == $id) | .title) // empty')"
if [ -z "$TARGET_TITLE" ]; then
  echo "BUG ABSENT: target session $TARGET_ID is unavailable from $BASE/api/sessions?limit=500"
  exit 1
fi

SOURCE_EVIDENCE="$(python3 - "$APP_FILE" <<'PY'
import json
import pathlib
import re
import sys

src = pathlib.Path(sys.argv[1]).read_text()

def body_between(start_marker: str, end_marker: str) -> str:
    try:
        start = src.index(start_marker)
        end = src.index(end_marker, start)
    except ValueError:
        return ""
    return src[start:end]

select_body = body_between("async function select(id: string) {", "async function handleNew() {")
new_body = body_between("async function handleNew() {", "async function handleResume(id: string) {")
resume_body = body_between("async function handleResume(id: string) {", "async function handleSend() {")
send_body = body_between("async function handleSend() {", "const cur = () =>")

result = {
    "globalTextSignal": "const [text, setText] = createSignal('')" in src,
    "textareaUsesText": "textarea ref={textareaRef} value={text()}" in src,
    "selectClearsText": "setText(" in select_body,
    "resumeClearsText": "setText(" in resume_body,
    "newClearsText": "setText(" in new_body,
    "sendClearsText": "setText('')" in send_body,
}

print(json.dumps(result))
PY
)"

BROWSER_RESULT="$(python3 - "$PORT" "$TARGET_ID" "$PROBE" <<'PY'
import json
import sys
import urllib.request
from playwright.sync_api import sync_playwright

port, target_id, probe = sys.argv[1:4]
origin = f"http://localhost:{port}"

with urllib.request.urlopen(f"{origin}/api/sessions?limit=500") as response:
    sessions_payload = json.load(response)

sessions = sessions_payload.get("sessions", [])
other_sessions = [session for session in sessions if session.get("id") != target_id]
if not other_sessions:
    print(json.dumps({"error": "no alternate session available"}))
    raise SystemExit(1)

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 390, "height": 844})
    page.goto(f"{origin}/#{target_id}", wait_until="domcontentloaded", timeout=15000)
    page.wait_for_timeout(3000)

    textarea = page.locator('textarea[placeholder="Send a message..."]')
    textarea.wait_for(state="visible", timeout=15000)
    textarea.fill(probe)

    page.locator('button:has-text("☰")').click()
    page.wait_for_timeout(500)

    switched = page.evaluate(
        """() => {
          const buttons = [...document.querySelectorAll('button')]
          const candidate = buttons.find((button) => {
            const ariaCurrent = button.getAttribute('aria-current')
            const text = (button.textContent || '').replace(/\\s+/g, ' ').trim()
            if (ariaCurrent === 'page') return false
            if (!text) return false
            if (text === '×' || text === '☰' || text.includes('+ New Claude')) return false
            if (text === 'Chat' || text === 'Terminal' || text === 'Send' || text === 'Resume') return false
            return true
          })
          if (!candidate) return null
          const pickedText = (candidate.textContent || '').replace(/\\s+/g, ' ').trim()
          candidate.click()
          return { pickedText, beforeHash: location.hash }
        }"""
    )
    page.wait_for_timeout(1000)

    result = page.evaluate(
        """({ probe, targetId }) => {
          const textarea = document.querySelector('textarea[placeholder="Send a message..."]')
          return {
            href: location.href,
            hash: location.hash,
            value: textarea ? textarea.value : null,
            sameProbe: textarea ? textarea.value === probe : false,
            switchedAway: location.hash !== `#${targetId}`
          }
        }""",
        {"probe": probe, "targetId": target_id},
    )
    browser.close()

print(json.dumps({"switched": switched, "result": result}))
PY
)"

printf '%s\n' "$SOURCE_EVIDENCE"
printf '%s\n' "$BROWSER_RESULT"

python3 - "$SOURCE_EVIDENCE" "$BROWSER_RESULT" <<'PY'
import json
import sys

source = json.loads(sys.argv[1])
browser = json.loads(sys.argv[2])
result = browser.get("result") or {}

source_bug = (
    source.get("globalTextSignal")
    and source.get("textareaUsesText")
    and not source.get("selectClearsText")
)

browser_bug = (
    browser.get("switched") is not None
    and result.get("switchedAway")
    and result.get("sameProbe")
)

if source_bug and browser_bug:
    print("BUG PRESENT: the composer draft is stored in one global text signal and survives selecting a different session in the mobile UI")
    raise SystemExit(0)

print("BUG ABSENT: current source/browser behavior no longer shows cross-session draft leakage")
raise SystemExit(1)
PY
