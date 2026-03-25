# Bug: Links empty-state helper text is too low contrast on mobile

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile at `390x844`.
2. Tap the hamburger button to open the sidebar drawer.
3. Tap `Links`.
4. Observe the empty-state helper copy at the top of the drawer.

## Expected behavior
Empty-state instructional text should be clearly readable and meet minimum contrast for normal text on the dark drawer background.

## Actual behavior
The helper copy renders in about `rgb(85, 85, 85)` on `rgb(13, 17, 23)`, which is only about `2.54:1` contrast, so the `No quick links yet. Use /feather add link to add some.` message is difficult to read on mobile.

## Screenshots
- links-iter.png

## Environment
- Viewport: `390x844` (mobile)
- Browser: Chromium (`agent-browser`)
- URL: `http://localhost:3304/`
