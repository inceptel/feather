# Bug: Chat view exposes terminal input instead of chat composer in accessibility tree

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf` on mobile (`390x844`).
2. Stay on the default `Chat` tab.
3. Capture an accessibility snapshot with `agent-browser snapshot -i`.

## Expected behavior
The accessibility tree should expose the chat composer control for the active Chat view, and it should not announce terminal-only controls while the Terminal tab is inactive.

## Actual behavior
With `Chat` visibly selected, the accessibility snapshot exposes:

`- button "☰"`
`- button "Resume"`
`- button "Chat"`
`- button "Terminal"`
`- textbox "Terminal input"`

The visible chat composer (`Send a message...`) is not represented. Screen-reader users are told they are focused on a terminal textbox even though the UI is in chat mode.

## Screenshots
- session-state-check.png
- session-hello-current.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (`agent-browser`)
