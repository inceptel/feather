# Bug: Chat message timestamps lack time semantics

## Status
new

## Severity
low

## Steps to reproduce
1. Open `http://localhost:3304/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf` on mobile (`390x844`).
2. Wait for the transcript to load.
3. Inspect the visible message timestamps in the chat transcript.

## Expected behavior
Each visible message time should be exposed with semantic time markup, for example a `<time datetime="...">` element or equivalent accessible metadata, so assistive tech and automation can identify message timestamps programmatically.

## Actual behavior
The transcript renders visible times like `11:42 AM` and `11:43 AM` as plain `SPAN` nodes. A DOM check on the loaded chat found `timeElementCount: 0`, and the sampled timestamps had no `datetime`, `role`, or `aria-label`.

## Screenshots
- chat-timestamps.png
- dom-evidence.json

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium via Selenium mobile emulation

