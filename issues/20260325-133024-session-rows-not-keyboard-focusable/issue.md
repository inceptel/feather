# Bug: Session rows in mobile drawer are not keyboard focusable

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`).
2. Open the session drawer with the hamburger button.
3. Connect a hardware keyboard or use browser keyboard navigation.
4. Press `Tab` through the visible controls in the drawer.

## Expected behavior
Each visible session row should be a focusable interactive control so keyboard users can move to a specific session and activate it.

## Actual behavior
The drawer exposes only the close button, the `Sessions` and `Links` tabs, and `+ New Claude` as focusable controls. The visible session titles render as plain text inside non-focusable `div` rows, so keyboard focus skips from the drawer controls to the drawer scroll container/body instead of landing on individual sessions.

## Evidence
- DOM inspection in mobile Chromium showed the visible session titles as `SPAN` text nodes, while the only focusable elements in the drawer were four `BUTTON`s (`×`, `Sessions`, `Links`, `+ New Claude`).
- Repeated `Tab` presses moved focus from those buttons to a generic drawer `DIV`/`BODY`, never to an individual session row.

## Screenshots
- session-rows-keyboard.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (Selenium mobile emulation)
