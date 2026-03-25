#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
APP_TSX="/home/user/feather-dev/w5/frontend/src/App.tsx"
HELPER_TEXT="No quick links yet. Use /feather add link to add some."
S="replicate-$$"

cleanup() {
  agent-browser --session-name "$S" close >/dev/null 2>&1 || true
}
trap cleanup EXIT

agent-browser --session-name "$S" set viewport 390 844 >/dev/null
agent-browser --session-name "$S" open "http://localhost:$PORT/" >/dev/null
agent-browser --session-name "$S" wait --load networkidle >/dev/null
agent-browser --session-name "$S" wait 2000 >/dev/null

UI_STATE="$(agent-browser --session-name "$S" eval "
(() => {
  const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
  const buttonByText = (text) => [...document.querySelectorAll('button')].find((el) => normalize(el.textContent) === text) || null;

  const menu = buttonByText('☰');
  if (!menu) {
    return { menuFound: false, drawerOpen: false, linksFound: false, helperVisible: false };
  }

  menu.click();

  const closeButton = document.querySelector('button[aria-label=\"Close session drawer\"]');
  const linksButton = buttonByText('Links');
  if (linksButton) linksButton.click();

  const helperVisible = [...document.querySelectorAll('div, p, span')].some((el) => normalize(el.textContent) === '${HELPER_TEXT}');

  return {
    menuFound: true,
    drawerOpen: !!closeButton,
    linksFound: !!linksButton,
    helperVisible
  };
})()
")" || {
  echo "BUG ABSENT: failed to inspect current drawer UI"
  exit 1
}

agent-browser --session-name "$S" wait 500 >/dev/null
SNAPSHOT="$(timeout 8s agent-browser --session-name "$S" snapshot -i || true)"

SOURCE_HAS_LINKS=0
SOURCE_HAS_HELPER=0
rg -Fq '"Links"' "$APP_TSX" && SOURCE_HAS_LINKS=1
rg -Fq "$HELPER_TEXT" "$APP_TSX" && SOURCE_HAS_HELPER=1

BUG_PRESENT="$(printf '%s\n' "$UI_STATE" | jq --arg helper "$HELPER_TEXT" --arg snapshot "$SNAPSHOT" '
  (.menuFound == true) and
  (.drawerOpen == true) and
  (.linksFound == true) and
  (.helperVisible == true) and
  ($snapshot | contains($helper) | not)
')"

if [ "$BUG_PRESENT" = "true" ] && [ "$SOURCE_HAS_LINKS" -eq 1 ] && [ "$SOURCE_HAS_HELPER" -eq 1 ]; then
  echo "BUG PRESENT: links helper text is visible in the drawer but missing from the accessibility snapshot"
  exit 0
fi

if printf '%s' "$SNAPSHOT" | grep -Fq "$HELPER_TEXT"; then
  SNAPSHOT_HAS_HELPER=1
else
  SNAPSHOT_HAS_HELPER=0
fi

echo "BUG ABSENT: ui_state=$UI_STATE source_flags=links:$SOURCE_HAS_LINKS helper:$SOURCE_HAS_HELPER snapshot_has_helper=$SNAPSHOT_HAS_HELPER"
exit 1
