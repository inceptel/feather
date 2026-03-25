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

MEASURED="$(
agent-browser --session-name "$S" eval '
(() => {
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

  const candidates = [...document.querySelectorAll("span")]
    .map((el) => {
      const text = (el.textContent || "").trim();
      if (text !== "Select a session") return null;
      const cs = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return {
        text,
        color: cs.color,
        fontSize: cs.fontSize,
        rect: {
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height
        }
      };
    })
    .filter(Boolean);

  const header = candidates.find((item) => item.fontSize === "14px") || candidates[0] || null;
  if (!header) {
    return JSON.stringify({ found: false, candidates });
  }

  const bgColor = getComputedStyle(document.body).backgroundColor;
  const fg = parseRgb(header.color);
  const bg = parseRgb(bgColor);
  const contrast = fg && bg
    ? (Math.max(luminance(fg), luminance(bg)) + 0.05) / (Math.min(luminance(fg), luminance(bg)) + 0.05)
    : null;

  return JSON.stringify({
    found: true,
    header,
    background: bgColor,
    contrast,
    candidateCount: candidates.length
  });
})()
'
)"

MEASURED="$(printf '%s\n' "$MEASURED" | jq -c 'fromjson? // .')"

SOURCE_HEADER_STYLE=0
SOURCE_BG_STYLE=0
SOURCE_EMPTY_HELPER=0

rg -Fq "fallback={<span style={{ color: '#666', 'font-size': '14px' }}>Select a session</span>}" "$APP_TSX" && SOURCE_HEADER_STYLE=1
rg -Fq "background: '#0a0e14'" "$APP_TSX" && SOURCE_BG_STYLE=1
rg -Fq "Open a session or create a new one" "$APP_TSX" && SOURCE_EMPTY_HELPER=1

BUG_PRESENT="$(printf '%s\n' "$MEASURED" | jq '
  .found == true and
  .header.fontSize == "14px" and
  .header.color == "rgb(102, 102, 102)" and
  .background == "rgb(10, 14, 20)" and
  (.contrast != null) and
  (.contrast < 4.5)
')"

if [ "$BUG_PRESENT" = "true" ] && [ "$SOURCE_HEADER_STYLE" -eq 1 ] && [ "$SOURCE_BG_STYLE" -eq 1 ] && [ "$SOURCE_EMPTY_HELPER" -eq 1 ]; then
  CONTRAST="$(printf '%s\n' "$MEASURED" | jq -r '.contrast')"
  echo "BUG PRESENT: empty-state header renders at contrast ${CONTRAST}:1 using rgb(102, 102, 102) on rgb(10, 14, 20)"
  exit 0
fi

echo "BUG ABSENT: measured=$MEASURED source_flags=header:$SOURCE_HEADER_STYLE bg:$SOURCE_BG_STYLE helper:$SOURCE_EMPTY_HELPER"
exit 1
