# Bug: Mobile landing screen lacks a main landmark

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`).
2. Wait for Feather to finish loading the empty landing state.
3. Inspect the primary content structure.

## Expected behavior
The landing screen should expose a primary content landmark such as `<main>` or `role="main"` so assistive technology users can jump directly to the empty-state content.

## Actual behavior
The empty landing screen renders only generic `div` containers for its main pane and empty-state body. In the current implementation, the `Select a session` header and `Open a session or create a new one` body are mounted under plain `div` wrappers, and there is no `<main>` or `role="main"` landmark for the primary content area.

## Screenshots
- landing-main-landmark.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (`agent-browser`)
- Supporting code path: `frontend/src/App.tsx` renders the empty-state content inside plain `div` containers around lines 223-257
