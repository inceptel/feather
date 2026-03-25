# Bug: Sending from worker 4 session switches Feather to another worker's session

## Status
new

## Severity
high

## Steps to reproduce
1. Open `http://localhost:3304/#4baa1292-7fdf-4e87-af47-6731e459b3cd` on mobile (`390x844`).
2. Confirm the session title is `worker 4 probe` and type `worker4 iter22 delivery probe` in the composer.
3. Tap `Send`.
4. Wait a few seconds for the send/navigation to settle.

## Expected behavior
Feather should stay on the same worker 4 session and append the sent message to that transcript on port 3304.

## Actual behavior
After tapping `Send` at `2026-03-25T06:36:28Z`, Feather navigated away from the worker 4 session and ended at `http://localhost:3301/#5d3cb8bc-61a2-4c54-a47e-23806ef7b65d`, showing a `WORKER_NUM=3 ... PORT=3303` transcript instead. The send flow effectively hijacked the user into another worker's active session.

## Screenshots
- `before-send-filled.png`
- `after-send-waited.png`
- `cross-session-after-send-full.png`

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (`agent-browser`)
- Source session: `http://localhost:3304/#4baa1292-7fdf-4e87-af47-6731e459b3cd`
- Destination observed after send: `http://localhost:3301/#5d3cb8bc-61a2-4c54-a47e-23806ef7b65d`
