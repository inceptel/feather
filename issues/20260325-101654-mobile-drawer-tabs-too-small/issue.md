# Bug: Mobile drawer tabs are too small to tap reliably

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`).
2. Tap the hamburger button to open the left drawer.
3. Measure the `Sessions` and `Links` tabs with `getBoundingClientRect()`.

## Expected behavior
The primary drawer tabs should meet the standard mobile minimum touch target size of at least `44x44` CSS pixels.

## Actual behavior
Both drawer tabs are only about `149.5x32` CSS pixels, leaving the main navigation between `Sessions` and `Links` too short for reliable tapping on mobile.

## Evidence
- `agent-browser eval` returned:
  - `Sessions`: `width 149.5`, `height 32`
  - `Links`: `width 149.5`, `height 32`

## Screenshots
- drawer-open.png
- links-view.png

## Environment
- Viewport: `390x844` (mobile)
- Browser: Chromium (`agent-browser`)
