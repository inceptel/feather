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
  const clickByText = (text) => {
    const button = [...document.querySelectorAll("button")].find((el) => (el.textContent || "").trim() === text);
    if (button) button.click();
    return !!button;
  };

  clickByText("☰");

  const linksButton = [...document.querySelectorAll("button")].find((el) => (el.textContent || "").trim() === "Links");
  if (!linksButton) {
    return { drawerOpened: true, linksTabFound: false, helperFound: false };
  }

  linksButton.click();

  const helperText = "No quick links yet. Use /feather add link to add some.";
  const helper = [...document.querySelectorAll("div, p, span")].find((el) => (el.textContent || "").trim() === helperText);
  if (!helper) {
    return { drawerOpened: true, linksTabFound: true, helperFound: false };
  }

  const parseRgb = (value) => {
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

  const fgColor = getComputedStyle(helper).color;
  let bgNode = helper;
  let bgColor = null;
  while (bgNode) {
    const candidate = getComputedStyle(bgNode).backgroundColor;
    if (candidate && candidate !== "rgba(0, 0, 0, 0)" && candidate !== "transparent") {
      bgColor = candidate;
      break;
    }
    bgNode = bgNode.parentElement;
  }
  if (!bgColor) bgColor = getComputedStyle(document.body).backgroundColor;

  const fg = parseRgb(fgColor);
  const bg = parseRgb(bgColor);
  const contrast = fg && bg
    ? (Math.max(luminance(fg), luminance(bg)) + 0.05) / (Math.min(luminance(fg), luminance(bg)) + 0.05)
    : null;

  return {
    drawerOpened: true,
    linksTabFound: true,
    helperFound: true,
    color: fgColor,
    background: bgColor,
    contrast,
  };
})()
')" || {
  echo "BUG ABSENT: failed to inspect drawer state"
  exit 1
}

SOURCE_LINKS_PRESENT=0
SOURCE_HELPER_COPY_PRESENT=0
SOURCE_LOW_CONTRAST_COLOR_PRESENT=0
SOURCE_DRAWER_BG_PRESENT=0

rg -Fq "'Links'" "$APP_TSX" && SOURCE_LINKS_PRESENT=1
rg -Fq "No quick links yet. Use /feather add link to add some." "$APP_TSX" && SOURCE_HELPER_COPY_PRESENT=1
rg -Fq "#555" "$APP_TSX" && SOURCE_LOW_CONTRAST_COLOR_PRESENT=1
rg -Fq "#0d1117" "$APP_TSX" && SOURCE_DRAWER_BG_PRESENT=1

BUG_PRESENT="$(printf '%s\n' "$MEASURED" | jq '
  (.linksTabFound == true) and
  (.helperFound == true) and
  (.contrast != null) and
  (.contrast < 4.5) and
  (.color == "rgb(85, 85, 85)") and
  (.background == "rgb(13, 17, 23)")
')"

if [ "$BUG_PRESENT" = "true" ] && [ "$SOURCE_LINKS_PRESENT" -eq 1 ] && [ "$SOURCE_HELPER_COPY_PRESENT" -eq 1 ] && [ "$SOURCE_LOW_CONTRAST_COLOR_PRESENT" -eq 1 ] && [ "$SOURCE_DRAWER_BG_PRESENT" -eq 1 ]; then
  CONTRAST="$(printf '%s\n' "$MEASURED" | jq -r '.contrast')"
  echo "BUG PRESENT: links empty-state helper text renders at contrast ${CONTRAST}:1 using rgb(85, 85, 85) on rgb(13, 17, 23)"
  exit 0
fi

echo "BUG ABSENT: measured=$MEASURED source_flags=links:$SOURCE_LINKS_PRESENT copy:$SOURCE_HELPER_COPY_PRESENT low_contrast:$SOURCE_LOW_CONTRAST_COLOR_PRESENT bg:$SOURCE_DRAWER_BG_PRESENT"
exit 1
