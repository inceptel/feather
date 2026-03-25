# Bug: Chat composer is buried behind transcript tab order

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf` on mobile (`390x844`).
2. Wait for the chat transcript to load.
3. Use keyboard navigation and press `Tab` from the top of the page until focus reaches the message composer.

## Expected behavior
Keyboard users should be able to reach the chat composer after the primary page controls, without tabbing through dozens of old transcript items first.

## Actual behavior
Feather forces focus through a long sequence of historic transcript controls before the composer. In this run, the first `TEXTAREA` was not reached until the 64th `Tab` press. Before that, focus cycled through the hamburger button, the `Chat` and `Terminal` tabs, then dozens of offscreen transcript `SUMMARY` elements from older tool cards. The saved DOM evidence shows 38 focusable elements on the page, with 35 transcript/tool-card entries appearing before the composer controls.

## Evidence
- Keyboard probe on `2026-03-25T14:49:46Z` reached the composer only at `found_at: 64`.
- `tab-order-evidence.json` shows repeated focusable `SUMMARY` nodes with large negative `y` positions, meaning offscreen transcript items stay in the tab order ahead of the composer.

## Screenshots
- `chat-tab-order.png`
- `tab-order-evidence.json`

## Environment
- Viewport: `390x844` (mobile)
- Browser: Chromium via Selenium
