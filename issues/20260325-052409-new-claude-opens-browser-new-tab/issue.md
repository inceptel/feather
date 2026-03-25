# Bug: `+ New Claude` opens the browser new-tab page instead of creating a session

## Status
new

## Severity
high

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`).
2. Tap the hamburger button to open the session drawer.
3. Tap `+ New Claude`.

## Expected behavior
The app should create a new session inside Feather and keep the user on the current app page.

## Actual behavior
The browser leaves Feather and navigates to `chrome://new-tab-page/`, so no new session is created and the user is dropped onto the browser start page.

## Verification
- Reproduced in Chromium via `agent-browser`.
- Confirmed the post-click URL with `location.href === "chrome://new-tab-page/"`.

## Screenshots
- `landing-iter.png`
- `after-new-claude.png`
- `after-new-claude-full.png`

## Environment
- Viewport: `390x844` (mobile)
- Browser: Chromium (`agent-browser`)
- App URL: `http://localhost:3304/`
