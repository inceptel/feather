# Bug: Direct session hash on port 3304 loads the wrong session transcript

## Status
new

## Severity
high

## Steps to reproduce
1. Open Feather on mobile at `http://localhost:3304/#4baa1292-7fdf-4e87-af47-6731e459b3cd`.
2. Wait for the session view to finish loading.
3. Compare the requested session id with the visible session title and transcript.

## Expected behavior
Feather should load session `4baa1292-7fdf-4e87-af47-6731e459b3cd`, which `GET /api/sessions` on port 3304 reports as `worker 4 probe`.

## Actual behavior
The URL stays `http://localhost:3304/#4baa1292-7fdf-4e87-af47-6731e459b3cd`, but the page renders a different session headed `WORKER_NUM=2 WORKTREE=/home/user/feather-dev/w2 PORT=3302...` and shows that worker's transcript instead of `worker 4 probe`.

## Evidence
- `location.href` remained `http://localhost:3304/#4baa1292-7fdf-4e87-af47-6731e459b3cd`.
- `document.body.innerText.slice(0,220)` began with `WORKER_NUM=2 WORKTREE=/home/user/feather-dev/w2 PORT=3302...`.
- `GET http://localhost:3304/api/sessions` still listed id `4baa1292-7fdf-4e87-af47-6731e459b3cd` with title `worker 4 probe` and `isActive: true`.

## Screenshots
- session-iter29.png
- session-iter29-full.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (`agent-browser`)
- Port: 3304
