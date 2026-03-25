# Bug: Mobile empty state offers no visible way to create a session

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`).
2. Wait for the landing screen to finish rendering.
3. Look at the main pane content under the header.

## Expected behavior
The empty state should include a visible primary action for creating a session or opening the composer so the user can act on the prompt.

## Actual behavior
The main pane only shows the text `Open a session or create a new one` and no visible button, composer, or other create-session control. The accessibility snapshot for this state exposes only the hamburger button, so the screen offers no direct way to do what the copy instructs.

## Screenshots
- landing-empty-state.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (`agent-browser`)
- URL: `http://localhost:3304/`
