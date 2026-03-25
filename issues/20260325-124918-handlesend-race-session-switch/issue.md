# Bug: handleSend reads currentId() after async upload — message sent to wrong session

## Status
new

## Severity
high

## Steps to reproduce
1. Open session A on mobile (390x844)
2. Attach an image file (triggers async upload)
3. Click Send — `handleSend()` starts, captures `text()` and `files()` at line 125-126
4. While file is uploading (await uploadFile at line 137), quickly open sidebar and switch to session B
5. `select('B')` runs → `setCurrentId('B')` updates the reactive signal
6. Upload completes, `handleSend` continues to line 148
7. `sendInput(currentId()!, fullText)` reads `currentId()` which is now session B

## Expected behavior
Message should be sent to session A (the session that was active when the user clicked Send).

## Actual behavior
Message is sent to session B because `currentId()` is a reactive signal read at send time (line 148), not at intent time (line 127). The optimistic message appears in session A's message list (added at line 144 before the send), but the actual delivery goes to session B. This creates a ghost message in A and an unexpected message in B.

## Root cause
In `App.tsx` `handleSend()` (lines 124-150):
- Line 127: `currentId()` is checked as a guard
- Lines 135-140: `await uploadFile(f.blob, f.name)` suspends execution
- Line 148: `sendInput(currentId()!, fullText)` — reads `currentId()` AGAIN after the await

The session ID should be captured once at the start:
```typescript
const sessionId = currentId()
if ((!val && !pending.length) || !sessionId) return
// ... upload loop ...
sendInput(sessionId, fullText)
```

## Impact
- Message delivered to wrong session — data integrity issue
- Optimistic UI shows message in original session but delivery goes elsewhere
- User has no indication the message went to the wrong place
- More likely with large images (longer upload time = wider race window)

## Related
- text-input-persists-across-session-switch (different bug — text not cleared on switch)
- send-errors-silently-swallowed (related — no error feedback)

## Screenshots
- session_loaded.png — shows session with Send button and input bar

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
- Code: App.tsx lines 124-150, api.ts line 40-42
