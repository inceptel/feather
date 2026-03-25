# Bug: Mobile active-session header truncates session title into an indistinguishable fragment

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`).
2. Open the session drawer.
3. Select a session with a long title such as `WORKER_NUM=2 WORKTREE=/home/user/feather-dev/w2 PORT=3302 WORKER_DIR=/home/user/`.
4. Observe the sticky header after the session loads.

## Expected behavior
The active session header should show enough of the current session title to identify which session is open on mobile.

## Actual behavior
The header collapses the active session title to an ellipsized fragment (`WORKER_NUM=2 WORKTR...`) between the hamburger and `Resume` controls, making multiple long-named sessions indistinguishable. In this repro, the full title text measured about `766px` wide while the visible header title area was only about `231px` wide on a `390px` viewport.

## Screenshots
- mobile-worker4-clean.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
