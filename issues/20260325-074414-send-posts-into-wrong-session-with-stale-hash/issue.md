# Bug: Sending on a stale hash posts into the wrong session

## Status
new

## Severity
high

## Steps to reproduce
1. Open `http://localhost:3304/#4baa1292-7fdf-4e87-af47-6731e459b3cd` on mobile (`390x844`).
2. Wait for Feather to load the session view.
3. Observe that the header and transcript show `WORKER_NUM=3 ... /w3` content even though the URL still points at the worker 4 session hash.
4. Type `worker4 delivery icon probe` and tap `Send`.

## Expected behavior
Feather should load the worker 4 session identified by the URL hash, and any new message should be posted into that same session.

## Actual behavior
Feather keeps the worker 4 hash in the address bar but renders a worker 3 transcript instead. Sending a new message appends that message into the wrong visible conversation while the URL still claims the worker 4 session is open.

## Screenshots
- `worker4-direct-mobile.png`
- `after-send-delivery-probe.png`

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (`agent-browser`)
- URL under test: `http://localhost:3304/#4baa1292-7fdf-4e87-af47-6731e459b3cd`
