# Bug: Long session opens at the top of the transcript on mobile

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/#4baa1292-7fdf-4e87-af47-6731e459b3cd` on mobile (`390x844`).
2. Wait for the session to finish rendering.
3. Observe the initial scroll position.

## Expected behavior
Feather should open an existing long session near the latest messages so the current conversation state is immediately visible.

## Actual behavior
Feather opens the session at the very top of the transcript. On a fresh load, the viewport shows the oldest visible content around `05:52 AM` while newer messages from `07:09 AM` exist farther down the transcript. DOM inspection on load showed the main chat scroller at `scrollTop: 0` with `scrollHeight: 21553` and `clientHeight: 706`.

## Screenshots
- session-opens-at-top.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
- URL: `http://localhost:3304/#4baa1292-7fdf-4e87-af47-6731e459b3cd`
