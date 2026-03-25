# Bug: Chat message timestamps are unreadable on mobile dark theme

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/#4baa1292-7fdf-4e87-af47-6731e459b3cd` on mobile (`390x844`).
2. Scroll to any visible chat messages in the transcript.
3. Look at the timestamp metadata under each bubble, such as `07:27 AM` and `08:18 AM`.

## Expected behavior
Per-message timestamps should be easy to read against the chat background.

## Actual behavior
The timestamps render at `10px` in `rgb(68, 68, 68)` on `rgb(10, 14, 20)`, which is only about `1.99:1` contrast. On the dark mobile theme they are barely visible, so message timing metadata is effectively unreadable.

## Screenshots
- iter39-after-send.png
- iter39-timestamps-full.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (`agent-browser`)
