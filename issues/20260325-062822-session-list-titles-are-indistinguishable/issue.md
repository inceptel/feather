# Bug: Mobile session drawer titles are indistinguishable because they expose raw worker prompt text

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile at `390x844`.
2. Tap the hamburger button to open the session drawer.
3. Look at the first several session rows.

## Expected behavior
Session titles should be short and distinguishable enough to let a user pick the right conversation from the mobile drawer.

## Actual behavior
Most rows render as the same truncated prefix, `WORKER_NUM=... WORKTREE=...`, because Feather is using the raw worker bootstrap prompt as the session title. On mobile those labels collapse into dozens of nearly identical entries, so the list is effectively unreadable even before you hit the separate cross-worker filtering problem.

## Screenshots
- landing.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
- Verified against `GET /api/sessions` on port 3304 at `2026-03-25T06:27:11Z`, which returned many titles beginning with `WORKER_NUM=3 WORKTREE=/home/user/feather-dev/w3 PORT=3303 ...` and `WORKER_NUM=2 WORKTREE=/home/user/feather-dev/w2 PORT=3302 ...`
