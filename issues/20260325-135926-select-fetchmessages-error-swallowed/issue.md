# Bug: select() swallows fetchMessages errors — blank chat with no feedback

## Status
new

## Severity
medium

## Description

The `select()` function in App.tsx (line 84) catches and silently discards any error from `fetchMessages()`. When the API call fails (server down, session file deleted, network error, 500 from server), the user sees an empty chat area with no error message, no retry option, and no indication that anything went wrong.

## Steps to reproduce
1. Open Feather and select any session
2. If the `/api/sessions/:id/messages` endpoint returns a non-200 status or the network request fails:
   - Messages array stays empty (cleared on line 82)
   - Loading indicator disappears (line 85)
   - SSE subscription still starts (line 86), making the session appear "connected"
3. User sees blank white chat area — indistinguishable from a session that genuinely has no messages

## Code location

`frontend/src/App.tsx` lines 77-106:
```js
async function select(id: string) {
    setCurrentId(id)
    location.hash = id
    setSidebar(false)
    setLoading(true)
    setMessages([])     // ← clears messages
    cleanupSSE?.()
    try { setMessages(await fetchMessages(id)) } catch {}  // ← empty catch
    setLoading(false)   // ← loading disappears regardless
    cleanupSSE = subscribeMessages(id, (msg) => { ... })    // ← SSE starts regardless
}
```

`fetchMessages()` in `api.ts` (line 34-38) correctly throws on non-200 responses:
```js
export async function fetchMessages(id: string): Promise<Message[]> {
  const r = await fetch(`${BASE}/api/sessions/${id}/messages`)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return (await r.json()).messages
}
```

## Impact

- **Silent data loss**: User has no way to know messages failed to load
- **Misleading UI**: Blank chat looks like an empty session, not a failure
- **No recovery path**: No retry button, no error banner, no way to trigger re-fetch
- **SSE still starts**: The session appears "live" despite failed initial load, so new messages may appear without historical context
- **Compounds with other bugs**: Combined with getmessages-sync-read-blocks-event-loop (issue #39), large sessions that timeout or crash the server show nothing

## Expected behavior

Display an error state when fetchMessages fails — e.g., "Failed to load messages. Tap to retry." Allow the user to retry or at minimum understand that something went wrong.

## Environment
- Frontend: SolidJS, App.tsx
- API: server.js /api/sessions/:id/messages
