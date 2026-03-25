# Bug: Drawer close icon has too little contrast on mobile

## Status
new

## Severity
low

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`).
2. Tap the hamburger button to open the session drawer.
3. Look at the `×` close control in the drawer header.

## Expected behavior
The close control should stand out clearly against the dark drawer header so it is easy to spot and dismiss the drawer.

## Actual behavior
The `×` icon renders in a muted gray that blends into the header. In `drawer-open.png` it is much harder to see than the nearby `Feather` title and session controls, so the primary dismiss action is visually easy to miss.

## Screenshots
- drawer-open.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (`agent-browser`)
