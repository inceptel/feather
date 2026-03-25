# Bug: Mobile chat and terminal tabs miss minimum touch target size

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/#4baa1292-7fdf-4e87-af47-6731e459b3cd` in Chromium with a `390x844` viewport.
2. Wait for the `worker 4 probe` session to render.
3. Inspect the `Chat` and `Terminal` tab buttons below the header.

## Expected behavior
The primary tab controls should meet the common 44x44 px mobile touch target minimum so they are easy to tap.

## Actual behavior
The `Chat` and `Terminal` buttons render at only about `29px` tall on mobile. Measured via `getBoundingClientRect()`, `Chat` was `60.89x29` and `Terminal` was `85.22x29`, making the main mode switcher undersized for touch.

## Screenshots
- hash-worker4-probe-iter16.png
- composer-one-line-iter16.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
