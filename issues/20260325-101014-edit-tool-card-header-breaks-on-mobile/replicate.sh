#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

ROOT="${WORKTREE:-/home/user/feather-dev/w5}"
FILE="$ROOT/frontend/src/components/MessageView.tsx"

if [ ! -f "$FILE" ]; then
  echo "Missing renderer source: $FILE"
  exit 1
fi

python3 - "$FILE" <<'PY'
import pathlib
import re
import sys

src = pathlib.Path(sys.argv[1]).read_text()

edit_summary_is_single_string = re.search(
    r"case 'Edit': return short \+ \(input\.replace_all \? ' ×all' : ''\)",
    src,
)
summary_renders_in_one_span = re.search(
    r"\{summary && <span style=\{\{ color: '#888', 'margin-left': '8px' \}\}>\{summary\}</span>\}",
    src,
)
modifier_not_protected = "white-space': 'nowrap'" not in src and '"white-space":"nowrap"' not in src

if edit_summary_is_single_string and summary_renders_in_one_span and modifier_not_protected:
    print('BUG PRESENT: Edit path and ×all render as one wrapping summary span with no nowrap protection.')
    raise SystemExit(0)

print('BUG ABSENT: renderer no longer matches the mobile-breaking Edit summary pattern.')
raise SystemExit(1)
PY
