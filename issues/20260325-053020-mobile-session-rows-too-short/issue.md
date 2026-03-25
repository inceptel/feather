# Bug: Mobile session rows are too short for reliable tapping

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`)
2. Tap the hamburger menu to open the session drawer
3. Inspect any session row in the drawer

## Expected behavior
Session rows should provide at least a 44x44 CSS pixel touch target so browsing sessions is easy on mobile.

## Actual behavior
Each session row in the drawer is only about `39px` tall, below the common 44px mobile minimum.

I verified this in the live DOM with `getBoundingClientRect()` on the drawer buttons:
- `hello old friend`: `284x39`
- neighboring worker session rows: `284x39`

Because browsing sessions is one of the primary mobile actions, the undersized rows make selection harder than necessary, especially in a long, dense list.

## Screenshots
- `drawer-iter7c.png`

## Environment
- Viewport: `390x844` (mobile)
- Browser: Chromium (`agent-browser`)
