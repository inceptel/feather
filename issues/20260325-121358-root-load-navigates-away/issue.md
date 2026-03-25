# Bug: Opening worker root can immediately navigate away from Feather

## Status
new

## Severity
high

## Steps to reproduce
1. Open `http://localhost:3304/` in a fresh mobile browser session at `390x844`.
2. Wait for the initial load to settle without tapping anything.

## Expected behavior
Feather should stay on `http://localhost:3304/` and show either the worker 4 landing state or a worker 4 session.

## Actual behavior
Feather can leave the worker entirely during initial load. In one fresh session the page ended on `http://localhost:3305/`. In a second fresh session it ended on `chrome://new-tab-page/`, showing Chrome's new tab UI instead of Feather, before any user interaction.

## Screenshots
- iter-start.png
- root-redirect-repro.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (`agent-browser`)
- Worker URL under test: `http://localhost:3304/`
