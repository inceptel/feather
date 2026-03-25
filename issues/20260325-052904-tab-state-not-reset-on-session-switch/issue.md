# Bug: Tab state persists when switching sessions — Terminal tab stays active

## Status
new

## Severity
medium

## Steps to reproduce
1. Open http://localhost:3301/ on mobile (390x844)
2. Select a session (e.g., "hello old friend") — Chat tab loads
3. Click the "Terminal" tab — terminal connects
4. Open the sidebar and select a different session
5. Observe: the Terminal tab stays active instead of resetting to Chat

## Expected behavior
When switching to a new session, the tab should reset to "Chat" so the user sees the conversation messages of the new session.

## Actual behavior
The tab stays on "Terminal", so the user sees a terminal connection to the NEW session's tmux instead of the chat messages. This is confusing because:
- The user expects to see chat content when opening a new session
- A terminal WebSocket connection is silently opened to the new session
- The user must manually click "Chat" to see messages

## Root cause (from code review)
In `App.tsx` line 71, the `select()` function resets `currentId`, `sidebar`, `loading`, and `messages` — but does NOT call `setTab('chat')`:

```typescript
async function select(id: string) {
    setCurrentId(id)      // ✓ updated
    location.hash = id    // ✓ updated
    setSidebar(false)     // ✓ closed
    setLoading(true)      // ✓ set
    setMessages([])       // ✓ cleared
    cleanupSSE?.()        // ✓ cleaned up
    // ✗ MISSING: setTab('chat')
    ...
}
```

Additionally, `Terminal.tsx` receives `sessionId={tab() === 'terminal' ? currentId() : null}`, so when tab stays 'terminal', it immediately connects to the new session's terminal WebSocket.

## Fix suggestion
Add `setTab('chat')` at the start of the `select()` function.

## Screenshots
- terminal-tab.png — Terminal tab active on "hello old friend" session
- session-loaded.png — Chat tab with messages loaded (expected view after session switch)

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
- File: frontend/src/App.tsx, line 71 (`select` function)
