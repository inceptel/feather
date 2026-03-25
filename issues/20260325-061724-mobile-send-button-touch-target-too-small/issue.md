# Bug: Mobile send button touch target is too short

## Status
new

## Severity
low

## Steps to reproduce
1. Open `http://localhost:3304/#4baa1292-7fdf-4e87-af47-6731e459b3cd` on mobile at `390x844`.
2. Inspect the chat composer at the bottom of the screen.
3. Measure the `Send` button with `getBoundingClientRect()`.

## Expected behavior
The primary `Send` action should meet the 44x44 CSS pixel minimum touch target guidance on mobile.

## Actual behavior
The `Send` button measures about `68.7x42` CSS pixels, so its height is below the recommended minimum.

## Screenshots
- iter17-send-button-size.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
