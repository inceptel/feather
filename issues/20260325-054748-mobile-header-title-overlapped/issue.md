# Bug: Mobile header title is overlapped by the menu button

## Status
new

## Severity
low

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`).
2. Wait for the landing view with no session selected.
3. Observe the header at the top of the screen.

## Expected behavior
The full header title `Select a session` should be readable without any control covering it.

## Actual behavior
The hamburger button is positioned on top of the header title, hiding the first part of `Select a session` on the mobile landing screen.

## Screenshots
- reloaded.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
