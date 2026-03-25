# Bug: Empty state shows stray tilde character

## Status
new

## Severity
low

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`).
2. Wait for the empty-state landing pane to finish rendering.
3. Look at the center of the main pane between `Select a session` and `Open a session or create a new one`.

## Expected behavior
The empty state should show only intentional UI copy and controls.

## Actual behavior
Feather renders a lone `~` character in the middle of the empty-state pane, making the landing screen look broken or like a placeholder leaked into production.

## Screenshots
- empty-state-stray-tilde.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
