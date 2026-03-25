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

agent-browser --session-name "$S" eval '
(() => {
  if (document.querySelector("button[aria-label=\"Close session drawer\"]")) return "already-open";
  const hamburger = [...document.querySelectorAll("button")]
    .find((button) => (button.textContent || "").trim() === "☰");
  if (!hamburger) return "missing";
  hamburger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  return "clicked";
})()
' >/dev/null

agent-browser --session-name "$S" wait 1000 >/dev/null

MEASURED="$(
agent-browser --session-name "$S" eval '
(() => {
  const parseRgb = (value) => {
    if (!value) return null;
    const m = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };

  const luminance = ([r, g, b]) => {
    const channels = [r, g, b].map((v) => {
      const n = v / 255;
      return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };

  const effectiveBackground = (node) => {
    let current = node;
    while (current) {
      const color = getComputedStyle(current).backgroundColor;
      if (color && color !== "rgba(0, 0, 0, 0)" && color !== "transparent") return color;
      current = current.parentElement;
    }
    return getComputedStyle(document.body).backgroundColor;
  };

  const closeButton = document.querySelector("button[aria-label=\"Close session drawer\"]");
  if (!closeButton) return JSON.stringify({ drawerOpen: false, found: false });

  const style = getComputedStyle(closeButton);
  const background = effectiveBackground(closeButton);
  const fg = parseRgb(style.color);
  const bg = parseRgb(background);
  const contrast = fg && bg
    ? (Math.max(luminance(fg), luminance(bg)) + 0.05) / (Math.min(luminance(fg), luminance(bg)) + 0.05)
    : null;

  return JSON.stringify({
    drawerOpen: true,
    found: true,
    text: (closeButton.textContent || "").trim(),
    ariaLabel: closeButton.getAttribute("aria-label"),
    width: style.width,
    height: style.height,
    color: style.color,
    background,
    contrast
  });
})()
'
)"

MEASURED="$(printf '%s\n' "$MEASURED" | jq -c 'fromjson? // .')"

SOURCE_ARIA=0
SOURCE_COLOR=0
SOURCE_BG=0

rg -Fq 'aria-label="Close session drawer"' "$APP_TSX" && SOURCE_ARIA=1
rg -Fq "color: '#666'" "$APP_TSX" && SOURCE_COLOR=1
rg -Fq "background: '#0d1117'" "$APP_TSX" && SOURCE_BG=1

BUG_PRESENT="$(printf '%s\n' "$MEASURED" | jq '
  .drawerOpen == true and
  .found == true and
  .ariaLabel == "Close session drawer" and
  .text == "×" and
  .width == "44px" and
  .height == "44px" and
  .color == "rgb(102, 102, 102)" and
  .background == "rgb(13, 17, 23)" and
  (.contrast != null) and
  (.contrast < 4.5)
')"

if [ "$BUG_PRESENT" = "true" ] && [ "$SOURCE_ARIA" -eq 1 ] && [ "$SOURCE_COLOR" -eq 1 ] && [ "$SOURCE_BG" -eq 1 ]; then
  CONTRAST="$(printf '%s\n' "$MEASURED" | jq -r '.contrast')"
  echo "BUG PRESENT: drawer close icon renders at contrast ${CONTRAST}:1 using rgb(102, 102, 102) on rgb(13, 17, 23)"
  exit 0
fi

echo "BUG ABSENT: measured=$MEASURED source_flags=aria:$SOURCE_ARIA color:$SOURCE_COLOR bg:$SOURCE_BG"
exit 1
