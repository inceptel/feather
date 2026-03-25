# Bug: Mobile menu button touch target is too small

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` in Chromium at `390x844`.
2. Look at the hamburger menu button in the top-left corner of the header.
3. Measure its rendered size with `getBoundingClientRect()`.

## Expected behavior
The primary mobile navigation control should meet the common 44x44 px minimum touch target so it is easy to hit reliably.

## Actual behavior
The hamburger menu renders at `36x36` px, which is below the 44x44 px mobile touch target guideline. This makes the primary navigation control harder to tap accurately on a phone-sized viewport.

## Verification
- `agent-browser eval` returned the menu button rect as `width: 36`, `height: 36` on the mobile viewport.

## Screenshots
- landing.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
