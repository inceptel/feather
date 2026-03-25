# Bug: Resume does not persist active state

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/#e9c91a42-126f-473b-b559-0999a12b0698` on mobile (`390x844`).
2. Wait for the transcript to load with the green `Resume` button visible in the header.
3. Tap `Resume`.
4. Observe that the header swaps from the `Resume` button to a green active dot before the session title.
5. Query `GET http://localhost:3304/api/sessions` and inspect session `e9c91a42-126f-473b-b559-0999a12b0698`.

## Expected behavior
Resuming a session should persist the active state so the backend session list reports that session as active.

## Actual behavior
The UI shows the session as resumed, but the worker 4 session list still returns that same session with `"isActive": false`, so the resume action only updates local UI state and does not persist.

## Screenshots
- resume-before.png
- resume-after.png
- session-api.json

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
- Worker: `WORKER_NUM=4`
- Port: `3304`
