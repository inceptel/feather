# Bug: Failed send looks delivered and discards the draft

## Status
new

## Severity
high

## Steps to reproduce
1. Open `http://localhost:3304/#4baa1292-7fdf-4e87-af47-6731e459b3cd` on mobile (`390x844`).
2. Inject a failing `/send` request in the browser. In Selenium I overrode `window.fetch` to reject any URL containing `/send`.
3. Type `forced send failure probe`.
4. Tap `Send`.

## Expected behavior
When the send request fails, Feather should preserve the draft or clearly mark the optimistic bubble as failed and show an error state with a retry path.

## Actual behavior
Feather immediately clears the composer, appends an optimistic user bubble, and leaves it in the single-check "sent" state even though the `/send` request rejected. No visible error banner, toast, or retry control appears, so the failed message looks partially delivered.

## Screenshots
- `send-fail-before.png`
- `send-fail-after.png`

## Additional evidence
- `evidence.json` shows the injected `/send` call was hit once, the textarea value was cleared, and the optimistic message remained visible after the rejection.

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium via Selenium
