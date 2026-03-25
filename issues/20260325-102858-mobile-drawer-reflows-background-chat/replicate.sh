#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
APP_TSX="/home/user/feather-dev/w5/frontend/src/App.tsx"

SOURCE_MATCH=0
if rg -Fq "width: sidebar() ? '300px' : '0'" "$APP_TSX" && \
   rg -Fq "'min-width': sidebar() ? '300px' : '0'" "$APP_TSX" && \
   rg -Fq "<div style={{ flex: '1', display: 'flex', 'flex-direction': 'column', 'min-width': '0', height: '100%' }}" "$APP_TSX"; then
  SOURCE_MATCH=1
fi

if [ "$SOURCE_MATCH" -ne 1 ]; then
  echo "BUG ABSENT: expected flex-sibling drawer layout is not present in source"
  exit 1
fi

python3 - "$PORT" <<'PY'
import json
import sys
from playwright.sync_api import sync_playwright

port = sys.argv[1]
url = f"http://127.0.0.1:{port}/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf"

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, executable_path="/usr/bin/google-chrome")
    page = browser.new_page(viewport={"width": 390, "height": 844}, is_mobile=True)
    page.goto(url, wait_until="load", timeout=30000)
    page.wait_for_timeout(2500)
    page.get_by_role("button", name="☰").click(timeout=5000)
    page.wait_for_timeout(1000)

    result = page.evaluate(
        """() => {
          const all = [...document.querySelectorAll('*')]
          const main = all.find((el) => {
            const style = getComputedStyle(el)
            return style.flex === '1 1 0%' && style.minWidth === '0px' && style.flexDirection === 'column'
          })
          const sidebar = all.find((el) => getComputedStyle(el).zIndex === '40')
          const visibleNarrowText = [...document.querySelectorAll('span,div,p,pre,button')]
            .map((el) => {
              const rect = el.getBoundingClientRect()
              return {
                text: (el.textContent || '').trim(),
                left: Math.round(rect.left),
                top: Math.round(rect.top),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              }
            })
            .filter((entry) =>
              entry.text.length >= 12 &&
              entry.left >= 340 &&
              entry.width > 0 &&
              entry.width <= 7 &&
              entry.height >= 100 &&
              entry.top < window.innerHeight &&
              entry.top + entry.height > 0
            )
            .sort((a, b) => a.width - b.width || b.height - a.height)

          const mainRect = main ? main.getBoundingClientRect() : null
          const sidebarRect = sidebar ? sidebar.getBoundingClientRect() : null

          return {
            viewportWidth: window.innerWidth,
            mainLeft: mainRect ? Math.round(mainRect.left) : null,
            mainWidth: mainRect ? Math.round(mainRect.width) : null,
            sidebarWidth: sidebarRect ? Math.round(sidebarRect.width) : null,
            visibleNarrowText: visibleNarrowText.slice(0, 5),
            bugPresent: Boolean(
              mainRect &&
              sidebarRect &&
              window.innerWidth === 390 &&
              Math.round(sidebarRect.width) >= 300 &&
              Math.round(mainRect.left) >= 300 &&
              Math.round(mainRect.width) <= 90 &&
              visibleNarrowText.length > 0
            ),
          }
        }"""
    )
    browser.close()

print(json.dumps(result))

if result.get("bugPresent"):
    narrow = result["visibleNarrowText"][0]
    print(
        "BUG PRESENT: opening the mobile drawer leaves a "
        f"{result['mainWidth']}px chat strip and visible background text only "
        f"{narrow['width']}px wide at x={narrow['left']}"
    )
    raise SystemExit(0)

print("BUG ABSENT")
raise SystemExit(1)
PY
