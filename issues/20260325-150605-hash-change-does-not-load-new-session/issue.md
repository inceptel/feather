# Bug: Changing the URL hash does not load the newly addressed session

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf` on mobile (`390x844`).
2. Wait for the `hello old friend` transcript to render.
3. In the same tab, change the hash to `#4baa1292-7fdf-4e87-af47-6731e459b3cd` without reloading the page.
4. Wait a few seconds for Feather to react.

## Expected behavior
Feather should treat the new hash as navigation to a different session, load that session's transcript, and update the header from `hello old friend` to `worker 4 probe`.

## Actual behavior
The browser URL updates to `http://localhost:3304/#4baa1292-7fdf-4e87-af47-6731e459b3cd`, but the UI stays on the previous `hello old friend` transcript. The post-change DOM still contains `hello old friend` and does not contain `worker 4 probe`, so browser back/forward or any in-tab hash navigation can leave the address bar and visible session out of sync.

## Screenshots
- hash-nav-before.png
- hash-nav-after.png

## Extra evidence
- `hash-change-evidence.json` records the before/after URLs and the unchanged transcript text.

## Environment
- Viewport: `390x844` (mobile)
- Browser: Chromium via Playwright
