# Bug: createSession ignores server errors — navigates to phantom session

## Status
new

## Severity
high

## Steps to reproduce
1. Open http://localhost:3301/ on mobile (390x844)
2. Open sidebar, tap "+ New Claude"
3. If `spawnSession` fails on the server (e.g., tmux unavailable, execSync throws), the server returns HTTP 500
4. Client navigates to the UUID as if session was created successfully

## Expected behavior
- If session creation fails, the UI should show an error message
- The user should NOT be navigated to a non-existent session
- The `createSession` API function should throw on HTTP error responses

## Actual behavior
- `createSession()` (api.ts:44-48) generates a UUID client-side, sends POST, and **ignores the server response entirely** — never checks `r.ok`
- If server returns HTTP 500, the function still returns the UUID
- `handleNew()` (App.tsx:108-116) has try/catch, but it only catches network errors (fetch throws), NOT HTTP 500 (fetch resolves with error status)
- `select(id)` navigates to the phantom session
- `fetchMessages` returns `{messages: []}` for non-existent sessions (verified: server returns 200 with empty array)
- User sees empty chat with no error indication
- Sending messages silently fails (sendInput tries to find tmux session that doesn't exist)

## Code evidence

**api.ts:44-48** — createSession never checks r.ok:
```javascript
export async function createSession(cwd?: string): Promise<string> {
  const id = crypto.randomUUID()
  await fetch(`${BASE}/api/sessions`, { method: 'POST', ...body })
  // ← response ignored, r.ok never checked
  return id  // ← returns UUID even on HTTP 500
}
```

**server.js:269-272** — server correctly returns 500 on failure:
```javascript
app.post('/api/sessions', (req, res) => {
  try { spawnSession(req.body.id, req.body.cwd); res.json({ id: req.body.id, status: 'starting' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
```

**Contrast with fetchSessions/fetchMessages** which DO check r.ok:
```javascript
export async function fetchSessions(): Promise<SessionMeta[]> {
  const r = await fetch(`${BASE}/api/sessions`)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)  // ← proper check
  return (await r.json()).sessions
}
```

## Additional context
- Same pattern exists in `uploadFile` (api.ts:56-64) — doesn't check r.ok, returns `undefined` path on server error
- The `handleNew` try/catch gives false security — it won't catch HTTP 500 since fetch resolves successfully
- Client-side UUID generation means the session ID is orphaned on server failure with no cleanup

## Screenshots
- new-sidebar.png — the "+ New Claude" button that triggers createSession

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
