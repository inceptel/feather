# Bug: Chat composer relies on placeholder text as its only accessible label

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf` on mobile (`390x844`).
2. Focus the chat composer at the bottom of the transcript.
3. Inspect the composer textarea attributes and accessibility tree.

## Expected behavior
The message composer should have a persistent programmatic label, such as an associated `<label>` or `aria-label`, so assistive technologies can identify the field independently of placeholder text.

## Actual behavior
The textarea has no `aria-label`, no `aria-labelledby`, and no associated `<label>`. Chromium exposes the control with the placeholder text `Send a message...` as its accessible name instead. This means the composer depends entirely on placeholder copy for its label.

## Evidence
- DOM inspection on the same screen returned `aria: null`, `labelledby: null`, and `labels: 0` for the visible textarea.
- `Accessibility.getFullAXTree` exposed the textbox with name `Send a message...`, confirming the accessible name is coming from the placeholder rather than a real label.

## Screenshots
- send-offscreen-mobile.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium via Selenium mobile emulation
