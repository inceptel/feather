# Bug: Collapsed tool summary touch target is too small on mobile

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/#4baa1292-7fdf-4e87-af47-6731e459b3cd` on mobile (`390x844`).
2. Scroll through the transcript until the collapsed `Read w4/after-send-iter30.png` tool card appears.
3. Inspect that summary row or try to tap it accurately on a phone.

## Expected behavior
Collapsed tool cards should provide a disclosure row that meets basic mobile touch-target guidance, at least about `44px` tall.

## Actual behavior
The collapsed `Read w4/after-send-iter30.png` summary renders as a very short pill. DOM inspection measured that `summary` at about `244.8x30` CSS pixels on the `390x844` viewport, which is well below the recommended mobile target size and makes expanding the tool result unnecessarily hard.

## Screenshots
- tool-summary-small-target.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium via Playwright mobile emulation

## Evidence
- Current session `worker 4 probe` rendered `38` transcript `summary` elements.
- The smallest visible tool summary was `Read w4/after-send-iter30.png` at about `244.8x30` CSS pixels.
