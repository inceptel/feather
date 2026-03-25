# Bug: Multiple sessions are marked active at the same time

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`).
2. Open the session drawer.
3. Observe that both `rivet gun mounting a camera...` and `worker 4 probe` show the green active-session dot at the same time.
4. Fetch `GET /api/sessions` on port `3304`.

## Expected behavior
Only one session should be marked active at a time, so the UI and API agree on a single current session.

## Actual behavior
The drawer shows two separate sessions with the active green dot, and `GET /api/sessions` returns both `e9d72474-79ac-424b-a6f4-445b370fb52d` and `4baa1292-7fdf-4e87-af47-6731e459b3cd` with `isActive: true` simultaneously.

## Screenshots
- drawer-now.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (`agent-browser`)
- API evidence: `GET http://localhost:3304/api/sessions` at 2026-03-25T14:30Z returned two active sessions
