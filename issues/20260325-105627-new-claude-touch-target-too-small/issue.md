# Bug: New Claude button touch target is too small on mobile

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile at `390x844`.
2. Tap the hamburger button to open the session drawer.
3. Inspect the `+ New Claude` button near the top of the drawer.

## Expected behavior
The primary create-session action should meet the 44x44 CSS pixel minimum touch target on mobile.

## Actual behavior
The `+ New Claude` button renders at about `267x36` CSS pixels, leaving the only visible create-session action in the mobile drawer undersized for touch.

## Screenshots
- new-claude-touch-target.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium via Playwright
