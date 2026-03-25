# Replication Instructions: Session titles indistinguishable on mobile

## Steps to reproduce

1. Open Feather at `http://localhost:PORT/` in a 390x844 mobile viewport
2. Wait for the app to fully load (3-4 seconds)
3. Click the hamburger menu (☰) to open the sidebar
4. Wait for the session list to populate
5. Observe the session titles

## Expected behavior
Session titles should be visually distinguishable so users can identify sessions.

## Actual behavior
96-98% of session titles start with "WORKER_NUM=X WORKTREE=/home/user/feather..." and are visually identical due to `text-overflow: ellipsis` and `white-space: nowrap` truncation. The distinguishing information (different worker numbers, paths, ports) is truncated away.

## Detection method
Count `div[style*=cursor]` elements in the sidebar. If >80% have `textContent` starting with "WORKER_NUM=", the bug is present. In testing, 48-49 out of 50 sessions (96-98%) start with "WORKER_NUM=".

## Root cause
Session titles are derived from the initial user message, which for automated sessions starts with environment variable declarations (WORKER_NUM=, WORKTREE=, PORT=, WORKER_DIR=). The title rendering uses `text-overflow: ellipsis` with `white-space: nowrap`, truncating the only distinguishing parts.

## Reliability
3/3 — consistently reproducible.
