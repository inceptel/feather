# Bug: Empty-state header text is low contrast on mobile

## Status
new

## Severity
low

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`).
2. Leave Feather on the landing screen with no session selected.
3. Look at the `Select a session` header text at the top of the main pane.

## Expected behavior
The landing-screen header text should meet normal-text contrast requirements and remain easy to read on the dark background.

## Actual behavior
The `Select a session` placeholder is rendered in `#666` on the app's `#0a0e14` background, which is only about `3.37:1` contrast at `14px`. On mobile it looks noticeably dim compared with adjacent controls and fails WCAG AA for normal text.

## Screenshots
- landing.png

## Environment
- Viewport: `390x844` (mobile)
- Browser: Chromium (`agent-browser`)
