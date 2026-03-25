# Bug: Drawer reopens on stale Links tab instead of sessions

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`).
2. Tap the hamburger button to open the drawer.
3. Tap `Links`.
4. Tap `×` to close the drawer.
5. Tap the hamburger button again to reopen the drawer.

## Expected behavior
Reopening the drawer from the landing screen should return the user to the primary `Sessions` view so the session list and `+ New Claude` action are immediately available again.

## Actual behavior
The drawer reopens on the stale `Links` pane. The session list stays hidden, the `+ New Claude` action is gone, and the user is dropped back into the empty `No quick links yet. Use /feather add link to add some.` state instead of the main session picker.

## Evidence
- Selenium mobile emulation on `390x844` reproduced this at `2026-03-25T14:13:37Z`.
- After closing the `Links` pane, the landing screen returned to the normal `☰ / Select a session` state.
- Reopening the drawer exposed only `×`, `Sessions`, and `Links`, with the `Links` empty-state copy still visible and no `+ New Claude` button or session rows.

## Screenshots
- links-before-close.png
- reopen-after-links.png

## Environment
- Viewport: `390x844` (mobile)
- Browser: Chromium (Selenium mobile emulation)
- URL: `http://localhost:3304/`
