# Bug: Mobile chat transcript shows a persistent scrollbar gutter

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf` on mobile (`390x844`).
2. Wait for the existing chat transcript to render.
3. Look at the right edge of the transcript area.

## Expected behavior
The chat transcript should use the available viewport width and only show an overlay scrollbar while actively scrolling.

## Actual behavior
Feather renders a permanent bright scrollbar gutter along the right edge of the chat transcript on mobile, reducing the already limited reading width and drawing attention away from the message content.

## Screenshots
- session-current.png
- session-current-full.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (`agent-browser`)
