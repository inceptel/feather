# Bug: Text input and pending files persist when switching sessions

## Status
new

## Severity
high

## Steps to reproduce
1. Open http://localhost:3301/ on mobile (390x844)
2. Open sidebar, select Session A
3. Type some text in the message input field (e.g. "test-text-persistence-bug")
4. Open sidebar, select Session B (a different session)
5. Observe the text input field still contains the text from Session A
6. The Send button is green/active, and pressing it would send the message to Session B

## Expected behavior
When switching sessions, the text input field should be cleared. Any pending file attachments should also be cleared. Each session should start with a fresh, empty composer.

## Actual behavior
Text typed in one session's input field persists when switching to another session. The Send button remains active (green) with the stale text, which could lead to accidentally sending a message to the wrong session.

Additionally, pending file attachments (via the `+` button) would also persist since `setFiles([])` is not called in `select()`.

## Root cause
The `select()` function in App.tsx (line 71-100) resets `currentId`, `messages`, `sidebar`, `loading`, and `cleanupSSE` — but does NOT reset:
- `text` signal (line 41: `setText('')` missing)
- `files` signal (line 43: `setFiles([])` missing)
- `uploading` signal (line 44)

This is the same pattern as the already-filed tab-state-not-reset-on-session-switch issue — the `select()` function needs to reset ALL per-session UI state.

## Fix suggestion
Add to the `select()` function:
```javascript
setText('')
setFiles([])
if (textareaRef) textareaRef.style.height = 'auto'
```

## Screenshots
- text-persists.png — shows "test-text-persistence-bug" text in input field after switching from Session A to Session B (WORKER_NUM=3 session)

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
