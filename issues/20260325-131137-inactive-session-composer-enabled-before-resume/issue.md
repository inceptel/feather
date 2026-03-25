# Bug: Inactive session leaves composer enabled before resume

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/#86f8d3e2-4f04-4d68-ab59-7115e11f5938` on mobile (`390x844`).
2. Wait for the session to load.
3. Observe that the header still shows the green `Resume` button, indicating the session is inactive.
4. Check the composer at the bottom of the chat.

## Expected behavior
An inactive session should not expose an active composer before resume. The textarea and send controls should stay disabled or hidden until the user resumes the session.

## Actual behavior
Feather renders the full message composer while the same session is still inactive. `GET /api/sessions` reports `isActive: false` for `86f8d3e2-4f04-4d68-ab59-7115e11f5938`, but the UI still shows an enabled textarea plus enabled `+` and `Send` buttons alongside the `Resume` call to action.

## Screenshots
- inactive-session-enabled-composer.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium via Selenium
- Verified at: 2026-03-25T13:13Z
