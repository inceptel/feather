# Bug: Chat attach button touch target is too small on mobile

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf` on mobile at `390x844`.
2. Look at the chat composer at the bottom of the screen.
3. Measure the `+` attach button with `getBoundingClientRect()`.

## Expected behavior
The attach control should meet the standard mobile minimum touch target of at least `44x44` CSS pixels.

## Actual behavior
The attach button renders at about `19.7x36` CSS pixels, making it significantly harder to tap than the adjacent input and send controls.

## Screenshots
- direct-session.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
- Verified on: 2026-03-25 05:35 UTC
