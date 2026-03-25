# Bug: Active session title missing from accessibility tree

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`).
2. Open the session drawer and select any existing session. I used `hello old friend`.
3. Observe that the session header visibly shows the active session title.
4. Capture the accessibility tree with `agent-browser snapshot -i`.

## Expected behavior
The visible active-session title should be exposed in the accessibility tree so screen-reader users can tell which conversation is open.

## Actual behavior
The title is rendered visually (`hello old friend` in this run), but the accessibility snapshot exposes only the menu button, tabs, message content, and composer controls. The active-session title is missing entirely from the accessible tree.

## Evidence
- `agent-browser eval` returned `visibleTitle: "hello old friend"` while the same page's accessibility snapshot omitted that text.
- Accessibility snapshot on the active session began with only:
  - `button "☰"`
  - `button "Chat"`
  - `button "Terminal"`
  - message table cells / composer controls

## Screenshots
- session-opened-mobile-reset.png
- chat-scrollbar-gutter-full.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (`agent-browser`)
