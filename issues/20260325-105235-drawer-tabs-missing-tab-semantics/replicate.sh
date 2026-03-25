#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
APP_TSX="/home/user/feather-dev/w5/frontend/src/App.tsx"
S="replicate-$$"

cleanup() {
  agent-browser --session-name "$S" close >/dev/null 2>&1 || true
}
trap cleanup EXIT

agent-browser --session-name "$S" set viewport 390 844 >/dev/null
agent-browser --session-name "$S" open "http://localhost:$PORT/" >/dev/null
agent-browser --session-name "$S" wait --load networkidle >/dev/null
agent-browser --session-name "$S" wait 2000 >/dev/null

MEASURED="$(agent-browser --session-name "$S" eval '
(() => {
  const menuButton = [...document.querySelectorAll("button")].find((el) => (el.textContent || "").trim() === "☰");
  if (!menuButton) {
    return { menuFound: false, drawerOpen: false, sessionsFound: false, linksFound: false, tablistCount: 0, tabRoleCount: 0 };
  }

  menuButton.click();

  const byText = (text) => [...document.querySelectorAll("button")].find((el) => (el.textContent || "").trim() === text) || null;
  const sessions = byText("Sessions");
  const links = byText("Links");
  const tablists = [...document.querySelectorAll("[role=\"tablist\"]")];
  const tabs = [...document.querySelectorAll("[role=\"tab\"]")];

  const closeButton = document.querySelector("button[aria-label=\"Close session drawer\"]");

  return {
    menuFound: true,
    drawerOpen: !!closeButton,
    sessionsFound: !!sessions,
    linksFound: !!links,
    sessionsRole: sessions ? sessions.getAttribute("role") : null,
    linksRole: links ? links.getAttribute("role") : null,
    sessionsSelected: sessions ? sessions.getAttribute("aria-selected") : null,
    linksSelected: links ? links.getAttribute("aria-selected") : null,
    sessionsControls: sessions ? sessions.getAttribute("aria-controls") : null,
    linksControls: links ? links.getAttribute("aria-controls") : null,
    tablistCount: tablists.length,
    tabRoleCount: tabs.length
  };
})()
')" || {
  echo "BUG ABSENT: failed to inspect drawer state"
  exit 1
}

SOURCE_SESSIONS_PRESENT=0
SOURCE_LINKS_PRESENT=0
SOURCE_TABLIST_PRESENT=0
SOURCE_TAB_ROLE_PRESENT=0
SOURCE_ARIA_SELECTED_PRESENT=0
SOURCE_ARIA_CONTROLS_PRESENT=0

rg -Fq '"Sessions"' "$APP_TSX" && SOURCE_SESSIONS_PRESENT=1
rg -Fq '"Links"' "$APP_TSX" && SOURCE_LINKS_PRESENT=1
rg -Fq 'role="tablist"' "$APP_TSX" && SOURCE_TABLIST_PRESENT=1
rg -Fq 'role="tab"' "$APP_TSX" && SOURCE_TAB_ROLE_PRESENT=1
rg -Fq 'aria-selected' "$APP_TSX" && SOURCE_ARIA_SELECTED_PRESENT=1
rg -Fq 'aria-controls' "$APP_TSX" && SOURCE_ARIA_CONTROLS_PRESENT=1

BUG_PRESENT="$(printf '%s\n' "$MEASURED" | jq '
  (.menuFound == true) and
  (.drawerOpen == true) and
  (.sessionsFound == true) and
  (.linksFound == true) and
  (.tablistCount == 0) and
  (.tabRoleCount == 0) and
  (.sessionsRole == null) and
  (.linksRole == null) and
  (.sessionsSelected == null) and
  (.linksSelected == null) and
  (.sessionsControls == null) and
  (.linksControls == null)
')"

if [ "$BUG_PRESENT" = "true" ] && \
   [ "$SOURCE_SESSIONS_PRESENT" -eq 1 ] && \
   [ "$SOURCE_LINKS_PRESENT" -eq 1 ] && \
   [ "$SOURCE_TABLIST_PRESENT" -eq 0 ] && \
   [ "$SOURCE_TAB_ROLE_PRESENT" -eq 0 ] && \
   [ "$SOURCE_ARIA_SELECTED_PRESENT" -eq 0 ] && \
   [ "$SOURCE_ARIA_CONTROLS_PRESENT" -eq 0 ]; then
  echo "BUG PRESENT: drawer exposes Sessions/Links buttons without tab semantics"
  exit 0
fi

echo "BUG ABSENT: measured=$MEASURED source_flags=sessions:$SOURCE_SESSIONS_PRESENT links:$SOURCE_LINKS_PRESENT tablist:$SOURCE_TABLIST_PRESENT tab:$SOURCE_TAB_ROLE_PRESENT aria_selected:$SOURCE_ARIA_SELECTED_PRESENT aria_controls:$SOURCE_ARIA_CONTROLS_PRESENT"
exit 1
