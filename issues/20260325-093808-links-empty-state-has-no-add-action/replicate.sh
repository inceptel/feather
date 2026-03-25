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
  const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
  const buttons = [...document.querySelectorAll("button")];
  const labels = buttons.map((button) => normalize(button.textContent));
  const drawerButton = buttons.find((button) => normalize(button.textContent) === "☰");
  const drawerAlreadyOpen = labels.includes("+ New Claude") || labels.includes("×");
  const hasNewClaude = labels.includes("+ New Claude");

  if (!drawerButton && !drawerAlreadyOpen) {
    return { drawerButtonFound: false, drawerAlreadyOpen: false, hasNewClaude, linksButtonFound: false, helperFound: false, addActionFound: false, buttonLabels: labels };
  }

  if (drawerButton) {
    drawerButton.click();
  }

  const openButtons = [...document.querySelectorAll("button, a, [role=\"button\"]")];
  const openLabels = openButtons.map((node) => normalize(node.textContent || node.getAttribute("aria-label") || ""));
  const linksButton = openButtons.find((node) => normalize(node.textContent) === "Links");
  if (!linksButton) {
    return {
      drawerButtonFound: !!drawerButton,
      drawerAlreadyOpen,
      hasNewClaude: openLabels.includes("+ New Claude"),
      linksButtonFound: false,
      helperFound: false,
      addActionFound: false,
      buttonLabels: openLabels,
    };
  }

  linksButton.click();

  const helperText = "No quick links yet. Use /feather add link to add some.";
  const helperFound = normalize(document.body.innerText).includes(helperText);
  const actionableNodes = [...document.querySelectorAll("button, a, [role=\"button\"], input, textarea, select")];
  const addActionFound = actionableNodes.some((node) => {
    if (node === linksButton) return false;
    const text = normalize(node.textContent || node.getAttribute("aria-label") || node.getAttribute("title") || node.getAttribute("placeholder") || "");
    if (!text) return false;
    if (text === "Sessions" || text === "Links" || text === "Close session drawer" || text === "×" || text === "+ New Claude") {
      return false;
    }
    return /(add|new link|create link|quick link)/i.test(text);
  });

  return {
    drawerButtonFound: !!drawerButton,
    drawerAlreadyOpen,
    hasNewClaude: openLabels.includes("+ New Claude"),
    linksButtonFound: true,
    helperFound,
    addActionFound,
    buttonLabels: openLabels,
  };
})()
')"

SOURCE_HAS_LINKS=0
SOURCE_HAS_HELPER_COPY=0
SOURCE_HAS_ADD_LINK_UI=0

rg -Fq '"Links"' "$APP_TSX" && SOURCE_HAS_LINKS=1
rg -Fq 'No quick links yet. Use /feather add link to add some.' "$APP_TSX" && SOURCE_HAS_HELPER_COPY=1
rg -i -e 'add link|quick link|Links' "$APP_TSX" >/dev/null && SOURCE_HAS_ADD_LINK_UI=1

BUG_PRESENT="$(printf '%s\n' "$MEASURED" | jq '
  (.drawerButtonFound == true) and
  ((.drawerButtonFound == true) or (.drawerAlreadyOpen == true)) and
  (.hasNewClaude == true) and
  (
    (.linksButtonFound == false) or
    ((.linksButtonFound == true) and (.helperFound == true) and (.addActionFound == false))
  )
')"

if [ "$BUG_PRESENT" = "true" ]; then
  echo "BUG PRESENT: measured=$MEASURED source_flags=links:$SOURCE_HAS_LINKS helper:$SOURCE_HAS_HELPER_COPY add_ui:$SOURCE_HAS_ADD_LINK_UI"
  exit 0
fi

echo "BUG ABSENT: measured=$MEASURED source_flags=links:$SOURCE_HAS_LINKS helper:$SOURCE_HAS_HELPER_COPY add_ui:$SOURCE_HAS_ADD_LINK_UI"
exit 1
