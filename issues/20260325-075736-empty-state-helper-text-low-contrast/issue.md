# Bug: Empty-state helper text fails contrast on mobile

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` in Chromium on a mobile viewport (`390x844`).
2. Wait for the landing screen to render without selecting a session.
3. Look at the helper copy near the center of the screen: `Open a session or create a new one`.

## Expected behavior
The primary onboarding instruction should be easy to read on the dark landing screen and meet basic text contrast expectations.

## Actual behavior
The helper copy renders in a very dark gray on a nearly black background, so it is barely legible. A browser-side measurement on the live page reported `rgb(68, 68, 68)` text on `rgb(10, 14, 20)` background, which is about `1.99:1` contrast.

## Screenshots
- iter35-contrast-landing.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
