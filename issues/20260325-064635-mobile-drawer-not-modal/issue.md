# Bug: Mobile session drawer is not modal and leaves background composer controls actionable

## Status
new

## Severity
high

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`).
2. Open the session drawer with the hamburger button.
3. Without closing the drawer, target the still-exposed background composer controls.
4. Enter `drawer modal probe` and activate `Send`.

## Expected behavior
Opening the session drawer should behave like a modal overlay on mobile. Background chat controls should be hidden from the accessibility tree and should not accept input until the drawer is dismissed.

## Actual behavior
With the drawer open, the accessibility snapshot still exposed the background `Resume`, `Chat`, `Terminal`, `+`, `Send a message...`, and `Send` controls. Using those exposed controls succeeded: Feather accepted `drawer modal probe`, changed the URL to `http://localhost:3304/#07ce9a8f-d436-48ad-92fb-9965079d07d4`, and the page body then contained the sent text.

## Screenshots
- drawer-iter24.png
- drawer-send-probe.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (`agent-browser`)
