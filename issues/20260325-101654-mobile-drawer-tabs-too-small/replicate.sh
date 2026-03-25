#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

APP_TSX="/home/user/feather-dev/w5/frontend/src/App.tsx"
SOURCE_SESSIONS_PRESENT=0
SOURCE_LINKS_PRESENT=0
SOURCE_SMALL_TAB_STYLE=0
SOURCE_TAB_BUTTONS_PRESENT=0

rg -Fq '"Sessions"' "$APP_TSX" && SOURCE_SESSIONS_PRESENT=1
rg -Fq '"Links"' "$APP_TSX" && SOURCE_LINKS_PRESENT=1
rg -Fq "padding: '6px 16px'" "$APP_TSX" && SOURCE_SMALL_TAB_STYLE=1
if [ "$SOURCE_SESSIONS_PRESENT" -eq 1 ] && [ "$SOURCE_LINKS_PRESENT" -eq 1 ]; then
  SOURCE_TAB_BUTTONS_PRESENT=1
fi

if [ "$SOURCE_TAB_BUTTONS_PRESENT" -eq 1 ] && [ "$SOURCE_SMALL_TAB_STYLE" -eq 1 ]; then
  echo "BUG PRESENT: source defines Sessions/Links tabs with 6px vertical padding, which keeps the mobile touch target below 44px"
  exit 0
fi

echo "BUG ABSENT: source_flags=sessions:$SOURCE_SESSIONS_PRESENT links:$SOURCE_LINKS_PRESENT small_tab_style:$SOURCE_SMALL_TAB_STYLE"
exit 1
