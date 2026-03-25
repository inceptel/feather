#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
SESSION_ID="7a004500-bb31-4cef-bf78-50ec21b8cefc"
NODE_PATH="${NODE_PATH:-/home/user/feather/node_modules}"
APP_TSX="/home/user/feather-dev/w5/frontend/src/App.tsx"

SOURCE_FLAGS="$(
node - "$APP_TSX" <<'NODE'
const fs = require('fs');

const source = fs.readFileSync(process.argv[2], 'utf8');
const hasPlaceholder = source.includes('placeholder="Send a message..."');
const hasComposerBg = source.includes("background: '#1a1a2e'");
const hasComposerFontSize = source.includes("'font-size': '15px'");

process.stdout.write(JSON.stringify({
  hasPlaceholder,
  hasComposerBg,
  hasComposerFontSize,
}));
NODE
)"

MEASURED="$(
PORT="$PORT" NODE_PATH="$NODE_PATH" node - <<'NODE'
const { chromium } = require('playwright');

const port = process.env.PORT;
const sessionId = '7a004500-bb31-4cef-bf78-50ec21b8cefc';

const parseRgb = (value) => {
  const match = value && value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
};

const luminance = ([r, g, b]) => {
  const channels = [r, g, b].map((component) => {
    const normalized = component / 255;
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

(async() => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

  try {
    await page.goto(`http://localhost:${port}/#${sessionId}`, { waitUntil: 'load', timeout: 10000 });
    await page.waitForTimeout(2000);

    const measured = await page.evaluate(({ parseRgbSource }) => {
      const parseRgb = eval(parseRgbSource); // eslint-disable-line no-eval
      const textarea = [...document.querySelectorAll('textarea')].find((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden';
      });

      if (!textarea) {
        return { found: false, url: location.href };
      }

      const placeholderStyle = getComputedStyle(textarea, '::placeholder');
      const textareaStyle = getComputedStyle(textarea);

      return {
        found: true,
        url: location.href,
        placeholder: textarea.getAttribute('placeholder') || '',
        placeholderColor: placeholderStyle.color,
        placeholderFontSize: placeholderStyle.fontSize,
        textareaBackground: textareaStyle.backgroundColor,
        textareaTextColor: textareaStyle.color,
        rect: {
          width: textarea.getBoundingClientRect().width,
          height: textarea.getBoundingClientRect().height,
        },
      };
    }, { parseRgbSource: parseRgb.toString() });

    if (measured.found) {
      const fg = parseRgb(measured.placeholderColor);
      const bg = parseRgb(measured.textareaBackground);
      measured.contrastRatio = fg && bg ? contrast(fg, bg) : null;
    }

    console.log(JSON.stringify(measured));
    await browser.close();
  } catch (error) {
    console.log(JSON.stringify({
      found: false,
      error: error && error.message ? error.message : String(error),
    }));
    await browser.close();
    process.exit(0);
  }
})();
NODE
)"

BUG_PRESENT="$(jq -n \
  --argjson source "$SOURCE_FLAGS" \
  --argjson measured "$MEASURED" '
  $source.hasPlaceholder and
  $source.hasComposerBg and
  $source.hasComposerFontSize and
  $measured.found and
  ($measured.placeholder == "Send a message...") and
  ($measured.placeholderColor == "rgb(117, 117, 117)") and
  ($measured.placeholderFontSize == "15px") and
  ($measured.textareaBackground == "rgb(26, 26, 46)") and
  ($measured.contrastRatio != null) and
  ($measured.contrastRatio < 4.5)
')"

if [ "$BUG_PRESENT" = "true" ]; then
  CONTRAST="$(printf '%s\n' "$MEASURED" | jq -r '.contrastRatio')"
  echo "BUG PRESENT: composer placeholder is rgb(117, 117, 117) at 15px on rgb(26, 26, 46) with contrast ${CONTRAST}:1"
  exit 0
fi

echo "BUG ABSENT: source=$SOURCE_FLAGS measured=$MEASURED"
exit 1
