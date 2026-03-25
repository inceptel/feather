#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

ROOT="/home/user/feather-dev/w5"
TERMINAL_COMPONENT="$ROOT/frontend/src/components/Terminal.tsx"
APP_COMPONENT="$ROOT/frontend/src/App.tsx"
XTERM_SOURCE="$ROOT/frontend/node_modules/@xterm/xterm/src/browser/CoreBrowserTerminal.ts"
XTERM_A11Y="$ROOT/frontend/node_modules/@xterm/xterm/src/browser/AccessibilityManager.ts"
XTERM_LABELS="$ROOT/frontend/node_modules/@xterm/xterm/src/browser/LocalizableStrings.ts"
XTERM_CSS="$ROOT/frontend/node_modules/@xterm/xterm/css/xterm.css"

if \
  grep -Fq "import { Terminal as XTerm } from '@xterm/xterm'" "$TERMINAL_COMPONENT" && \
  grep -Fq "term.open(containerRef)" "$TERMINAL_COMPONENT" && \
  grep -Fq "<Terminal sessionId={tab() === 'terminal' ? currentId() : null} />" "$APP_COMPONENT" && \
  grep -Fq "this.textarea.classList.add('xterm-helper-textarea');" "$XTERM_SOURCE" && \
  grep -Fq "this._rowContainer.classList.add('xterm-accessibility-tree');" "$XTERM_A11Y" && \
  grep -Fq "let promptLabelInternal = 'Terminal input';" "$XTERM_LABELS" && \
  grep -Fq ".xterm .xterm-helper-textarea {" "$XTERM_CSS" && \
  grep -Fq ".xterm .xterm-accessibility-tree {" "$XTERM_CSS"
then
  echo "BUG PRESENT: xterm terminal integration exposes both the helper textarea and accessibility tree with the same Terminal input label"
  exit 0
fi

echo "BUG ABSENT"
exit 1
