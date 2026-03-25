# Bug: Direct session URL loads the empty state instead of the requested chat

## Status
new

## Severity
high

## Steps to reproduce
1. Open `http://localhost:3304/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf` on mobile (`390x844`).
2. Wait for the app to finish loading.

## Expected behavior
Feather should open the `hello old friend` session because that session id exists in `/api/sessions`.

## Actual behavior
Feather stays on the empty `Select a session` screen and shows `Open a session or create a new one` even though the URL hash points at an existing session.

## Screenshots
- hashed-session-empty-state.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
