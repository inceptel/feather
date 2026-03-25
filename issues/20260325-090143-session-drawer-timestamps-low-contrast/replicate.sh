#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
APP_TSX="/home/user/feather-dev/w5/frontend/src/App.tsx"

LIVE_MEASURED="$(
S="replicate-session-drawer-contrast-$$"
cleanup() {
  agent-browser --session-name "$S" close >/dev/null 2>&1 || true
}
trap cleanup EXIT

agent-browser --session-name "$S" set viewport 390 844 >/dev/null
agent-browser --session-name "$S" open "http://localhost:$PORT/" >/dev/null
agent-browser --session-name "$S" wait --load networkidle >/dev/null
agent-browser --session-name "$S" wait 2000 >/dev/null
agent-browser --session-name "$S" eval '(() => {
  const menuButton = [...document.querySelectorAll("button")].find((el) => (el.textContent || "").trim() === "☰");
  if (menuButton) menuButton.click();
  return true;
})()' >/dev/null
agent-browser --session-name "$S" wait 1000 >/dev/null
agent-browser --session-name "$S" eval '(() => {
  const timePattern = /^(now|\d+m|\d+h|\d+d)$/;
  const hits = [...document.querySelectorAll("span")]
    .map((el) => {
      const text = (el.textContent || "").trim();
      if (!timePattern.test(text)) return null;
      const cs = getComputedStyle(el);
      return { text, color: cs.color, fontSize: cs.fontSize };
    })
    .filter(Boolean);
  return JSON.stringify({
    count: hits.length,
    samples: hits.slice(0, 5),
  });
})()'
)"

MEASURED="$(
printf '%s\n' "$LIVE_MEASURED" | node -e '
const fs = require("fs");
const raw = fs.readFileSync(0, "utf8").trim();
const parsed = JSON.parse(raw);
const live = typeof parsed === "string" ? JSON.parse(parsed) : parsed;
const fg = [85, 85, 85];
const bg = [13, 17, 23];
const luminance = ([r, g, b]) => {
  const channels = [r, g, b].map((v) => {
    const n = v / 255;
    return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
};
const contrast = (Math.max(luminance(fg), luminance(bg)) + 0.05) / (Math.min(luminance(fg), luminance(bg)) + 0.05);
const matches = live.samples.filter((sample) => sample.color === "rgb(85, 85, 85)" && sample.fontSize === "11px");
process.stdout.write(JSON.stringify({
  count: live.count,
  sample: live.samples[0] || null,
  matchedSamples: matches.length,
  color: "rgb(85, 85, 85)",
  background: "rgb(13, 17, 23)",
  contrast,
}));
'
)"

SOURCE_DRAWER_BG=0
SOURCE_TIMESTAMP_STYLE=0
SOURCE_TIME_AGO=0

rg -Fq "background: '#0d1117'" "$APP_TSX" && SOURCE_DRAWER_BG=1
rg -Fq "<span style={{ 'font-size': '11px', color: '#555' }}>{timeAgo(s.updatedAt)}</span>" "$APP_TSX" && SOURCE_TIMESTAMP_STYLE=1
rg -Fq "if (m < 1) return 'now'" "$APP_TSX" && SOURCE_TIME_AGO=1

BUG_PRESENT="$(printf '%s\n' "$MEASURED" | jq '
  (.count > 0) and
  (.matchedSamples > 0) and
  (.color == "rgb(85, 85, 85)") and
  (.background == "rgb(13, 17, 23)") and
  (.contrast < 4.5)
')"

if [ "$BUG_PRESENT" = "true" ] && [ "$SOURCE_DRAWER_BG" -eq 1 ] && [ "$SOURCE_TIMESTAMP_STYLE" -eq 1 ] && [ "$SOURCE_TIME_AGO" -eq 1 ]; then
  CONTRAST="$(printf '%s\n' "$MEASURED" | jq -r '.contrast')"
  echo "BUG PRESENT: drawer timestamps render at contrast ${CONTRAST}:1 using rgb(85, 85, 85) on rgb(13, 17, 23)"
  exit 0
fi

echo "BUG ABSENT: live=$LIVE_MEASURED measured=$MEASURED source_flags=bg:$SOURCE_DRAWER_BG style:$SOURCE_TIMESTAMP_STYLE timeAgo:$SOURCE_TIME_AGO"
exit 1
