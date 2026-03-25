# Bug: Hamburger button jumps into a session instead of opening the drawer

## Status
new

## Severity
high

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`).
2. Wait for the landing state with the `Select a session` header and `Open a session or create a new one`.
3. Tap the hamburger button in the top-left corner.

## Expected behavior
The hamburger should open the session drawer so the user can browse sessions from the landing page.

## Actual behavior
Instead of opening the drawer, the app jumps straight into an existing session. In this run the page switched from the empty landing screen to a transcript headed `7d1fe762`, exposing `Resume`, `Chat`, `Terminal`, and the composer after a single hamburger tap.

## Screenshots
- landing-before-tap.png
- menu-tap-result.png

## Environment
- Viewport: `390x844` (mobile)
- Browser: Chromium (`agent-browser`)
- URL under test: `http://localhost:3304/`
