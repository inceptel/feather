#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

APP_TSX="/home/user/feather-dev/w5/frontend/src/App.tsx"

if [ ! -f "$APP_TSX" ]; then
  echo "BUG ABSENT: missing source file $APP_TSX"
  exit 1
fi

node --input-type=module - "$APP_TSX" <<'NODE'
import fs from 'fs'

const file = process.argv[2]
const src = fs.readFileSync(file, 'utf8')

const sendButtonMatch = src.match(/<button\s+onClick=\{handleSend\}[\s\S]*?style=\{\{([\s\S]*?)\}\}>\{uploading\(\) \? '\.\.\.' : 'Send'\}<\/button>/)
if (!sendButtonMatch) {
  console.log('BUG ABSENT: could not find the Send button markup')
  process.exit(1)
}

const styleBody = sendButtonMatch[1]
const minHeightMatch = styleBody.match(/'min-height':\s*'([0-9.]+)px'/)
const paddingMatch = styleBody.match(/padding:\s*'([0-9.]+)px\s+([0-9.]+)px'/)
const fontSizeMatch = styleBody.match(/'font-size':\s*'([0-9.]+)px'/)

if (!minHeightMatch) {
  console.log('BUG ABSENT: Send button min-height was not found')
  process.exit(1)
}

const minHeight = Number(minHeightMatch[1])
const verticalPadding = paddingMatch ? Number(paddingMatch[1]) : null
const horizontalPadding = paddingMatch ? Number(paddingMatch[2]) : null
const fontSize = fontSizeMatch ? Number(fontSizeMatch[1]) : null
const minimumTouchTarget = 44

if (minHeight < minimumTouchTarget) {
  const details = [
    `min-height ${minHeight}px`,
    verticalPadding === null ? null : `padding ${verticalPadding}px ${horizontalPadding}px`,
    fontSize === null ? null : `font-size ${fontSize}px`
  ].filter(Boolean).join(', ')
  console.log(`BUG PRESENT: Send button style constrains the mobile touch target below 44px (${details})`)
  process.exit(0)
}

console.log(`BUG ABSENT: Send button min-height is ${minHeight}px`)
process.exit(1)
NODE
