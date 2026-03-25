# Bug: Links empty-state helper text missing from accessibility tree

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`).
2. Open the sidebar drawer.
3. Switch from `Sessions` to `Links`.
4. Inspect the page with `agent-browser snapshot -i`.

## Expected behavior
The visible helper copy in the Links empty state should be exposed to assistive technology so screen-reader users hear the instruction that no quick links exist yet and how to add one.

## Actual behavior
The Links pane visibly shows `No quick links yet. Use /feather add link to add some.` in `links-fresh.png`, but the accessibility snapshot only exposes the `×`, `Sessions`, and `Links` buttons. The helper text is omitted entirely.

## Screenshots
- links-fresh.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (`agent-browser`)
