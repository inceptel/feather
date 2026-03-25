# Bug: Chat composer placeholder text has low contrast on mobile

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/#7a004500-bb31-4cef-bf78-50ec21b8cefc` on mobile (`390x844`).
2. Leave the chat composer empty so the `Send a message...` placeholder is visible.
3. Compare the placeholder against the dark composer background at the bottom of the screen.

## Expected behavior
The composer placeholder should remain comfortably readable on the dark input background and meet minimum contrast guidance for normal-sized text.

## Actual behavior
The `Send a message...` placeholder is rendered in a muted gray that blends into the purple input background. In the live DOM, Chromium reported placeholder color `rgb(117, 117, 117)` on composer background `rgb(26, 26, 46)` at `15px`, which is only about `3.70:1` contrast. That falls below WCAG AA for normal text and is visibly dim in the mobile screenshot.

## Screenshots
- selenium-session.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium via Selenium
