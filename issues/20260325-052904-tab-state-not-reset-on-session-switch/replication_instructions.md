# Replication Instructions: Tab state persists when switching sessions

## Bug Summary
When on the Terminal tab and switching to a different session via the sidebar, the Terminal tab stays active instead of resetting to Chat.

## Steps to Reproduce
1. Open Feather at `http://localhost:PORT/` on mobile viewport (390x844)
2. Open sidebar (hamburger menu) and select any session
3. Wait for session to load (Chat/Terminal tabs visible)
4. Click the "Terminal" tab — verify it becomes active (green underline)
5. Click the hamburger menu to reopen the sidebar
6. Select a **different** session from the sidebar
7. Observe: The Terminal tab remains active with green underline, instead of resetting to Chat

## Expected Behavior
After switching sessions, the tab should reset to "Chat" so the user sees the new session's conversation messages.

## Actual Behavior
The Terminal tab stays active after session switch, causing:
- User sees the terminal view instead of chat messages for the new session
- A terminal WebSocket connection is silently opened to the new session

## Root Cause
In the `select()` function (App.tsx), `setTab('chat')` is not called when switching sessions. All other state (currentId, sidebar, loading, messages, SSE) is properly reset.

## Detection Method
The `replicate.sh` script checks the CSS `border-bottom-color` of the Terminal tab button after a session switch. If it's `rgb(74, 186, 106)` (green), the bug is present.

## Reliability
3/3 — confirmed reliable across consecutive runs.
