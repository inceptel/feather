# Bug: Root route ignores active session and shows empty state

## Status
new

## Severity
medium

## Steps to reproduce
1. On mobile (`390x844`), open `http://localhost:3304/`.
2. Use the empty-state composer to send a first message. In my run, sending `worker 4 probe` created a new backend session at `2026-03-25T05:52:24Z`.
3. Confirm through `GET /api/sessions` that the new session exists and is marked `"isActive": true`.
4. Open `http://localhost:3304/` again on mobile.

## Expected behavior
When Feather already has an active session, reopening the root route should restore that session and show its messages.

## Actual behavior
Feather lands on the empty-state pane (`Open a session or create a new one`) instead of restoring the active session, even though the backend has an active session recorded.

## Screenshots
- direct-clean.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
- Verified against `http://localhost:3304/api/sessions` at `2026-03-25T05:52:24Z`
