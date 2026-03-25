# Bug: Session drawer does not move focus into the overlay

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`).
2. Tap the hamburger button (`☰`) to open the session drawer.
3. Inspect `document.activeElement` after the drawer is visible.

## Expected behavior
Keyboard focus should move into the drawer, typically to the close button or the first actionable control inside the overlay.

## Actual behavior
The drawer opens visually, but focus remains on `BODY` instead of moving into the overlay. The DOM check after opening returned `activeTag: "BODY"` while the drawer controls were visible.

## Screenshots
- menu-open.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
