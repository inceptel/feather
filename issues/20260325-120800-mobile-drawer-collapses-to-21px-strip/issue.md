# Bug: Mobile session drawer collapses to a 21px strip

## Status
new

## Severity
high

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`).
2. Tap the hamburger menu in the top-left corner.
3. Observe the session drawer layout.

## Expected behavior
The drawer should open as a readable side sheet that uses a substantial portion of the viewport width, with session titles and the `+ New Claude` action fully visible.

## Actual behavior
The drawer opens as a narrow vertical strip on the left edge. In the attached screenshot the panel content is crushed into one-character columns, the `+ New Claude` button wraps vertically, and the main pane still occupies most of the viewport. A Selenium DOM measurement captured the drawer container at about `21.3px` wide on a `390px` viewport.

## Screenshots
- drawer-collapsed-mobile.png
- drawer-width-metrics.json

## Environment
- Viewport: `390x844` (mobile)
- Browser: Chromium via Selenium mobile emulation
- URL: `http://localhost:3304/`
