# Bug: Worker 4 sidebar lists other workers' sessions

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`).
2. Tap the hamburger button to open the session drawer.
3. Inspect the session titles shown at the top of the list.

## Expected behavior
The worker 4 app should list only sessions that belong to worker 4 on port 3304.

## Actual behavior
The drawer is populated with sessions titled `WORKER_NUM=1`, `WORKER_NUM=2`, and `WORKER_NUM=3`, so worker 4 shows other workers' conversations before its own local session (`worker 4 probe`). The same cross-worker entries are returned by `GET /api/sessions` on port 3304.

## Screenshots
- drawer-shows-other-workers.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (`agent-browser`)
- Verified at: 2026-03-25T06:24:06Z
