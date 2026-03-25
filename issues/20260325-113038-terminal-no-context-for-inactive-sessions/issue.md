# Bug: Terminal tab shows "[disconnected]" with no context for inactive sessions

## Status
new

## Severity
medium

## Steps to reproduce
1. Open http://localhost:3301/ on mobile (390x844)
2. Open sidebar, select any inactive session (one without a green active dot)
3. Click the "Terminal" tab

## Expected behavior
The Terminal tab should show a helpful message explaining that the session is not active, and guide the user to click "Resume" to start the terminal. The blinking cursor should not appear since there's nothing to type into.

## Actual behavior
- The terminal shows only `[disconnected]` in dim grey text at the top
- A green blinking cursor appears below it, suggesting the terminal is ready for input — but it's not
- No explanation of WHY it's disconnected (session is inactive / tmux session doesn't exist)
- No guidance on what to do (e.g., "Click Resume to start this session")
- The user may think the terminal is broken rather than understanding the session needs to be resumed

## Root cause
In `Terminal.tsx` line 62-66, `createEffect` calls `connect(sid)` whenever `props.sessionId` is non-null, regardless of whether the session is active. The WebSocket connects to `/api/terminal?session=<id>`, and the server immediately closes it with "Session not active" (server.js line 349). The terminal's `ws.onclose` handler (line 39) writes `[disconnected]` with no additional context.

There's no check for session activity state before attempting to connect, and no way to display a friendly "session not active" message instead of the raw `[disconnected]` label.

## Additional notes
- The `[disconnected]` text uses ANSI escape codes for dim grey color, rendered inline by the terminal emulator
- The blinking green cursor (configured at Terminal.tsx line 27) is actively misleading — it suggests the terminal is waiting for input
- This affects every inactive session — which is the majority of sessions in the list
- The "Resume" button is visible in the header but the Terminal tab gives no indication that resuming would fix the terminal

## Screenshots
- terminal-inactive.png — Terminal tab showing only "[disconnected]" with blinking cursor
- resume-test.png — The same session's Chat tab showing the Resume button is available

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
