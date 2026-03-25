#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
ISSUE_SLUG="20260325-133614-drawer-does-not-move-focus"

python3 - "$PORT" <<'PY'
import json
import sys
from playwright.sync_api import sync_playwright

port = sys.argv[1]

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path="/usr/bin/google-chrome")
    page = browser.new_page(viewport={"width": 390, "height": 844})
    page.goto(f"http://localhost:{port}/", wait_until="networkidle")
    page.wait_for_timeout(1500)

    page.get_by_role("button", name="☰").click()
    page.wait_for_timeout(500)

    probe = page.evaluate(
        """() => {
          const active = document.activeElement;
          const close = document.querySelector("button[aria-label='Close session drawer']");
          const newClaude = [...document.querySelectorAll("button")].find((el) =>
            (el.textContent || "").includes("New Claude")
          ) || null;
          const drawer = close?.closest("div");
          return {
            activeTag: active ? active.tagName : null,
            activeAria: active && active.getAttribute ? active.getAttribute("aria-label") : null,
            activeText: (active && active.textContent ? active.textContent : "").trim().slice(0, 120),
            bodyIsActive: active === document.body,
            closePresent: Boolean(close),
            closeFocused: active === close,
            newClaudeFocused: active === newClaude,
            drawerWidth: drawer ? Math.round(drawer.getBoundingClientRect().width) : 0
          };
        }"""
    )
    browser.close()

print(json.dumps(probe))

if probe["closePresent"] and probe["drawerWidth"] >= 280 and probe["bodyIsActive"]:
    print("BUG PRESENT: session drawer opens but focus remains on BODY instead of moving into the overlay.")
    sys.exit(0)

print("BUG ABSENT: focus moved into the drawer or the drawer did not open as expected.")
sys.exit(1)
PY
