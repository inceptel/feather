# Bug: Links drawer state blocks direct session navigation

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`).
2. Open the hamburger menu.
3. Switch the drawer to the `Links` tab.
4. Navigate directly to `http://localhost:3304/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf` in the same browser tab.

## Expected behavior
The requested session should load and replace the empty-state view, or the drawer should close so the deep-linked chat is visible.

## Actual behavior
The app keeps showing the open `Links` drawer and the empty-state `Select a session` pane even though the URL hash now points at a valid session. The requested chat stays hidden behind stale drawer state.

## Screenshots
- stale-links-before.png
- stale-links-after-direct-session.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium via Selenium
