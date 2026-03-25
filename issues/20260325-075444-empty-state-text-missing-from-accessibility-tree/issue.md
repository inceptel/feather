# Bug: Empty-state text missing from accessibility tree

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`).
2. Wait for the landing screen to render the empty state.
3. Capture an accessibility snapshot with `agent-browser --session-name ... snapshot -i`.

## Expected behavior
The visible `Select a session` heading and the `Open a session or create a new one` empty-state instruction should both be exposed to assistive technology.

## Actual behavior
The landing screen visibly shows the heading and instruction text in `iter34b-root.png`, but the accessibility snapshot only exposes the hamburger button:

`- button "☰" [ref=e1]`

Screen-reader users do not get the empty-state context or guidance that sighted users see.

## Screenshots
- iter34b-root.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (`agent-browser`)
