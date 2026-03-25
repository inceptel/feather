#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
ISSUE_HASH="#370e2f60-1399-4ebf-a182-7a8ba6c59ccf"
SOURCE_FILE="/home/user/feather-dev/w5/frontend/src/components/MessageView.tsx"

if [ ! -f "$SOURCE_FILE" ]; then
  echo "STATUS:ABSENT reason=missing-source file=$SOURCE_FILE"
  echo "BUG ABSENT"
  exit 1
fi

RESULT="$(node - "$SOURCE_FILE" "$PORT" "$ISSUE_HASH" <<'NODE'
const fs = require('fs')

const [, , sourceFile, port, issueHash] = process.argv
const source = fs.readFileSync(sourceFile, 'utf8')

const hasTranscriptScroller =
  source.includes("<div ref={scrollRef} onScroll={onScroll}") &&
  source.includes("'overflow-y': 'auto'") &&
  source.includes("'-webkit-overflow-scrolling': 'touch'")

const hidesFirefoxScrollbar =
  source.includes("'scrollbar-width': 'none'") ||
  source.includes('scrollbar-width: none')

const hidesMsScrollbar =
  source.includes("'ms-overflow-style': 'none'") ||
  source.includes('ms-overflow-style: none')

const hidesWebkitScrollbar =
  source.includes('::-webkit-scrollbar') &&
  (source.includes('display: none') || source.includes('width: 0'))

const bugPresent =
  hasTranscriptScroller &&
  !hidesFirefoxScrollbar &&
  !hidesMsScrollbar &&
  !hidesWebkitScrollbar

const status = bugPresent ? 'PRESENT' : 'ABSENT'
console.log([
  `STATUS:${status}`,
  `port=${port}`,
  `route=http://localhost:${port}/${issueHash}`,
  `source=${sourceFile}`,
  `hasTranscriptScroller=${hasTranscriptScroller}`,
  `hidesFirefoxScrollbar=${hidesFirefoxScrollbar}`,
  `hidesMsScrollbar=${hidesMsScrollbar}`,
  `hidesWebkitScrollbar=${hidesWebkitScrollbar}`,
].join(' '))
NODE
)"

echo "$RESULT"

if printf '%s' "$RESULT" | grep -q 'STATUS:PRESENT'; then
  echo "BUG PRESENT"
  exit 0
fi

echo "BUG ABSENT"
exit 1
