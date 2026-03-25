# Bug: Mobile drawer close button touch target is too small

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` on a mobile viewport (`390x844`).
2. Tap the hamburger button to open the session drawer.
3. Try to dismiss the drawer using the `×` button in the top-right corner.

## Expected behavior
The drawer close control should provide at least a 44x44 touch target so it is easy to hit on a phone.

## Actual behavior
The visible close button measures only about `11.7x23` CSS pixels in the rendered mobile layout, making the dismiss target much smaller than standard mobile guidance.

## Screenshots
- pty-after-click.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (`agent-browser`)
- Verification: measured with `getBoundingClientRect()` after opening the drawer
