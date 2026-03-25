# Bug: Selecting a session on worker 4 can navigate the app to another worker's port

## Status
new

## Severity
high

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`).
2. Open the session drawer.
3. Tap an existing session from the list. In my repro, tapping `hello old friend` from the drawer on worker 4 navigated away from worker 4.

## Expected behavior
Selecting a session should keep the user inside the current Feather instance on `http://localhost:3304/` and only change the in-app session state.

## Actual behavior
The browser leaves worker 4 entirely. After tapping a drawer item from `http://localhost:3304/`, `location.href` changed to `http://localhost:3301/`, so the user is silently moved into a different worker's app.

## Verification
- Before tapping the session, the app was open on `http://localhost:3304/`.
- After tapping the session, `agent-browser --session-name iter6 eval 'location.href'` returned `http://localhost:3301/`.

## Screenshots
- iter6.png
- cross-port-session.png

## Environment
- Viewport: `390x844` (mobile)
- Browser: Chromium (`agent-browser`)
