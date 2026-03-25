#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

APP_TSX="${WORKTREE:-/home/user/feather-dev/w5}/frontend/src/App.tsx"

if [ ! -f "$APP_TSX" ]; then
  echo "Missing source file: $APP_TSX"
  exit 1
fi

button_line="$(grep -Fn "<button onClick={() => removeFile(i())}" "$APP_TSX" || true)"

if [ -z "$button_line" ]; then
  echo "BUG ABSENT: preview remove button implementation not found"
  exit 1
fi

if printf '%s\n' "$button_line" | grep -Fq "width: '18px'" \
  && printf '%s\n' "$button_line" | grep -Fq "height: '18px'" \
  && printf '%s\n' "$button_line" | grep -Fq ">&times;</button>" \
  && ! printf '%s\n' "$button_line" | grep -Eq "aria-label|aria-labelledby|title="; then
  echo "BUG PRESENT: preview remove button is 18x18 and unlabeled"
  exit 0
fi

echo "BUG ABSENT: preview remove button no longer matches the reported tiny unlabeled implementation"
exit 1
