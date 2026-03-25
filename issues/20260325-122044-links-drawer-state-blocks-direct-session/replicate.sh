#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
APP_TSX="/home/user/feather-dev/w5/frontend/src/App.tsx"
TARGET_ID="370e2f60-1399-4ebf-a182-7a8ba6c59ccf"
S="replicate-$$"

cleanup() {
  agent-browser --session-name "$S" close >/dev/null 2>&1 || true
}
trap cleanup EXIT

agent-browser --session-name "$S" set viewport 390 844 >/dev/null
agent-browser --session-name "$S" open "http://localhost:$PORT/" >/dev/null
agent-browser --session-name "$S" wait --load networkidle >/dev/null
agent-browser --session-name "$S" wait 2000 >/dev/null

PRE_STATE="$(agent-browser --session-name "$S" eval '
(() => {
  const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
  const buttonByText = (text) => [...document.querySelectorAll("button")].find((el) => normalize(el.textContent) === text) || null;
  const menuButton = buttonByText("☰");

  if (!menuButton) {
    return { menuFound: false, drawerOpen: false, linksFound: false, bodyText: normalize(document.body.innerText) };
  }

  menuButton.click();

  const closeButton = document.querySelector("button[aria-label=\"Close session drawer\"]");
  const linksButton = buttonByText("Links");

  if (linksButton) {
    linksButton.click();
  }

  return {
    menuFound: true,
    drawerOpen: !!closeButton,
    linksFound: !!linksButton,
    bodyText: normalize(document.body.innerText)
  };
})()
')"

SOURCE_HAS_LINKS=0
rg -Fq '"Links"' "$APP_TSX" && SOURCE_HAS_LINKS=1

if [ "$SOURCE_HAS_LINKS" -eq 0 ]; then
  echo "BUG ABSENT: current source no longer renders a Links drawer state"
  exit 1
fi

if ! printf '%s\n' "$PRE_STATE" | jq -e '.menuFound == true and .drawerOpen == true and .linksFound == true' >/dev/null; then
  echo "BUG ABSENT: current UI does not expose the reported Links drawer state precondition; pre_state=$PRE_STATE source_has_links=$SOURCE_HAS_LINKS"
  exit 1
fi

agent-browser --session-name "$S" eval "
(() => {
  location.hash = '#$TARGET_ID';
  return { hash: location.hash };
})()
" >/dev/null
agent-browser --session-name "$S" wait 500 >/dev/null

POST_STATE="$(agent-browser --session-name "$S" eval '
(() => {
  const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
  const bodyText = normalize(document.body.innerText);
  const closeButton = document.querySelector("button[aria-label=\"Close session drawer\"]");
  const linksButton = [...document.querySelectorAll("button")].find((el) => normalize(el.textContent) === "Links") || null;
  const chatButton = [...document.querySelectorAll("button")].find((el) => normalize(el.textContent) === "Chat") || null;
  const terminalButton = [...document.querySelectorAll("button")].find((el) => normalize(el.textContent) === "Terminal") || null;

  return {
    hash: location.hash.slice(1),
    drawerOpen: !!closeButton,
    linksVisible: !!linksButton,
    chatVisible: !!chatButton,
    terminalVisible: !!terminalButton,
    emptyHeadingVisible: bodyText.includes("Select a session"),
    emptyBodyVisible: bodyText.includes("Open a session or create a new one"),
    bodyText
  };
})()
')"

BUG_PRESENT="$(printf '%s\n' "$POST_STATE" | jq --arg target "$TARGET_ID" '
  (.hash == $target) and
  (.drawerOpen == true) and
  (.linksVisible == true) and
  (.emptyHeadingVisible == true) and
  (.emptyBodyVisible == true) and
  (.chatVisible == false) and
  (.terminalVisible == false)
')"

if [ "$BUG_PRESENT" = "true" ]; then
  echo "BUG PRESENT: direct hash navigation leaves the Links drawer and empty state in place"
  exit 0
fi

echo "BUG ABSENT: pre_state=$PRE_STATE post_state=$POST_STATE source_has_links=$SOURCE_HAS_LINKS"
exit 1
