# Bug: Inactive drawer tab label has low contrast on mobile

## Status
new

## Severity
low

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`).
2. Tap the hamburger menu to open the drawer.
3. Tap `Links` so `Sessions` becomes the inactive drawer tab.

## Expected behavior
The inactive drawer tab label should remain comfortably readable and meet contrast guidance for small text.

## Actual behavior
The inactive `Sessions` tab is rendered as `rgb(102, 102, 102)` text at `12px` on Feather's `rgb(10, 14, 20)` dark background, for only about `3.37:1` contrast. On mobile it fades into the header and is noticeably harder to read than the active tab.

## Screenshots
- drawer-links-active.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (Playwright)
