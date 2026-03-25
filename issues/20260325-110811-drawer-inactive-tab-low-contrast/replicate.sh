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
  const buttonText = (el) => (el?.textContent || "").trim();
  const menuButton = [...document.querySelectorAll("button")].find((el) => buttonText(el) === "☰") || null;
  if (!menuButton) {
    return { menuFound: false, drawerOpen: false, sessionsFound: false, linksFound: false };
  }

  menuButton.click();

  const buttons = [...document.querySelectorAll("button")];
  const sessionsButton = buttons.find((el) => buttonText(el) === "Sessions") || null;
  const linksButton = buttons.find((el) => buttonText(el) === "Links") || null;
  const closeButton = document.querySelector("button[aria-label=\"Close session drawer\"]");

  const bg = (el) => {
    if (!el) return null;
    let node = el;
    while (node) {
      const color = getComputedStyle(node).backgroundColor;
      if (color && color !== "rgba(0, 0, 0, 0)" && color !== "transparent") return color;
      node = node.parentElement;
    }
    return getComputedStyle(document.body).backgroundColor;
  };

  return {
    menuFound: true,
    drawerOpen: !!closeButton,
    sessionsFound: !!sessionsButton,
    linksFound: !!linksButton,
    sessionsColor: sessionsButton ? getComputedStyle(sessionsButton).color : null,
    sessionsFontSize: sessionsButton ? getComputedStyle(sessionsButton).fontSize : null,
    sessionsBackground: bg(sessionsButton),
    linksColor: linksButton ? getComputedStyle(linksButton).color : null
  };
})()
')"

SOURCE_HAS_LINKS=0
SOURCE_HAS_SESSIONS=0
SOURCE_HAS_TAB_STYLE=0

rg -Fq '"Links"' "$APP_TSX" && SOURCE_HAS_LINKS=1
rg -Fq '"Sessions"' "$APP_TSX" && SOURCE_HAS_SESSIONS=1
rg -Fq "const tabStyle =" "$APP_TSX" && SOURCE_HAS_TAB_STYLE=1

BUG_PRESENT="$(printf '%s\n' "$MEASURED" | jq '
  (.menuFound == true) and
  (.drawerOpen == true) and
  (.sessionsFound == true) and
  (.linksFound == true) and
  (.sessionsColor == "rgb(102, 102, 102)") and
  (.sessionsFontSize == "12px") and
  ((.sessionsBackground == "rgb(10, 14, 20)") or (.sessionsBackground == "rgb(13, 17, 23)"))
')"

if [ "$BUG_PRESENT" = "true" ] && \
   [ "$SOURCE_HAS_LINKS" -eq 1 ] && \
   [ "$SOURCE_HAS_SESSIONS" -eq 1 ] && \
   [ "$SOURCE_HAS_TAB_STYLE" -eq 1 ]; then
  echo "BUG PRESENT: inactive Sessions drawer tab still renders as low-contrast 12px gray text"
  exit 0
fi

echo "BUG ABSENT: measured=$MEASURED source_flags=links:$SOURCE_HAS_LINKS sessions:$SOURCE_HAS_SESSIONS tabStyle:$SOURCE_HAS_TAB_STYLE"
exit 1
