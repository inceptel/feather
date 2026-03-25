1. Open [frontend/src/components/MessageView.tsx](/home/user/feather-dev/w5/frontend/src/components/MessageView.tsx) and inspect the scroll logic.
2. `onScroll()` recalculates `pinned` as `scrollHeight - scrollTop - clientHeight < 80`, so scrolling up in a long transcript marks the view as not pinned to the bottom.
3. The render effect only calls `scrollRef?.scrollTo({ top: scrollRef!.scrollHeight })` inside `if (pinned())`, which means new messages do not force an auto-scroll once the user is away from the bottom.
4. Open [frontend/src/App.tsx](/home/user/feather-dev/w5/frontend/src/App.tsx) and inspect `handleSend()`.
5. That send path appends the new optimistic user message with `setMessages(prev => [...prev, { ... }])` and then calls `sendInput(...)`, but it never resets `pinned` or explicitly scrolls the transcript after send.
6. The bug is present because a user who leaves the transcript near the top will send a new message into the list, but `MessageView` suppresses the auto-scroll that would reveal it.
