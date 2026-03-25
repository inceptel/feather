# Bug: Mobile composer textarea scrolls internally instead of growing

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`).
2. Open any chat session from the drawer.
3. Enter a draft long enough to wrap to several lines, for example: `first line second line third line fourth line fifth line sixth line seventh line eighth line ninth line tenth line`.

## Expected behavior
The composer should grow to fit a short multi-line draft, or otherwise keep the full draft visible without requiring a nested scroll area inside the input.

## Actual behavior
The composer textarea stays fixed-height and shows its own vertical scrollbar. On this run, the textarea reported `clientHeight: 118` and `scrollHeight: 125`, so even a short wrapped draft became a nested scroll region inside the already scrollable mobile chat screen.

## Screenshots
- composer-scrollbar2.png

## Environment
- Viewport: `390x844` (mobile)
- Browser: Chromium (`agent-browser`)
- URL tested: `http://localhost:3304/#cb27b0c0-ec00-4df1-8071-f3c6e58ad5d1`
