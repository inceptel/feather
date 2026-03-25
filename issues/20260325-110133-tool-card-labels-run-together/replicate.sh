#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

FILE="/home/user/feather-dev/w5/frontend/src/components/MessageView.tsx"

if [ ! -f "$FILE" ]; then
  echo "Source file missing: $FILE"
  exit 1
fi

if rg -Fq "<span style={{ color }}>{icon} {name}</span>" "$FILE" \
  && rg -Fq "{summary && <span style={{ color: '#888', 'margin-left': '8px' }}>{summary}</span>}" "$FILE"
then
  echo "BUG PRESENT: tool-card header separates label and summary only with CSS margin, so text collapses to values like Editconf.d/supervisord.conf."
  exit 0
fi

echo "BUG ABSENT: tool-card header no longer matches the concatenated-label pattern."
exit 1
