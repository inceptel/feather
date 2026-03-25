#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

MESSAGE_VIEW="/home/user/feather-dev/w5/frontend/src/components/MessageView.tsx"
APP_TSX="/home/user/feather-dev/w5/frontend/src/App.tsx"

PINNED_SIGNAL="$(rg -n -F "const [pinned, setPinned] = createSignal(true)" "$MESSAGE_VIEW" || true)"
ON_SCROLL_GUARD="$(rg -n -F "setPinned(scrollHeight - scrollTop - clientHeight < 80)" "$MESSAGE_VIEW" || true)"
AUTO_SCROLL_EFFECT="$(rg -n -F "if (pinned()) {" "$MESSAGE_VIEW" || true)"
SCROLL_TO_BOTTOM="$(rg -n -F "scrollRef?.scrollTo({ top: scrollRef!.scrollHeight })" "$MESSAGE_VIEW" || true)"
OPTIMISTIC_APPEND="$(rg -n -F "setMessages(prev => [...prev, {" "$APP_TSX" || true)"
SEND_INPUT_CALL="$(rg -n -F "sendInput(currentId()!, fullText)" "$APP_TSX" || true)"

if [ -z "$PINNED_SIGNAL" ] || [ -z "$ON_SCROLL_GUARD" ] || [ -z "$AUTO_SCROLL_EFFECT" ] || [ -z "$SCROLL_TO_BOTTOM" ]; then
  echo "BUG ABSENT: MessageView no longer matches the pinned-only auto-scroll behavior"
  exit 1
fi

if [ -z "$OPTIMISTIC_APPEND" ] || [ -z "$SEND_INPUT_CALL" ]; then
  echo "BUG ABSENT: send flow no longer appends messages through the current optimistic path"
  exit 1
fi

echo "BUG PRESENT: MessageView only scrolls when pinned() is already true, so sending while scrolled near the top leaves the new message offscreen"
printf '%s\n' "$PINNED_SIGNAL"
printf '%s\n' "$ON_SCROLL_GUARD"
printf '%s\n' "$AUTO_SCROLL_EFFECT"
printf '%s\n' "$SCROLL_TO_BOTTOM"
printf '%s\n' "$OPTIMISTIC_APPEND"
printf '%s\n' "$SEND_INPUT_CALL"
exit 0
