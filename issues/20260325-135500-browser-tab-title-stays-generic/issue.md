# Bug: Browser tab title stays generic instead of reflecting the current view

## Status
new

## Severity
low

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`).
2. Wait for the landing screen to settle and inspect the page title.
3. Open `http://localhost:3304/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf` and inspect the page title again after the transcript loads.

## Expected behavior
The browser tab title should describe the current Feather view, such as the landing screen on the root route and the selected session when a transcript is open.

## Actual behavior
The page title stays the generic `Feather` in both states. Even after loading a specific transcript directly by hash, Selenium still reported `document.title` as `Feather`, so browser tabs and history entries do not distinguish one session from another.

## Screenshots
- landing-title-check.png
- session-title-check.png

## Environment
- Viewport: `390x844` (mobile)
- Browser: Chromium (Selenium mobile emulation)
- URLs under test:
  - `http://localhost:3304/`
  - `http://localhost:3304/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf`
