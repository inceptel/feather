#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3305}"
BASE="http://localhost:$PORT"
TARGET_ID="4baa1292-7fdf-4e87-af47-6731e459b3cd"
TARGET_TITLE="worker 4 probe"
VIEW_FILE="/home/user/feather-dev/w5/frontend/src/components/MessageView.tsx"

MESSAGES_JSON="$(curl -fsS "$BASE/api/sessions/$TARGET_ID/messages")"

SESSION_TITLE="$(curl -fsS "$BASE/api/sessions?limit=500" | jq -r --arg id "$TARGET_ID" 'first((.sessions // [])[] | select(.id == $id) | .title) // empty')"
if [ "$SESSION_TITLE" != "$TARGET_TITLE" ]; then
  echo "BUG ABSENT: target session $TARGET_ID is unavailable from $BASE/api/sessions?limit=500 as '$TARGET_TITLE'"
  exit 1
fi

TABLE_MARKDOWN_PRESENT="$(printf '%s' "$MESSAGES_JSON" | jq -r '
  [(.messages // [])[]?.content[]? | select(.type == "text") | .text]
  | any(
      (. // "") | contains("**Port flip repro results:**")
      and contains("| Step | URL | Result |")
      and contains("| First send (\"worker4 iter17 send probe\") | Started on `3304` | Flipped to `3301` |")
      and contains("| Reload on `3304`, confirm URL correct | `3304/#4baa...` | Confirmed `3304` |")
    )
')"

if [ "$TABLE_MARKDOWN_PRESENT" != "true" ]; then
  echo "BUG ABSENT: target session no longer contains the markdown table described in the bug report"
  exit 1
fi

SOURCE_EVIDENCE="$(node - "$VIEW_FILE" <<'NODE'
const fs = require('fs')
const path = process.argv[2]
const src = fs.readFileSync(path, 'utf8')

const hasMarkdownHtml = src.includes('class="markdown" innerHTML={renderMarkdown(block.text)}') &&
  src.includes('class="markdown" innerHTML={renderMarkdown(display)}')

const tableRule = /\.markdown table \{([^}]*)\}/s.exec(src)
const markdownRule = /\.markdown \{([^}]*)\}/s.exec(src)
const bubbleMatch = /'max-width': '85%'.*?overflow: 'hidden'/s.test(src)

const tableCss = tableRule ? tableRule[1] : ''
const markdownCss = markdownRule ? markdownRule[1] : ''

const result = {
  hasMarkdownHtml,
  bubbleMatch,
  tableWidth100: /width:\s*100%/.test(tableCss),
  tableHasOverflowX: /overflow-x\s*:/.test(tableCss),
  markdownBreakWord: /word-break:\s*break-word/.test(markdownCss),
  hasTableWrapper: /table-wrapper|table-container|scrollable-table|replace\([^)]*<table|<div class="table/i.test(src),
}

console.log(JSON.stringify(result))
NODE
)"

printf '%s\n' "$SOURCE_EVIDENCE"

python3 - <<'PY' "$SOURCE_EVIDENCE"
import json
import sys

evidence = json.loads(sys.argv[1])
bug_present = (
    evidence.get("hasMarkdownHtml")
    and evidence.get("bubbleMatch")
    and evidence.get("tableWidth100")
    and evidence.get("markdownBreakWord")
    and not evidence.get("tableHasOverflowX")
    and not evidence.get("hasTableWrapper")
)

if bug_present:
    print("BUG PRESENT: markdown tables from worker 4 probe are rendered as bare HTML tables inside an 85%-width hidden-overflow bubble with width:100% and no horizontal-scroll treatment")
    raise SystemExit(0)

print("BUG ABSENT: renderer source no longer matches the mobile table squeeze path")
raise SystemExit(1)
PY
