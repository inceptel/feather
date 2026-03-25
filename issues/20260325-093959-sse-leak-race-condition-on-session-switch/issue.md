# Bug: SSE connection leak and cross-session message contamination on rapid session switching

## Status
new

## Severity
high

## Steps to reproduce
1. Open Feather on any viewport
2. Open the sidebar and rapidly click between two different sessions (A then B) before A finishes loading
3. Wait for new messages to arrive in session A (e.g., from an active Claude session)

## Expected behavior
- Only session B's messages should be displayed
- Session A's SSE connection should be cleaned up
- No messages from session A should appear in session B's view

## Actual behavior
- Session A's SSE connection is never closed (leaked)
- Messages from session A can appear in session B's chat view
- Brief flash of session A's messages before B's messages load
- Each rapid session switch leaks one additional SSE connection

## Root cause analysis

In `App.tsx:77-106`, the `select()` function is `async` with an `await` at line 84:

```typescript
async function select(id: string) {
    setCurrentId(id)
    // ...
    cleanupSSE?.()                                    // line 83
    try { setMessages(await fetchMessages(id)) } catch {}  // line 84 — AWAIT
    setLoading(false)
    cleanupSSE = subscribeMessages(id, (msg) => {     // line 86
      setMessages(prev => { ... return [...prev, msg] })
    })
}
```

**Race sequence when clicking A then B rapidly:**

1. `select(A)` runs: calls `cleanupSSE?.()` (cleans up previous), then pauses at `await fetchMessages(A)`
2. `select(B)` runs while A is paused: calls `cleanupSSE?.()` — but this is the OLD value (from before A), not A's cleanup (A hasn't set it yet at line 86)
3. `fetchMessages(A)` resolves: calls `setMessages(A's data)` (WRONG — user is viewing B), then `cleanupSSE = subscribeMessages(A, callback)`
4. `fetchMessages(B)` resolves: calls `setMessages(B's data)` (correct), then `cleanupSSE = subscribeMessages(B, callback)` — **overwrites A's cleanup reference**

**Result:** Session A's SSE is orphaned. Its callback keeps calling `setMessages()`, injecting A's new messages into B's view indefinitely.

**Three bugs in one:**
1. **SSE connection leak** — orphaned EventSource connections accumulate with each rapid switch
2. **Cross-session message contamination** — leaked SSE callbacks append messages from wrong sessions
3. **Stale fetch results** — no cancellation mechanism means the first fetch's `setMessages` overwrites the second session's empty state

## Suggested fix
Add an AbortController or session ID guard:
```typescript
let selectGeneration = 0
async function select(id: string) {
    const gen = ++selectGeneration
    setCurrentId(id)
    cleanupSSE?.()
    cleanupSSE = null
    setMessages([])
    setLoading(true)
    try {
      const msgs = await fetchMessages(id)
      if (gen !== selectGeneration) return  // stale — bail out
      setMessages(msgs)
    } catch {}
    if (gen !== selectGeneration) return
    setLoading(false)
    cleanupSSE = subscribeMessages(id, ...)
}
```

## Screenshots
- session.png — showing the app with a session loaded

## Environment
- Viewport: any
- Browser: Chromium (agent-browser)
- File: frontend/src/App.tsx lines 77-106
