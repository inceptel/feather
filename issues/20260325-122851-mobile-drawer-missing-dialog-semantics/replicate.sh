#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
WORKTREE="${WORKTREE:-/home/user/feather-dev/w5}"
APP_TSX="$WORKTREE/frontend/src/App.tsx"
ISSUE_SLUG="20260325-122851-mobile-drawer-missing-dialog-semantics"
S="replicate-${ISSUE_SLUG}-$$"

cleanup() {
  agent-browser --session-name "$S" close >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [ ! -f "$APP_TSX" ]; then
  echo "App source not found at $APP_TSX"
  exit 1
fi

agent-browser --session-name "$S" set viewport 390 844 >/dev/null
agent-browser --session-name "$S" open "http://localhost:$PORT/" >/dev/null
agent-browser --session-name "$S" wait --load networkidle >/dev/null
agent-browser --session-name "$S" wait 1500 >/dev/null

INITIAL_SNAPSHOT="$(agent-browser --session-name "$S" snapshot -i)"
if ! printf '%s\n' "$INITIAL_SNAPSHOT" | grep -F 'button "☰"' >/dev/null; then
  echo "Hamburger button was not visible on mobile."
  exit 1
fi

agent-browser --session-name "$S" find role button click --name "☰" >/dev/null
agent-browser --session-name "$S" wait 500 >/dev/null

OPEN_SNAPSHOT="$(agent-browser --session-name "$S" snapshot -i)"
if ! printf '%s\n' "$OPEN_SNAPSHOT" | grep -F 'button "Close session drawer"' >/dev/null; then
  echo "Drawer did not open."
  exit 1
fi

if node - "$APP_TSX" <<'NODE'
const fs = require('fs')
const file = process.argv[2]
const src = fs.readFileSync(file, 'utf8')
const hasSidebarContainer =
  src.includes("width: sidebar() ? '300px' : '0'") &&
  src.includes("min-width': sidebar() ? '300px' : '0'") &&
  src.includes("background: '#0d1117'") &&
  src.includes("<Show when={sidebar()}>")
const hasDialogSemantics =
  src.includes('role="dialog"') ||
  src.includes("role={'dialog'}") ||
  src.includes("role: 'dialog'") ||
  src.includes('aria-modal="true"') ||
  src.includes("aria-modal={'true'}") ||
  src.includes("aria-modal={true}") ||
  src.includes("'aria-modal': 'true'")
process.exit(hasSidebarContainer && !hasDialogSemantics ? 0 : 1)
NODE
then
  echo "BUG PRESENT: mobile drawer opens, but the drawer container still lacks dialog semantics."
  exit 0
else
  echo "BUG ABSENT: drawer source now includes dialog semantics or the drawer markup changed."
  exit 1
fi
