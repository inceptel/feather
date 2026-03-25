# Bug: Terminal disconnected state has no recovery

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`).
2. Open any visible session from the sidebar.
3. Tap the `Terminal` tab.

## Expected behavior
If the terminal cannot connect, Feather should explain the failure and offer a recovery path such as retrying, reconnecting, or returning to chat with context.

## Actual behavior
The terminal pane switches to a nearly blank screen that only shows `[disconnected]` in the top-left corner. There is no retry action, reconnect affordance, or explanatory message, so the user is stranded in a dead terminal view.

## Screenshots
- terminal-iter38.png
- terminal-iter38-full.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (`agent-browser`)
- URL observed: `http://localhost:3304/#7ea2790b-5ff1-4498-b15c-2ba8d26f1176`
