#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
S="replicate-$$"
CLAUDE_ROOT="${HOME:-/home/user}/.claude/projects"
PROJECT_DIR="$(find "$CLAUDE_ROOT" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
ID="drawer-squeeze-repro-$$-$(date +%s)"
SESSION_PATH="$PROJECT_DIR/$ID.jsonl"

cleanup() {
  agent-browser --session-name "$S" close >/dev/null 2>&1 || true
  rm -f "$SESSION_PATH"
}
trap cleanup EXIT

if [ -z "${PROJECT_DIR:-}" ]; then
  echo "No Claude project directory found under $CLAUDE_ROOT" >&2
  exit 1
fi

cat > "$SESSION_PATH" <<'JSONL'
{"type":"user","uuid":"seed-user","timestamp":"2026-03-25T00:00:00Z","isSidechain":false,"isMeta":false,"message":{"role":"user","content":"Open this seeded session"}}
{"type":"assistant","uuid":"seed-assistant","timestamp":"2026-03-25T00:00:01Z","isSidechain":false,"isMeta":false,"message":{"role":"assistant","content":"Seed reply"}}
JSONL

agent-browser --session-name "$S" set viewport 390 844 >/dev/null
agent-browser --session-name "$S" open "http://127.0.0.1:$PORT/#$ID" >/dev/null
agent-browser --session-name "$S" wait --load networkidle >/dev/null

for _ in 1 2 3 4 5 6 7 8; do
  agent-browser --session-name "$S" wait 500 >/dev/null
  READY="$(agent-browser --session-name "$S" eval 'Boolean(document.querySelector("textarea[placeholder=\"Send a message...\"]"))')"
  if [ "$READY" = "true" ]; then
    break
  fi
done

agent-browser --session-name "$S" eval '(() => {
  const menu = [...document.querySelectorAll("button")].find((el) => (el.textContent || "").includes("☰"))
  if (!menu) throw new Error("menu button missing")
  menu.click()
  return "drawer-open"
})()' >/dev/null
agent-browser --session-name "$S" wait 800 >/dev/null

RESULT="$(agent-browser --session-name "$S" eval 'JSON.stringify((() => {
  const buttons = [...document.querySelectorAll("button")]
  const chat = buttons.find((el) => (el.textContent || "").trim() === "Chat")
  const terminal = buttons.find((el) => (el.textContent || "").trim() === "Terminal")
  const send = buttons.find((el) => (el.textContent || "").trim() === "Send")
  const textarea = document.querySelector("textarea[placeholder=\"Send a message...\"]")
  const main = [...document.querySelectorAll("div")].find((el) => {
    const s = getComputedStyle(el)
    return s.flex === "1 1 0%" && s.minWidth === "0px" && s.flexDirection === "column"
  })
  const sidebar = [...document.querySelectorAll("div")].find((el) => getComputedStyle(el).zIndex === "40")
  const rect = (el) => el ? el.getBoundingClientRect() : null
  const viewportWidth = window.innerWidth
  const mainRect = rect(main)
  const sidebarRect = rect(sidebar)
  const chatRect = rect(chat)
  const terminalRect = rect(terminal)
  const sendRect = rect(send)
  const textareaRect = rect(textarea)

  return {
    viewportWidth,
    mainWidth: mainRect ? mainRect.width : null,
    sidebarWidth: sidebarRect ? sidebarRect.width : null,
    chatX: chatRect ? chatRect.x : null,
    chatWidth: chatRect ? chatRect.width : null,
    terminalRight: terminalRect ? terminalRect.right : null,
    textareaX: textareaRect ? textareaRect.x : null,
    textareaWidth: textareaRect ? textareaRect.width : null,
    sendRight: sendRect ? sendRect.right : null,
    bugPresent: Boolean(
      mainRect &&
      sidebarRect &&
      chatRect &&
      terminalRect &&
      textareaRect &&
      sendRect &&
      mainRect.width < viewportWidth * 0.4 &&
      sidebarRect.width >= 300 &&
      terminalRect.right > viewportWidth &&
      textareaRect.width < 60 &&
      sendRect.right > viewportWidth
    ),
  }
})())')"

printf '%s\n' "$RESULT"

python3 - <<'PY' "$RESULT"
import json
import sys

obj = json.loads(sys.argv[1])
if isinstance(obj, str):
    obj = json.loads(obj)
raise SystemExit(0 if obj.get("bugPresent") else 1)
PY
