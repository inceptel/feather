#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

APP_TSX="/home/user/feather-dev/w5/frontend/src/App.tsx"

if [ ! -f "$APP_TSX" ]; then
  echo "BUG PRESENT: missing source file"
  exit 0
fi

if awk '
  /<For each=\{sessions\(\)\}>/ { in_sessions = 1 }
  in_sessions && /<button/ { saw_button = 1 }
  in_sessions && /onClick=\{\(\) => select\(s\.id\)\}/ { saw_select = 1 }
  in_sessions && /aria-current=\{s\.id === currentId\(\) \? '\''page'\'' : undefined\}/ { saw_current = 1 }
  in_sessions && /\{s\.title\}/ { saw_title = 1 }
  in_sessions && /<\/For>/ { exit !(saw_button && saw_select && saw_current && saw_title) }
  END {
    if (!in_sessions) exit 1
    if (!(saw_button && saw_select && saw_current && saw_title)) exit 1
  }
' "$APP_TSX"; then
  echo "BUG ABSENT: session rows are rendered as selectable buttons"
  exit 1
fi

echo "BUG PRESENT: session rows are not implemented as focusable buttons"
exit 0
