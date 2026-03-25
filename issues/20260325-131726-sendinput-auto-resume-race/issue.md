# Bug: sendInput races with session startup when auto-resuming inactive sessions

## Status
new

## Severity
high

## Steps to reproduce
1. Have a session that is inactive (no green dot — no tmux session running)
2. Select that session in the Feather UI
3. Type a message and press Send
4. The frontend calls `POST /api/sessions/:id/send` with the message text

## Expected behavior
The message should be delivered to the claude CLI and processed. The user should see a response.

## Actual behavior
The message is silently lost. Here's what happens server-side:

1. `sendInput()` (server.js:132) checks `tmuxIsActive(id)` — returns false
2. `resumeSession(id)` is called (server.js:133) — creates a new tmux session running `bash --rcfile ~/.bashrc -ic 'claude --resume <id> ...'`
3. `resumeSession` schedules an Enter key for 3 seconds later (line 129) to handle the CLI's initial prompt
4. `sendInput` **immediately** proceeds (line 147) to type the user's message text + Enter into the tmux pane
5. At this point, the tmux pane is still loading: bash is sourcing `.bashrc`, then launching the `claude` binary. The claude CLI hasn't started accepting input yet.
6. The user's text is typed into a shell that isn't ready — text is lost, sent to the shell prompt, or garbled
7. 3 seconds later, the delayed Enter fires (from step 3), hitting Enter on whatever random state the pane is in

The user sees a single checkmark (optimistic UI "sent") that never upgrades to double-check "delivered", and no response ever comes.

## Code references

**Server-side race (server.js:132-150):**
```javascript
function sendInput(id, text) {
  if (!tmuxIsActive(id)) resumeSession(id);  // creates session, returns immediately
  const target = tmuxName(id);
  // ... immediately sends keys, but claude CLI hasn't started yet
  execFileSync('tmux', ['send-keys', '-t', target, '-l', text], { stdio: 'ignore' });
  execFileSync('tmux', ['send-keys', '-t', target, 'Enter'], { stdio: 'ignore' });
}
```

**resumeSession only schedules a delayed Enter (server.js:125-130):**
```javascript
function resumeSession(id, cwd) {
  // ... creates tmux session synchronously ...
  // Delayed Enter fires 3 seconds AFTER sendInput already typed the message
  setTimeout(() => { execFileSync('tmux', ['send-keys', '-t', name, 'Enter'] ...); }, 3000);
}
```

**Timeline for a message to an inactive session:**
```
t=0ms    resumeSession creates tmux with "bash -ic 'claude --resume ...'"
t=1ms    sendInput types user's message + Enter into the loading pane
t=~500ms bash finishes sourcing .bashrc
t=~2000ms claude CLI starts up
t=3000ms delayed Enter from resumeSession fires (but message was already lost at t=1ms)
```

## Impact
- Any message sent to an inactive session is silently lost
- The user gets no error feedback (frontend shows single checkmark, never delivered)
- The session IS resumed (tmux starts), so the user may not realize the message was lost
- If the user refreshes or sends another message, it works fine (session is now active)
- This is the default path when clicking Resume and immediately typing, or when `sendInput` auto-detects an inactive session

## Suggested fix
`sendInput` should wait for the claude CLI to initialize before sending text. Options:
1. Poll the tmux pane contents until claude CLI prompt is detected (e.g., loop checking `tmux capture-pane`)
2. Separate the resume and send flows — return an error to the frontend saying "session is resuming, retry in N seconds"
3. Queue the message and send it after the 3-second initialization timeout

## Screenshots
- session-nomenu.png — Shows session with tool cards and messages (for context)

## Environment
- Server: Node.js, server.js
- All viewports affected (server-side bug)
