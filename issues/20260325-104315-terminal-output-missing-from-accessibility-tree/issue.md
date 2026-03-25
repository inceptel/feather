# Bug: Terminal output missing from accessibility tree

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf` on mobile (`390x844`).
2. Switch from `Chat` to `Terminal`.
3. Observe that the terminal visibly contains prior output such as worker status text, a markdown table, and prompt lines.
4. Capture the accessibility snapshot with `agent-browser snapshot -i`.

## Expected behavior
Visible terminal transcript content should be exposed to assistive technology so a screen-reader user can review the same terminal output that is on screen.

## Actual behavior
The accessibility snapshot exposes only:
- `button "☰"`
- `button "Chat"`
- `button "Terminal"`
- `textbox "Terminal input"`
- nested `textbox "Terminal input"`

The visible terminal transcript is omitted entirely even though it is rendered on screen.

## Screenshots
- terminal-view.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
