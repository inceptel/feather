# Bug: No interrupt/stop button for active sessions

## Status
new

## Severity
high

## Steps to reproduce
1. Open http://localhost:PORT/ on mobile (390x844)
2. Open a session that is currently active (has green dot indicator)
3. Look at the header area for session controls

## Expected behavior
An active session should have a Stop/Interrupt button to cancel the running Claude process. The backend API (`POST /api/sessions/:id/interrupt`) and client function (`interruptSession` in api.ts) both exist and work — the server sends Ctrl-C via tmux to stop the running process.

## Actual behavior
When a session is active (`isActive === true`), the header shows only the green dot and title — NO action buttons at all. The Resume button is conditionally hidden (`<Show when={!s().isActive}>`) for active sessions but nothing replaces it.

The `interruptSession` function in `api.ts` (line 53) is:
- Defined but never imported in App.tsx
- Never called anywhere in the UI
- The server endpoint at line 284-287 of server.js works (sends `tmux send-keys C-c`)

This means users have no way to stop a runaway Claude session from the UI. They must either:
- Wait for it to finish
- Close the browser tab (which doesn't stop the process)
- Manually use tmux commands

## Code evidence

**api.ts line 53** — function defined but never used:
```typescript
export const interruptSession = (id: string) =>
  fetch(`${BASE}/api/sessions/${id}/interrupt`, { method: 'POST' })
```

**App.tsx line 1** — `interruptSession` not imported:
```typescript
import { fetchSessions, fetchMessages, subscribeMessages, sendInput, createSession, resumeSession, uploadFile } from './api'
```

**App.tsx lines 232-234** — Resume shown only for inactive, nothing for active:
```tsx
<Show when={!s().isActive}>
  <button onClick={() => handleResume(s().id)} ...>Resume</button>
</Show>
```

**server.js lines 284-287** — backend works:
```javascript
app.post('/api/sessions/:id/interrupt', (req, res) => {
  try { execFileSync('tmux', ['send-keys', '-t', tmuxName(req.params.id), 'C-c'], { stdio: 'ignore' }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
```

## Impact
- Users cannot stop a misbehaving or unwanted Claude operation
- Dead code: the interrupt API exists but is inaccessible
- Critical for mobile users who can't access tmux directly

## Screenshots
- header-with-resume.png — Shows the "Resume" button for an inactive session. For active sessions, this area would be empty with no controls at all.

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
