# Bug: Send action opens Chrome new tab page instead of staying in Feather

## Status
new

## Severity
high

## Steps to reproduce
1. Open `http://localhost:3304/#4baa1292-7fdf-4e87-af47-6731e459b3cd` on mobile (`390x844`).
2. Focus the chat composer.
3. Type `worker4 iter70 delivery check`.
4. Tap `Send`.

## Expected behavior
The message should post into the current Feather session and the app should remain on the same Feather chat view.

## Actual behavior
Tapping `Send` leaves Feather completely and opens Chrome's new tab page. After the tap, `location.href` evaluates to `chrome://new-tab-page/` and `document.title` is `New Tab`.

## Screenshots
- before-send-iter70.png
- after-send-iter70.png
- after-send-iter70-full.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (`agent-browser`)
- Feather URL before send: `http://localhost:3304/#4baa1292-7fdf-4e87-af47-6731e459b3cd`
