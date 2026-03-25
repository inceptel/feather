# Bug: Long sessions silently truncated to 100 messages with no pagination

## Status
new

## Severity
medium

## Steps to reproduce
1. Open http://localhost:3301/ on mobile (390x844)
2. Select a session with a long conversation (e.g., "worker 4 probe" or the current worker 1 session)
3. Scroll to the top of the conversation
4. Notice the conversation starts abruptly — no "load more" button, no truncation indicator

## Expected behavior
- All messages in the session should be accessible
- If messages are paginated, there should be a "load more" or "scroll to load older" mechanism
- At minimum, the UI should indicate that older messages exist but aren't shown

## Actual behavior
- The server's `getMessages()` function applies `msgs.slice(-limit)` with a default limit of 100
- Sessions with >100 messages silently drop the oldest messages
- The frontend renders whatever it receives with no indication of truncation
- Users cannot access the beginning of long conversations

## Impact
Checked the 100 most recent sessions:
- **4 sessions** have more than 100 messages and are affected
- Worst case: session `9acf54e8` has **388 messages** — 288 are dropped, losing 17 minutes of conversation history (06:43–07:00)
- Another case: session `4baa1292` (worker 4 probe) has 105 messages, losing 5

## Root cause
- `server.js` → `getMessages()`: `return msgs.slice(-limit)` with `limit = 100`
- `App.tsx` → `select()`: `setMessages(await fetchMessages(id))` — no pagination parameter
- No API parameter to request older messages or a different page
- No frontend UI for loading earlier messages

## Screenshots
- top-of-truncated-session.png — shows the abrupt start of the worker 4 probe session at 05:52 AM with no indication that earlier messages exist

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
