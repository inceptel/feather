# Bug: Session drawer timestamps have low contrast on mobile

## Status
new

## Severity
low

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile at `390x844`.
2. Tap the hamburger button to open the session drawer.
3. Look at the relative-time labels such as `now`, `1m`, and `2m` on the right side of each session row.

## Expected behavior
Secondary timestamp text should still meet minimum readable contrast against the drawer background.

## Actual behavior
The drawer renders those timestamps at `11px` in `#555` on `rgb(13, 17, 23)`, which is only about `2.54:1` contrast. The labels are visibly faint and fall below WCAG AA for normal-sized text.

## Screenshots
- session-drawer-time-low-contrast.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
