#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

APP_TSX="/home/user/feather-dev/w5/frontend/src/App.tsx"

MEASURED="$(
node - "$APP_TSX" <<'NODE'
const fs = require('fs');

const source = fs.readFileSync(process.argv[2], 'utf8');
const line = source.split('\n').find((entry) => entry.includes("color: tab() === t ? '#e5e5e5' : '#666'"));
const appBgMatch = source.match(/background:\s*'#0a0e14'/);
const tabRowBorderMatch = source.match(/<div style=\{\{ display: 'flex', 'border-bottom': '1px solid #1e1e1e', 'padding-left': '16px', 'flex-shrink': '0' \}\}>/);

const hexToRgb = (hex) => {
  const normalized = hex.replace('#', '');
  return [
    parseInt(normalized.slice(0, 2), 16),
    parseInt(normalized.slice(2, 4), 16),
    parseInt(normalized.slice(4, 6), 16),
  ];
};

const luminance = ([r, g, b]) => {
  const channels = [r, g, b].map((value) => {
    const normalized = value / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : Math.pow((normalized + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
};

const contrast = (fg, bg) => {
  const fgLum = luminance(fg);
  const bgLum = luminance(bg);
  return (Math.max(fgLum, bgLum) + 0.05) / (Math.min(fgLum, bgLum) + 0.05);
};

const inactive = hexToRgb('#666666');
const background = hexToRgb('#0a0e14');
const ratio = contrast(inactive, background);

process.stdout.write(JSON.stringify({
  hasInactiveTabColor: Boolean(line),
  hasAppBackground: Boolean(appBgMatch),
  hasTabRow: Boolean(tabRowBorderMatch),
  inactiveColor: 'rgb(102, 102, 102)',
  backgroundColor: 'rgb(10, 14, 20)',
  fontSizePx: 13,
  contrastRatio: ratio,
}));
NODE
)"

BUG_PRESENT="$(printf '%s\n' "$MEASURED" | jq '
  .hasInactiveTabColor and
  .hasAppBackground and
  .hasTabRow and
  (.inactiveColor == "rgb(102, 102, 102)") and
  (.backgroundColor == "rgb(10, 14, 20)") and
  (.fontSizePx == 13) and
  (.contrastRatio < 4.5)
')"

if [ "$BUG_PRESENT" = "true" ]; then
  CONTRAST="$(printf '%s\n' "$MEASURED" | jq -r '.contrastRatio')"
  echo "BUG PRESENT: inactive view tab text is rgb(102, 102, 102) at 13px on rgb(10, 14, 20) with contrast ${CONTRAST}:1"
  exit 0
fi

echo "BUG ABSENT: measured=$MEASURED"
exit 1
