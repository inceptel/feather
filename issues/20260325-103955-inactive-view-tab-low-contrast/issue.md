# Bug: Inactive Chat/Terminal tab label is too low-contrast on mobile

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf` on mobile at `390x844`.
2. Observe the view switcher under the header while `Chat` is active.
3. Tap `Terminal`.
4. Observe the same view switcher again with `Terminal` active.

## Expected behavior
The inactive tab label should still meet mobile text contrast guidance so users can easily identify and switch views.

## Actual behavior
Whichever view is inactive is rendered in `rgb(102, 102, 102)` at `13px` on a `rgb(10, 14, 20)` background, which is about `3.37:1` contrast. That falls below WCAG AA's `4.5:1` requirement for normal text and makes the secondary view label hard to read on mobile.

## Screenshots
- chat-tab-contrast.png
- terminal-tab-contrast.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium via Selenium
