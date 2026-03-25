# Bug: EventSource has no onerror handler — no disconnection feedback to user

## Status
new

## Severity
medium

## Description
The `subscribeMessages()` function in `api.ts` creates an EventSource for live message streaming but never sets an `onerror` handler. When the SSE connection drops (network failure, server restart, timeout), the user receives zero visual feedback — the chat appears frozen with no indication that messages are no longer arriving.

## Code location
`frontend/src/api.ts` lines 66-70:
```typescript
export function subscribeMessages(id: string, onMessage: (msg: Message) => void): () => void {
  const es = new EventSource(`${BASE}/api/sessions/${id}/stream`)
  es.addEventListener('message', (e) => { try { onMessage(JSON.parse(e.data)) } catch {} })
  return () => es.close()
}
```

No `es.onerror` callback. No way to pass an error/disconnect callback to the caller. The `App.tsx` caller (line 86) has no mechanism to detect or display connection state.

## Steps to reproduce
1. Open a session with active streaming
2. Kill the server or simulate network disconnection
3. Observe the UI — no error banner, no "reconnecting" indicator, no change at all

## Expected behavior
- When SSE connection drops: show a "Reconnecting..." or "Connection lost" indicator
- When EventSource gives up (readyState = CLOSED): show a persistent error banner with retry option
- Connection state should be reflected in the UI (e.g., header icon, toast notification)

## Actual behavior
- Chat silently stops updating
- User sees a frozen conversation with no indication anything is wrong
- No distinction between "assistant is thinking" and "connection is dead"
- If EventSource auto-reconnect succeeds, messages during the gap are already lost (see related issue: sse-reconnect-drops-messages)

## Impact
- Users may wait indefinitely for a response that will never arrive
- Active sessions appear dead when the connection drops
- Combined with sse-reconnect-drops-messages, even successful reconnection silently loses messages
- No way for user to know they need to refresh or take action

## Related issues
- sse-reconnect-drops-messages — server ignores Last-Event-ID (message loss on reconnect)
- sse-leak-race-condition-on-session-switch — leaked SSE connections on rapid session switch

## Environment
- Viewport: any
- Browser: any (EventSource onerror is standard)
