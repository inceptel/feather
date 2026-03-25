#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
BASE="http://localhost:${PORT}"
ISSUE_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_TSX="${ISSUE_DIR%/issues/*}/frontend/src/App.tsx"
TARGET_ID="4baa1292-7fdf-4e87-af47-6731e459b3cd"
LIMIT_TEXT="You've hit your limit · resets 5pm (UTC)"

if ! command -v jq >/dev/null 2>&1; then
  echo "BUG ABSENT: jq is required"
  exit 1
fi

if ! command -v rg >/dev/null 2>&1; then
  echo "BUG ABSENT: rg is required"
  exit 1
fi

MESSAGES_JSON="$(curl -fsS "${BASE}/api/sessions/${TARGET_ID}/messages?limit=500")"
LIMIT_COUNT="$(printf '%s' "${MESSAGES_JSON}" | jq --arg text "${LIMIT_TEXT}" '[.messages[] | .. | objects | select(.text? == $text)] | length')"
if [ "${LIMIT_COUNT}" -lt 1 ]; then
  echo "BUG ABSENT: target transcript on ${BASE} does not contain '${LIMIT_TEXT}'"
  exit 1
fi

if ! rg -Fq 'if ((!val && !pending.length) || !currentId()) return' "${APP_TSX}"; then
  echo "BUG ABSENT: handleSend guard changed"
  exit 1
fi

if ! rg -Fq "placeholder=\"Send a message...\"" "${APP_TSX}"; then
  echo "BUG ABSENT: composer textarea no longer present"
  exit 1
fi

if ! rg -Fq "<textarea ref={textareaRef} value={text()}" "${APP_TSX}"; then
  echo "BUG ABSENT: composer textarea markup changed"
  exit 1
fi

if printf '%s' "${MESSAGES_JSON}" | jq -e '.messages | length == 0' >/dev/null; then
  echo "BUG ABSENT: target transcript is empty"
  exit 1
fi

if rg -Fq 'disabled={' "${APP_TSX}" && rg -Fq '<textarea ref={textareaRef} value={text()}' "${APP_TSX}"; then
  TEXTAREA_DISABLED_ATTR="$(python3 - <<'PY' "${APP_TSX}"
from pathlib import Path
import sys
text = Path(sys.argv[1]).read_text()
needle = '<textarea ref={textareaRef} value={text()}'
idx = text.find(needle)
if idx == -1:
    print('missing')
    raise SystemExit(0)
end = text.find('/>', idx)
snippet = text[idx:end if end != -1 else idx+500]
print('disabled' if 'disabled={' in snippet or ' disabled' in snippet else 'enabled')
PY
)"
  if [ "${TEXTAREA_DISABLED_ATTR}" != "enabled" ]; then
    echo "BUG ABSENT: composer textarea now has a disabled state"
    exit 1
  fi
fi

if ! rg -Fq '<button onClick={handleSend} disabled={uploading()}' "${APP_TSX}"; then
  echo "BUG ABSENT: send button disable logic changed"
  exit 1
fi

if rg -n 'limit|rate' "${APP_TSX}" >/dev/null; then
  echo "BUG ABSENT: App.tsx now contains limit-specific logic"
  exit 1
fi

echo "BUG PRESENT: transcript still contains '${LIMIT_TEXT}' and App.tsx keeps the textarea enabled while the send button only disables for uploading()"
exit 0
