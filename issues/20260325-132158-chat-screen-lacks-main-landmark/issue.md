# Bug: Mobile chat screen lacks a main landmark

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf` on mobile (`390x844`).
2. Wait for the chat transcript to load.
3. Inspect the rendered page structure.

## Expected behavior
The loaded chat view should expose a primary content landmark such as `<main>` or `role="main"` so assistive technology users can jump directly to the transcript area.

## Actual behavior
The chat transcript renders, but the page exposes no landmarks at all. The captured DOM evidence shows `"landmarks": []` and `"mainExists": false` even though the transcript scroller fills the page.

## Screenshots
- chat-screen.png

## Additional evidence
- dom-evidence.json

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium via Selenium mobile emulation
