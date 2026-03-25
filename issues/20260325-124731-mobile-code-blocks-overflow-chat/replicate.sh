#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
SESSION_ID="370e2f60-1399-4ebf-a182-7a8ba6c59ccf"
MESSAGE_PREFIX="There it is! w5 found it:"
MESSAGE_VIEW_TSX="/home/user/feather-dev/w5/frontend/src/components/MessageView.tsx"

SOURCE_MATCH=0
if rg -Fq ".markdown pre { margin: 8px 0; border-radius: 6px; overflow-x: auto; background: #0d1117; padding: 10px 12px; }" "$MESSAGE_VIEW_TSX" && \
   rg -Fq ".markdown pre code { background: none; padding: 0; font-size: 0.85em; color: #c9d1d9; }" "$MESSAGE_VIEW_TSX" && \
   rg -Fq ".markdown { line-height: 1.55; word-break: break-word; }" "$MESSAGE_VIEW_TSX"; then
  SOURCE_MATCH=1
fi

if [ "$SOURCE_MATCH" -ne 1 ]; then
  echo "BUG ABSENT: expected markdown code-block overflow styling is not present in source"
  exit 1
fi

python3 - "$PORT" "$SESSION_ID" "$MESSAGE_PREFIX" <<'PY'
import json
import sys
from playwright.sync_api import sync_playwright

port, session_id, message_prefix = sys.argv[1:4]
url = f"http://127.0.0.1:{port}/#{session_id}"

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, executable_path="/usr/bin/google-chrome")
    page = browser.new_page(viewport={"width": 390, "height": 844}, is_mobile=True)
    page.goto(url, wait_until="load", timeout=30000)
    page.wait_for_timeout(3000)

    target = page.locator(".markdown").filter(has_text=message_prefix).first
    if target.count() == 0:
        browser.close()
        print("BUG ABSENT: target markdown message was not rendered")
        raise SystemExit(1)

    target.scroll_into_view_if_needed(timeout=5000)
    page.wait_for_timeout(500)

    result = target.evaluate(
        """(node) => {
          const pre = node.querySelector('pre');
          const code = node.querySelector('pre code');
          if (!pre || !code) {
            return { found: true, hasPre: Boolean(pre), hasCode: Boolean(code), bugPresent: false };
          }

          const bubble = node.closest('[style*="max-width"]') || node.parentElement;
          const preRect = pre.getBoundingClientRect();
          const codeRect = code.getBoundingClientRect();
          const bubbleRect = bubble ? bubble.getBoundingClientRect() : null;
          const preStyle = getComputedStyle(pre);
          const codeStyle = getComputedStyle(code);

          return {
            found: true,
            preClientWidth: pre.clientWidth,
            preScrollWidth: pre.scrollWidth,
            preWidth: Math.round(preRect.width),
            codeWidth: Math.round(codeRect.width),
            bubbleWidth: bubbleRect ? Math.round(bubbleRect.width) : null,
            preOverflowX: preStyle.overflowX,
            codeWhiteSpace: codeStyle.whiteSpace,
            bugPresent: Boolean(
              pre.scrollWidth > pre.clientWidth + 100 &&
              codeRect.width > preRect.width + 100 &&
              preStyle.overflowX === 'auto' &&
              codeStyle.whiteSpace === 'pre' &&
              bubbleRect &&
              codeRect.width > bubbleRect.width + 100
            ),
          };
        }"""
    )
    browser.close()

print(json.dumps(result))

if result.get("bugPresent"):
    print(
        "BUG PRESENT: markdown code block expands beyond the mobile chat bubble "
        f"(pre {result['preWidth']}px / scrollWidth {result['preScrollWidth']}px, "
        f"code {result['codeWidth']}px, bubble {result['bubbleWidth']}px)"
    )
    raise SystemExit(0)

print("BUG ABSENT")
raise SystemExit(1)
PY
