# Bug: Mobile Resume button touch target too small

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`) in Chromium.
2. Load any chat session so the header shows the green `Resume` button.
3. Measure the button with `getBoundingClientRect()`.

## Expected behavior
Primary header actions should expose at least a `44x44` CSS pixel touch target on mobile.

## Actual behavior
The `Resume` button renders at about `70.7x22` CSS pixels, making the vertical touch target roughly half the recommended minimum.

## Screenshots
- mobile-resume-button.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
