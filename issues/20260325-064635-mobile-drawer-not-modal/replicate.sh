#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
S="replicate-$$"
CLAUDE_ROOT="${HOME:-/home/user}/.claude/projects"
PROJECT_DIR="$(find "$CLAUDE_ROOT" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
ID="drawer-modal-repro-$$-$(date +%s)"
SESSION_PATH="$PROJECT_DIR/$ID.jsonl"
PROBE="drawer modal probe $$"

cleanup() {
  agent-browser --session-name "$S" close >/dev/null 2>&1 || true
  rm -f "$SESSION_PATH"
}
trap cleanup EXIT

if [ -z "${PROJECT_DIR:-}" ]; then
  echo "No Claude project directory found under $CLAUDE_ROOT" >&2
  exit 1
fi

js_string() {
  python3 -c 'import json, sys; print(json.dumps(sys.argv[1]))' "$1"
}

cat > "$SESSION_PATH" <<'JSONL'
{"type":"user","uuid":"seed-user","timestamp":"2026-03-25T00:00:00Z","isSidechain":false,"isMeta":false,"message":{"role":"user","content":"Open this seeded session"}}
{"type":"assistant","uuid":"seed-assistant","timestamp":"2026-03-25T00:00:01Z","isSidechain":false,"isMeta":false,"message":{"role":"assistant","content":"Seed reply"}}
JSONL

agent-browser --session-name "$S" set viewport 390 844 >/dev/null
agent-browser --session-name "$S" open "http://127.0.0.1:$PORT/#$ID" >/dev/null
agent-browser --session-name "$S" wait --load networkidle >/dev/null
for _ in 1 2 3 4 5 6 7 8; do
  agent-browser --session-name "$S" wait 1000 >/dev/null
  READY="$(agent-browser --session-name "$S" eval 'Boolean(document.querySelector("textarea[placeholder=\"Send a message...\"]"))')"
  if [ "$READY" = "true" ]; then
    break
  fi
done

agent-browser --session-name "$S" eval "window.__probe = $(js_string "$PROBE"); window.__expectedHash = $(js_string "#$ID"); 'vars-set'" >/dev/null
agent-browser --session-name "$S" eval '(() => {
  const menu = document.querySelector("button")
  if (!menu) throw new Error("menu button missing")
  menu.click()
  return "drawer-open"
})()' >/dev/null
agent-browser --session-name "$S" wait 800 >/dev/null

RESULT="$(agent-browser --session-name "$S" eval '(() => {
  const probe = window.__probe
  const expectedHash = window.__expectedHash
  const textarea = document.querySelector("textarea[placeholder=\"Send a message...\"]")
  const send = [...document.querySelectorAll("button")].find((button) => (button.textContent || "").trim() === "Send")
  if (!textarea || !send) return JSON.stringify({ error: "composer missing" })

  const textareaRect = textarea.getBoundingClientRect()
  const sendRect = send.getBoundingClientRect()
  const visible = textareaRect.width > 0 && textareaRect.height > 0 && sendRect.width > 0 && sendRect.height > 0

  const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set
  if (!setValue) return JSON.stringify({ error: "textarea setter missing" })

  setValue.call(textarea, probe)
  textarea.dispatchEvent(new Event("input", { bubbles: true }))
  send.click()

  const bodyHasProbe = document.body.innerText.includes(probe)
  return JSON.stringify({
    visible,
    bodyHasProbe,
    hash: location.hash,
    textareaRect: { width: textareaRect.width, height: textareaRect.height },
    sendRect: { width: sendRect.width, height: sendRect.height },
    bugPresent: visible && bodyHasProbe && location.hash === expectedHash,
  })
})()')"

printf '%s\n' "$RESULT"

python3 - <<'PY' "$RESULT"
import json
import sys

obj = json.loads(sys.argv[1])
if isinstance(obj, str):
    obj = json.loads(obj)
raise SystemExit(0 if obj.get("bugPresent") else 1)
PY
