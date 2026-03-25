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

const resumeButtonMatch = src.match(/<Show when=\{!s\(\)\.isActive\}>\s*<button onClick=\{\(\) => handleResume\(s\(\)\.id\)\} style=\{\{([\s\S]*?)\}\}>Resume<\/button>\s*<\/Show>/)
if (!resumeButtonMatch) {
  console.log('BUG ABSENT: could not find the Resume button markup')
  process.exit(1)
}

const styleBody = resumeButtonMatch[1]
const paddingMatch = styleBody.match(/padding:\s*'([0-9.]+)px\s+([0-9.]+)px'/)
const fontSizeMatch = styleBody.match(/'font-size':\s*'([0-9.]+)px'/)
const minHeightMatch = styleBody.match(/'min-height':\s*'([0-9.]+)px'/)

const verticalPadding = paddingMatch ? Number(paddingMatch[1]) : null
const horizontalPadding = paddingMatch ? Number(paddingMatch[2]) : null
const fontSize = fontSizeMatch ? Number(fontSizeMatch[1]) : null
const minHeight = minHeightMatch ? Number(minHeightMatch[1]) : null
const estimatedHeight = minHeight ?? (fontSize === null || verticalPadding === null ? null : fontSize + (verticalPadding * 2))
const minimumTouchTarget = 44

if (estimatedHeight === null) {
  console.log('BUG ABSENT: Resume button height could not be derived from source')
  process.exit(1)
}

if (estimatedHeight < minimumTouchTarget) {
  const details = [
    minHeight === null ? null : `min-height ${minHeight}px`,
    verticalPadding === null ? null : `padding ${verticalPadding}px ${horizontalPadding}px`,
    fontSize === null ? null : `font-size ${fontSize}px`,
    `estimated height ${estimatedHeight}px`
  ].filter(Boolean).join(', ')
  console.log(`BUG PRESENT: Resume button constrains the mobile touch target below 44px (${details})`)
  process.exit(0)
}

console.log(`BUG ABSENT: Resume button estimated height is ${estimatedHeight}px`)
process.exit(1)
NODE
