#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

APP_TSX="/home/user/feather-dev/w5/frontend/src/App.tsx"

if [ ! -f "$APP_TSX" ]; then
  echo "Missing source file: $APP_TSX"
  exit 1
fi

node --input-type=module - "$APP_TSX" <<'NODE'
import fs from 'fs'

const file = process.argv[2]
const src = fs.readFileSync(file, 'utf8')

const tabStyleMatch = src.match(/const\s+tabStyle\s*=\s*\(t:\s*string\)\s*=>\s*\(\{([\s\S]*?)\}\)/)
if (!tabStyleMatch) {
  console.log('BUG ABSENT: tabStyle() not found')
  process.exit(1)
}

const body = tabStyleMatch[1]
const paddingMatch = body.match(/padding:\s*'([0-9.]+)px\s+([0-9.]+)px'/)
const fontSizeMatch = body.match(/'font-size':\s*'([0-9.]+)px'/)

if (!paddingMatch || !fontSizeMatch) {
  console.log('BUG ABSENT: could not parse tab padding/font size')
  process.exit(1)
}

const verticalPadding = Number(paddingMatch[1])
const horizontalPadding = Number(paddingMatch[2])
const fontSize = Number(fontSizeMatch[1])
const estimatedHeight = verticalPadding * 2 + fontSize + 4
const minimumTouchTarget = 44

if (estimatedHeight < minimumTouchTarget) {
  console.log(`BUG PRESENT: tabStyle estimates ${estimatedHeight}px tall tabs (padding ${verticalPadding}px ${horizontalPadding}px, font ${fontSize}px)`)
  process.exit(0)
}

console.log(`BUG ABSENT: tabStyle estimates ${estimatedHeight}px tall tabs`)
process.exit(1)
NODE
