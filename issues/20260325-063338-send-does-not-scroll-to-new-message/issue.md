# Bug: Sending a message does not scroll the chat to the new message

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`).
2. Open any long existing session with enough history to scroll.
3. Leave the transcript near the top of the chat.
4. Type a new message and tap `Send`.

## Expected behavior
After send, Feather should auto-scroll the transcript so the newly sent message is visible immediately.

## Actual behavior
The message is sent, the composer clears, and the new message is appended far below the viewport, but the chat scroller stays at the top. On this run the message `resume gate probe` was present in the DOM while the chat container remained at `scrollTop: 0` with `scrollHeight: 2851` and `clientHeight: 706`, so the new bubble landed offscreen until I manually scrolled down.

## Screenshots
- after-send-stuck-at-top.png
- message-exists-at-bottom.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (`agent-browser`)
- URL: `http://localhost:3304/`
