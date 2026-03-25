# Bug: Mobile chat content starts underneath the sticky header

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`).
2. Open the session drawer.
3. Tap `worker 4 probe`.
4. Look at the first visible assistant message at the top of the chat.

## Expected behavior
The first visible message should start below the fixed header and tab strip so the full text is readable.

## Actual behavior
The chat body is scrolled under the sticky header/tabs. In the captured session view, the first visible list item begins around `y=24` while the tab strip starts around `y=48`, so the top of the message is hidden behind the header and the first line is clipped.

## Screenshots
- worker4-probe-mobile.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (Playwright)
