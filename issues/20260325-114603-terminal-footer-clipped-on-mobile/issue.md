# Bug: Terminal footer/status rows are clipped on mobile

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf` on mobile (`390x844`).
2. Switch to the `Terminal` tab.
3. Look at the bottom terminal rows and footer/status area.

## Expected behavior
The terminal should fit within the mobile viewport so the footer/status rows are fully visible and readable.

## Actual behavior
The bottom terminal status area is clipped on mobile. The right side of the `bypass permissions...` row is cut off, and the yellow `[feather-3<la>] • Claude Code ...` status row is pressed into the bottom edge so it is only partially visible.

## Screenshots
- terminal-footer-clipped.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (`agent-browser`)
