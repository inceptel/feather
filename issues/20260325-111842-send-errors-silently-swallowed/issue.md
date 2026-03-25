# Bug: Message send failures are silently swallowed — no error feedback to user

## Status
new

## Severity
high

## Steps to reproduce
1. Open any session in Feather
2. Send a message to a session whose tmux process has died or doesn't exist
3. Observe the optimistic message appears with single checkmark (✓)
4. Wait indefinitely — no error indication ever appears

## Expected behavior
- If the send request fails (HTTP 500 from server), the message should show an error state (e.g., red "failed" indicator, retry button, or error toast)
- The user should be informed that their message was not delivered

## Actual behavior
- `sendInput()` is called fire-and-forget in App.tsx line 148: `sendInput(currentId()!, fullText)` — no `await`, no `.catch()`
- The returned Promise is completely ignored
- Even if the server returns HTTP 500 with `{ error: "..." }`, nobody reads the response
- Additionally, `sendInput` in api.ts (line 40-42) does `.then(r => r.json())` without checking `r.ok`, so HTTP errors don't throw
- The optimistic message stays permanently with a single checkmark (✓ "sent") status
- The double checkmark (✓✓ "delivered") never appears because the SSE stream never delivers the real message
- No error toast, no retry mechanism, no visual indication of failure
- User believes their message was sent when it actually wasn't

## Code evidence

**api.ts lines 40-42** — no `r.ok` check:
```js
export const sendInput = (id: string, text: string): Promise<{ ok: boolean, sentAt: string }> =>
  fetch(`${BASE}/api/sessions/${id}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
    .then(r => r.json())
```

**App.tsx line 148** — fire-and-forget, no error handling:
```js
sendInput(currentId()!, fullText)
```

**server.js lines 274-276** — server properly returns errors, but client ignores them:
```js
app.post('/api/sessions/:id/send', (req, res) => {
  try { sendInput(req.params.id, req.body.text); res.json({ ok: true, sentAt: new Date().toISOString() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
```

## Impact
- Silent data loss — user's message is lost without any indication
- Particularly bad on mobile where network failures are more common
- Broken optimistic UI contract — the single checkmark implies "sent" but message may never arrive

## Screenshots
- send-ui.png — shows the Send button and input bar in the session view

## Environment
- Viewport: any (desktop and mobile)
- Browser: Chromium (agent-browser)
