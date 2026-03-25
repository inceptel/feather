# Bug: Session drawer lacks navigation landmark

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`).
2. Tap the hamburger button to open the session drawer.
3. Inspect the open drawer in Chromium DevTools or query the DOM with `document.querySelectorAll('nav,[role="navigation"]')`.

## Expected behavior
The open session drawer should expose the app's primary session navigation with a `<nav>` element or `role="navigation"` so assistive technology can identify and jump to it.

## Actual behavior
The drawer shows the full session list visually, but the DOM contains no `nav` element and no node with `role="navigation"` while the drawer is open (`navCount: 0`). Screen-reader users get an unlabeled cluster of buttons and session rows instead of a navigable landmark.

## Screenshots
- menu-open-iter.png
- drawer-nav-evidence.json

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (`agent-browser`)
- URL: `http://localhost:3304/`
