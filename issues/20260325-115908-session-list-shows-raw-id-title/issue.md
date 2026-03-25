# Bug: Session list shows raw internal ID as the session title

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` in Chromium on a mobile viewport (`390x844`).
2. Tap the hamburger button to open the `Sessions` drawer.
3. Look at the newest session row at the top of the list.

## Expected behavior
The drawer should show a human-readable session title, or at minimum a clear fallback label that helps identify the session.

## Actual behavior
The newest row renders as the opaque string `1cb410df`, exposing an internal-looking session identifier instead of a usable title.

## Screenshots
- drawer-missing-raw-id.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (Selenium)
