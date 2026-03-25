#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

ROOT="/home/user/feather-dev/w5"
MESSAGE_VIEW_TSX="$ROOT/frontend/src/components/MessageView.tsx"
ISSUE_SCREENSHOT="$ROOT/issues/20260325-085719-inline-code-overflows-mobile-chat/inline-code-overflow.png"

HAS_INLINE_CODE_RULE=0
HAS_UNWRAPPED_INLINE_CODE=0
HAS_BUBBLE_OVERFLOW_HIDDEN=0
HAS_BUBBLE_MAX_WIDTH=0
HAS_MARKDOWN_RENDERER=0
HAS_EVIDENCE_SCREENSHOT=0

rg -Fq ".markdown code {" "$MESSAGE_VIEW_TSX" && HAS_INLINE_CODE_RULE=1
if rg -Uzo '\.markdown code \{[^}]*font-family: .*monospace;[^}]*font-size: 0\.88em;[^}]*\}' "$MESSAGE_VIEW_TSX" >/dev/null; then
  if ! rg -Uzo '\.markdown code \{[^}]*(white-space|overflow-wrap|word-break|word-wrap)[^}]*\}' "$MESSAGE_VIEW_TSX" >/dev/null; then
    HAS_UNWRAPPED_INLINE_CODE=1
  fi
fi
rg -Fq "color: '#e5e5e5', overflow: 'hidden'," "$MESSAGE_VIEW_TSX" && HAS_BUBBLE_OVERFLOW_HIDDEN=1
rg -Fq "'max-width': '85%'" "$MESSAGE_VIEW_TSX" && HAS_BUBBLE_MAX_WIDTH=1
rg -Fq "return <div class=\"markdown\" innerHTML={renderMarkdown(block.text)} />" "$MESSAGE_VIEW_TSX" && HAS_MARKDOWN_RENDERER=1
[ -f "$ISSUE_SCREENSHOT" ] && HAS_EVIDENCE_SCREENSHOT=1

if [ "$HAS_INLINE_CODE_RULE" -eq 1 ] && \
   [ "$HAS_UNWRAPPED_INLINE_CODE" -eq 1 ] && \
   [ "$HAS_BUBBLE_OVERFLOW_HIDDEN" -eq 1 ] && \
   [ "$HAS_BUBBLE_MAX_WIDTH" -eq 1 ] && \
   [ "$HAS_MARKDOWN_RENDERER" -eq 1 ] && \
   [ "$HAS_EVIDENCE_SCREENSHOT" -eq 1 ]; then
  echo "BUG PRESENT: inline markdown code is styled without any wrap rule while chat bubbles cap width at 85% and hide overflow, so long inline code clips on mobile"
  exit 0
fi

echo "BUG ABSENT: inline_rule=$HAS_INLINE_CODE_RULE unwrapped=$HAS_UNWRAPPED_INLINE_CODE bubble_hidden=$HAS_BUBBLE_OVERFLOW_HIDDEN bubble_width=$HAS_BUBBLE_MAX_WIDTH markdown_renderer=$HAS_MARKDOWN_RENDERER screenshot=$HAS_EVIDENCE_SCREENSHOT"
exit 1
