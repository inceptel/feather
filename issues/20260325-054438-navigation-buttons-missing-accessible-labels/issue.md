# Bug: Navigation buttons are announced only as symbols on mobile

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`) in Chromium.
2. Capture the accessibility snapshot on the landing screen.
3. Open the session drawer with the top-left navigation button.
4. Capture the accessibility snapshot again with the drawer open.

## Expected behavior
Primary navigation controls should expose descriptive accessible names such as `Open session list` and `Close session list` so screen-reader and voice-control users can identify them.

## Actual behavior
The landing screen exposes the menu control only as `☰`, and the drawer exposes the close control only as `×`. Those glyph-only names are ambiguous and do not describe the control's purpose.

## Evidence
- Landing accessibility snapshot: `- button "☰" [ref=e1]`
- Drawer accessibility snapshot: `- button "×" [ref=e1]`

## Screenshots
- landing-iter10.png
- drawer-clean10.png

## Environment
- Viewport: `390x844` (mobile)
- Browser: Chromium (`agent-browser`)
- URL: `http://localhost:3304/`
