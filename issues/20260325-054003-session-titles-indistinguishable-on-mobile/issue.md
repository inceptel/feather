# Bug: Session titles are indistinguishable on mobile — all WORKER_NUM sessions look identical

## Status
new

## Severity
medium

## Steps to reproduce
1. Open http://localhost:3301/ on mobile (390x844)
2. Tap hamburger menu to open sidebar
3. Look at the session list

## Expected behavior
Session titles should be visually distinct so users can identify and select the correct session. Each session should have a meaningful, differentiable title visible without scrolling horizontally.

## Actual behavior
Nearly all sessions display as "WORKER_NUM=X WORKTREE=..." with text-overflow ellipsis truncation. On a 300px sidebar, titles are cut off after approximately 25 characters, making them virtually identical. Out of ~50 sessions in the list, only 2 have distinguishable titles ("hello old friend" and "da0acb54") — the rest all look like "WORKER_NUM=X WORKTREE=...".

The root cause is that session titles are derived from the initial user message prompt, which for automated sessions begins with environment variable declarations (WORKER_NUM=, WORKTREE=, PORT=, WORKER_DIR=). The title extraction (App.tsx line 183) renders `s.title` with `text-overflow: ellipsis` and `white-space: nowrap`, so the distinguishing information (different worker numbers, ports) is either buried in the truncated portion or requires careful reading of nearly-identical text.

This makes it impossible for users to:
- Find a specific session without opening each one
- Distinguish between sessions from different workers
- Navigate efficiently between sessions

## Suggested improvements
- Extract a more meaningful title from session content (e.g., skip env vars, use first substantive user message)
- Show additional metadata below the title (e.g., worker number badge, port, or session ID prefix)
- Add search/filter functionality to the session list

## Screenshots
- sidebar.png — shows the session list with nearly all entries appearing identical

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
