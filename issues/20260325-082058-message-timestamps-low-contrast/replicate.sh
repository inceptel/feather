#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
MESSAGE_VIEW_TSX="/home/user/feather-dev/w5/frontend/src/components/MessageView.tsx"
INDEX_HTML="/home/user/feather-dev/w5/frontend/index.html"

MEASURED="$(node - <<'NODE'
const fg = [68, 68, 68];
const bg = [10, 14, 20];
const luminance = ([r, g, b]) => {
  const channels = [r, g, b].map((v) => {
    const n = v / 255;
    return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
};
const contrast = (Math.max(luminance(fg), luminance(bg)) + 0.05) / (Math.min(luminance(fg), luminance(bg)) + 0.05);
process.stdout.write(JSON.stringify({
  color: 'rgb(68, 68, 68)',
  background: 'rgb(10, 14, 20)',
  contrast,
}));
NODE
)"

SOURCE_COLOR_PRESENT=0
SOURCE_FONT_PRESENT=0
SOURCE_FORMAT_PRESENT=0
SOURCE_BACKGROUND_PRESENT=0

rg -Fq "color: '#444'" "$MESSAGE_VIEW_TSX" && SOURCE_COLOR_PRESENT=1
rg -Fq "'font-size': '10px'" "$MESSAGE_VIEW_TSX" && SOURCE_FONT_PRESENT=1
rg -Fq "{formatTime(msg.timestamp)}" "$MESSAGE_VIEW_TSX" && SOURCE_FORMAT_PRESENT=1
rg -Fq "body { background: #0a0e14;" "$INDEX_HTML" && SOURCE_BACKGROUND_PRESENT=1

BUG_PRESENT="$(printf '%s\n' "$MEASURED" | jq '
  (.color == "rgb(68, 68, 68)") and
  (.background == "rgb(10, 14, 20)") and
  (.contrast != null) and
  (.contrast < 4.5)
')"

if [ "$BUG_PRESENT" = "true" ] && [ "$SOURCE_COLOR_PRESENT" -eq 1 ] && [ "$SOURCE_FONT_PRESENT" -eq 1 ] && [ "$SOURCE_FORMAT_PRESENT" -eq 1 ] && [ "$SOURCE_BACKGROUND_PRESENT" -eq 1 ]; then
  CONTRAST="$(printf '%s\n' "$MEASURED" | jq -r '.contrast')"
  echo "BUG PRESENT: timestamp metadata renders at contrast ${CONTRAST}:1 using rgb(68, 68, 68) on rgb(10, 14, 20)"
  exit 0
fi

echo "BUG ABSENT: measured=$MEASURED source_flags=color:$SOURCE_COLOR_PRESENT font:$SOURCE_FONT_PRESENT format:$SOURCE_FORMAT_PRESENT bg:$SOURCE_BACKGROUND_PRESENT"
exit 1
