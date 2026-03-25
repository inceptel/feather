# Bug: Links empty state offers no add action on mobile

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`).
2. Open the sidebar drawer.
3. Switch from `Sessions` to `Links`.
4. Observe the empty state.

## Expected behavior
The empty `Links` state should expose a visible way to add a quick link from the UI, or at minimum provide an actionable control in the drawer.

## Actual behavior
The drawer only shows the text `No quick links yet. Use /feather add link to add some.` There is no visible add button, CTA, or menu action in the `Links` pane, so the user hits a dead end on mobile.

## Screenshots
- links-iter.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (`agent-browser`)
