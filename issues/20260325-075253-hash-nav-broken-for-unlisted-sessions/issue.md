# Bug: Hash URL navigation broken for sessions outside top 50

## Status
new

## Severity
medium

## Steps to reproduce
1. Open http://localhost:3301/ on mobile (390x844)
2. Navigate directly to a session URL via hash (e.g., `http://localhost:3301/#549bddbd-df9b-46a6-9cc4-13712ad51ad6`)
3. The session must be an older session NOT in the top 50 most recent sessions returned by the API

## Expected behavior
- Session messages load
- Header shows session title (e.g., "WORKER_NUM=2 WORKTR...")
- Resume button appears for stopped sessions
- Session active status is known

## Actual behavior
- Session messages DO load correctly (messages are fetched directly by ID)
- Header shows "Select a session" instead of the session title
- Resume button is missing
- No way to interact with or resume the session
- Session is not highlighted in sidebar (because it's not listed)

## Root cause
In `App.tsx` line 146: `const cur = () => sessions().find(s => s.id === currentId())`

`cur()` looks up the session in the `sessions()` signal, which only contains the top 50 sessions from `discoverSessions(50)` in `server.js` line 51. When a hash URL references a session outside this top 50, `cur()` returns `undefined`, causing the header `<Show when={cur()}>` (line 197) to render the fallback "Select a session" text.

The `select()` function (line 71) correctly fetches messages for ANY valid session ID, so message content renders. But the UI metadata (title, Resume button, active status) depends on the session being in the pre-fetched list.

## Impact
- Users sharing session URLs to older sessions get a degraded experience
- Sessions older than the top 50 are only accessible via URL — no sidebar search, no "load more", no pagination
- When accessed via URL, the session has no title, no Resume button, no active status indicator

## Fix suggestions
1. When `select(id)` is called for a session not in `sessions()`, fetch that session's metadata separately via a new API endpoint (e.g., `GET /api/sessions/:id`)
2. Or: add the fetched session to the local `sessions()` list so `cur()` can find it
3. Long-term: add session search or "load more" to the sidebar

## Screenshots
- hash-nav-unlisted.png — Session loaded via hash URL but NOT in top 50: header shows "Select a session", no Resume button
- hash-nav-listed.png — Session loaded via hash URL that IS in top 50: header shows title, Resume button visible

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
