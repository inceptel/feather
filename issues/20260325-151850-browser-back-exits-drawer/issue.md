# Bug: Browser Back exits Feather instead of closing the mobile session drawer

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`).
2. Tap the hamburger button to open the session drawer.
3. Press the browser Back button.

## Expected behavior
Back should dismiss the open drawer and keep the user in Feather on `http://localhost:3304/`.

## Actual behavior
Back does not close the drawer. Chromium navigates away from Feather to `data:,`, leaving a blank page.

## Evidence
- `back-drawer-evidence.json` shows the app stayed at `http://localhost:3304/` after opening the drawer, then moved to `data:,` immediately after Back.

## Screenshots
- `back-drawer-before.png`
- `back-drawer-open.png`
- `back-drawer-after-back.png`

## Environment
- Viewport: `390x844` (mobile)
- Browser: Chromium via Selenium mobile emulation
- URL: `http://localhost:3304/`
