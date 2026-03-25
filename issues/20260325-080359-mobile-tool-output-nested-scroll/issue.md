# Bug: Mobile tool output cards force nested vertical scrolling

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`).
2. Open the session `WORKER_NUM=1 WORKTREE=/home/user/feather-dev/w1 PORT=3301 WORKER_DIR=/home/user/`.
3. Scroll through chat messages containing `OUTPUT` tool results.

## Expected behavior
Tool output should remain readable in the main chat scroll, without trapping the user inside tiny inner vertical scroll regions.

## Actual behavior
Each visible tool output renders inside a short inner scroll box on mobile. In the captured session, the visible `pre` block is about `200px` tall with `overflow-y: auto` and a `scrollHeight` of about `920px`, so only a small slice of the result is visible unless the user performs a second precise vertical scroll inside the card.

## Screenshots
- iter-bottom.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (`agent-browser`)
