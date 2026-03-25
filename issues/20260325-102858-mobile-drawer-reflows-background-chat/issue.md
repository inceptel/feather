# Bug: Mobile drawer reflows the background transcript into one-character columns

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf` on mobile (`390x844`).
2. Wait for the seeded session to render.
3. Tap the hamburger button to open the session drawer.

## Expected behavior
The drawer should fully occlude the underlying chat pane, or at minimum leave the background transcript visually stable and unreadable.

## Actual behavior
The underlying chat remains visible in a narrow strip and the transcript text reflows into a one-character-wide vertical column behind the drawer, producing visibly corrupted background content.

## Screenshots
- hash-session-drawer.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
