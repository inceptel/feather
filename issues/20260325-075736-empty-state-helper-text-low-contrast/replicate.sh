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

measure_contrast() {
  agent-browser --session-name "$S" eval '
(() => {
  const text = "Open a session or create a new one";
  const helper = [...document.querySelectorAll("div")].find((el) => (el.textContent || "").trim() === text);
  if (!helper) {
    return { found: false };
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
  let bgNode = helper.parentElement;
  while (bgNode) {
    const bg = getComputedStyle(bgNode).backgroundColor;
    if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") {
      break;
    }
    bgNode = bgNode.parentElement;
  }

  const bgColor = bgNode
    ? getComputedStyle(bgNode).backgroundColor
    : getComputedStyle(document.body).backgroundColor;

  const fg = parseRgb(fgColor);
  const bg = parseRgb(bgColor);
  if (!fg || !bg) {
    return { found: true, color: fgColor, background: bgColor, contrast: null };
  }

  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const contrast = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  return { found: true, color: fgColor, background: bgColor, contrast };
})()
'
}

MEASURED="$(measure_contrast)" || {
  echo "BUG ABSENT: contrast measurement failed"
  exit 1
}

if [ "$(printf '%s\n' "$MEASURED" | jq -r '.found')" != "true" ]; then
  agent-browser --session-name "$S" wait 1500 >/dev/null
  MEASURED="$(measure_contrast)" || {
    echo "BUG ABSENT: contrast re-measurement failed"
    exit 1
  }
fi

TEXT_COLOR_PRESENT=0
BACKGROUND_PRESENT=0
TEXT_COPY_PRESENT=0

rg -Fq "color: '#444'" "$APP_TSX" && TEXT_COLOR_PRESENT=1
rg -Fq "background: '#0a0e14'" "$APP_TSX" && BACKGROUND_PRESENT=1
rg -Fq "Open a session or create a new one" "$APP_TSX" && TEXT_COPY_PRESENT=1

BUG_PRESENT="$(printf '%s\n' "$MEASURED" | jq '
  .found == true and
  (.contrast != null) and
  (.contrast < 4.5) and
  (.color == "rgb(68, 68, 68)") and
  (.background == "rgb(10, 14, 20)")
')"

if [ "$BUG_PRESENT" = "true" ] && [ "$TEXT_COLOR_PRESENT" -eq 1 ] && [ "$BACKGROUND_PRESENT" -eq 1 ] && [ "$TEXT_COPY_PRESENT" -eq 1 ]; then
  CONTRAST="$(printf '%s\n' "$MEASURED" | jq -r '.contrast')"
  echo "BUG PRESENT: helper text renders at contrast ${CONTRAST}:1 using rgb(68, 68, 68) on rgb(10, 14, 20)"
  exit 0
fi

echo "BUG ABSENT: measured=$MEASURED source_flags=text:$TEXT_COLOR_PRESENT bg:$BACKGROUND_PRESENT copy:$TEXT_COPY_PRESENT"
exit 1
