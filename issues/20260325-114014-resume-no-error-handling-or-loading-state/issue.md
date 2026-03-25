# Bug: Resume button has no error handling, loading state, or server-side validation

## Status
new

## Severity
high

## Steps to reproduce
1. Open http://localhost:3301/ on any viewport
2. Select an inactive session (one without the green dot)
3. Click the green "Resume" button in the header
4. Observe: no loading indicator, button stays clickable during async operation
5. If the server is down or returns an error, nothing happens — no error shown

To trigger an actual failure:
- Call `POST /api/sessions/nonexistent-id/resume` — server returns `{"ok": true}` with 200 status
- A tmux session is spawned for the bogus ID; `claude --resume` fails silently inside tmux

## Expected behavior
1. Resume button should show a loading/disabled state while the resume operation is in progress (like `+ New Claude` does with `creating` state)
2. If the resume fails (server error, network failure), an error should be shown to the user
3. Server should validate the session ID exists before attempting to resume
4. The `resumeSession` API client should check `r.ok` and throw on non-2xx responses

## Actual behavior
1. **No loading state**: `handleResume` (App.tsx:118-122) has no loading signal — button stays fully interactive during the async operation. Compare with `handleNew` (lines 108-116) which properly uses `setCreating(true/false)` and `try/catch/finally`.
2. **No error handling**: `handleResume` has no `try/catch`. If `resumeSession()`, `fetchSessions()`, or `select()` throw, it becomes an unhandled promise rejection. The UI provides zero feedback.
3. **API client doesn't check response**: `resumeSession` in api.ts (line 50-51) returns the raw `fetch()` Response without checking `r.ok`. HTTP 500 errors are silently ignored.
4. **Server accepts any session ID**: Server's `/api/sessions/:id/resume` (server.js:279-281) calls `resumeSession()` without validating the session ID exists. It spawns a tmux session for any ID, and `claude --resume <bad-id>` fails silently inside tmux.
5. **Double-click vulnerability**: No guard against clicking Resume twice. Two tmux sessions could be spawned for the same session.

## Code references

**Frontend — no error handling (App.tsx:118-122):**
```typescript
async function handleResume(id: string) {
  await resumeSession(id)           // no try/catch, no loading state
  setSessions(await fetchSessions()) // can throw, unhandled
  select(id)                         // can throw, unhandled
}
```

Compare with handleNew (App.tsx:108-116) which DOES have proper error handling:
```typescript
async function handleNew() {
  setCreating(true)                  // ← loading state
  try {
    const id = await createSession()
    select(id)
    fetchSessions().then(s => setSessions(s)).catch(() => {})
  } catch (e) { console.error(e) }  // ← error handling
  finally { setCreating(false) }     // ← cleanup
}
```

**API client — no response check (api.ts:50-51):**
```typescript
export const resumeSession = (id: string, cwd?: string) =>
  fetch(`${BASE}/api/sessions/${id}/resume`, { method: 'POST', ... })
  // ← returns raw Response, never checks r.ok
```

**Server — no ID validation (server.js:125-130, 279-281):**
```javascript
function resumeSession(id, cwd) {
  // No check that id is a valid session
  execSync(`tmux new-session -d -s ${name} ...`)  // spawns for any id
}
```

## Verified
- Confirmed server returns `{"ok": true}` (HTTP 200) for `POST /api/sessions/nonexistent-session-id/resume`
- Confirmed tmux session `feather-nonexist` was created for the bogus ID
- Confirmed `handleResume` has no try/catch via code inspection
- Confirmed no loading state signal exists for the Resume flow

## Screenshots
- resume-button.png — Shows Resume button visible in header for inactive session

## Environment
- Viewport: 1280x800 (desktop) and 390x844 (mobile)
- Browser: Chromium (agent-browser)
