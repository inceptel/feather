# Bug: Session drawer does not close on Escape

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`).
2. Tap the hamburger button to open the session drawer.
3. Press the `Escape` key.

## Expected behavior
The drawer should close when `Escape` is pressed, matching the behavior of dismissible overlays and dialogs.

## Actual behavior
The drawer stays open after `Escape`. The close button (`×`) and drawer content remain visible. In the same state, tapping the explicit close button dismisses the drawer normally.

## Screenshots
- drawer-escape-open.png
- drawer-escape-after-esc.png
- drawer-escape-after-click.png

## Additional evidence
- `drawer-escape-evidence.json` shows the drawer controls are still present after `Escape`, then disappear after clicking `×`.

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium via Selenium mobile emulation
