#!/bin/bash
# Test: major modals have role="dialog" and aria-modal="true" for screen reader accessibility
set -e
FILE=/opt/feather/static/index.html

# Command palette overlay has role="dialog"
grep -q 'id="command-palette-overlay".*role="dialog"' "$FILE" || grep -q 'role="dialog".*id="command-palette-overlay"' "$FILE" || \
  (grep 'id="command-palette-overlay"' "$FILE" | grep -q 'role="dialog"') || { echo "FAIL: command-palette-overlay missing role=dialog"; exit 1; }

# Command palette overlay has aria-modal="true"
grep 'id="command-palette-overlay"' "$FILE" | grep -q 'aria-modal="true"' || { echo "FAIL: command-palette-overlay missing aria-modal=true"; exit 1; }

# Shortcuts modal has role="dialog"
grep 'id="shortcuts-modal"' "$FILE" | grep -q 'role="dialog"' || { echo "FAIL: shortcuts-modal missing role=dialog"; exit 1; }

# Shortcuts modal has aria-modal="true"
grep 'id="shortcuts-modal"' "$FILE" | grep -q 'aria-modal="true"' || { echo "FAIL: shortcuts-modal missing aria-modal=true"; exit 1; }

# Shortcuts modal close button is a <button> element (not <span>)
grep -A5 'id="shortcuts-modal"' "$FILE" | grep -q '<button.*closeShortcutsModal' || { echo "FAIL: shortcuts modal close is not a <button>"; exit 1; }

# Session context menu has role="menu"
grep 'id="session-ctx-menu"' "$FILE" | grep -q 'role="menu"' || { echo "FAIL: session-ctx-menu missing role=menu"; exit 1; }

echo "PASS: modal aria roles"
