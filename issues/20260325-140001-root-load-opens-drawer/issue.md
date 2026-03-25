# Bug: Root load opens the session drawer without any user interaction

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`) in a fresh browser session.
2. Wait for the page to finish loading.
3. Observe the first rendered state before tapping anything.

## Expected behavior
The root landing screen should open with the main content visible and the session drawer closed until the user taps the hamburger button.

## Actual behavior
Feather renders the session drawer immediately on first paint. The screenshot and accessibility snapshot from the untouched page already show the drawer close button, drawer tabs, and `+ New Claude`, while the landing content is squeezed into a narrow strip behind it.

## Screenshots
- landing.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (`agent-browser`)
