# Bug: Chat transcript lacks live-region semantics

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf` on mobile (`390x844`).
2. Wait for the chat transcript to load.
3. Inspect the scrollable transcript container in the DOM.

## Expected behavior
The live chat transcript should expose assistive-technology semantics for streaming updates, such as `role="log"` and/or `aria-live`, so new messages are announced while the session is active.

## Actual behavior
The transcript is visibly loaded and scrollable, but the chat container is just a plain `div` with no `role`, no `aria-live`, and no accessible label. In this run, the main transcript scroller measured `clientHeight: 706`, `scrollHeight: 28599`, `overflow-y: auto`, while `role`, `aria-live`, and `aria-label` were all `null`.

## Screenshots
- selenium-session.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium via Selenium
