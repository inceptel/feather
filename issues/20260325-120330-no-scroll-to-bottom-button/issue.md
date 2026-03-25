# Bug: No scroll-to-bottom button when scrolled up in long conversations

## Status
new

## Severity
medium

## Steps to reproduce
1. Open http://localhost:3301/ on mobile (390x844)
2. Select a session with many messages (e.g. 66+ messages)
3. Scroll up to read earlier messages
4. Look for any way to jump back to the bottom of the conversation

## Expected behavior
A floating "scroll to bottom" button (FAB) should appear when the user scrolls up, allowing one-tap return to the latest messages. This is standard UX in every major chat app (iMessage, WhatsApp, Slack, Telegram).

For active/streaming sessions, there should also be a visual indicator that new messages are arriving below the current scroll position.

## Actual behavior
No scroll-to-bottom button appears. The user must manually scroll through the entire conversation to return to the bottom. In a 66-message session, this requires significant scrolling effort on mobile.

The code tracks `pinned` state (MessageView.tsx:158) — `const [pinned, setPinned] = createSignal(true)` — but this signal is ONLY used to control auto-scroll behavior for new messages. There is no UI element that reads the `pinned` signal to show a scroll-to-bottom indicator or button.

Relevant code in MessageView.tsx:
- Line 158: `const [pinned, setPinned] = createSignal(true)` — tracks bottom-pinned state
- Lines 160-163: `onScroll()` updates pinned based on scroll position (< 80px from bottom)
- Lines 166-171: Auto-scrolls on new messages only if `pinned()` is true
- NO rendering logic anywhere that uses `pinned()` to show a button or indicator

## Impact
- Users lose their place in long conversations with no quick way to return to bottom
- Active sessions may stream new messages while user is scrolled up with no visual indication
- Particularly frustrating on mobile where scroll distance per swipe is limited
- The `pinned` tracking is already implemented — only the UI element is missing

## Screenshots
- scrolled-top.png — scrolled to top of 66-message conversation, no scroll-to-bottom button visible
- session-bottom.png — same session auto-scrolled to bottom, showing the bottom of conversation

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
