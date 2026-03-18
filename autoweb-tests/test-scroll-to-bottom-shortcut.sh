#!/usr/bin/env bash
# Test: B keyboard shortcut scrolls to bottom
set -euo pipefail
F=/opt/feather/static/index.html

# 1. B key handler calls scrollToBottom(true)
grep -q "e.key === 'b'" "$F" || { echo "FAIL: B key handler missing"; exit 1; }
grep -A5 "e.key === 'b'" "$F" | grep -q "scrollToBottom(true)" || { echo "FAIL: B key handler does not call scrollToBottom(true)"; exit 1; }

# 2. Command palette entry shows B shortcut
grep -q "'Scroll to bottom', shortcut: 'B'" "$F" || { echo "FAIL: command palette missing B shortcut for Scroll to bottom"; exit 1; }

# 3. Shortcuts modal documents B key
grep -q "Scroll to bottom" "$F" && grep -q ">B<" "$F" || { echo "FAIL: shortcuts modal missing Scroll to bottom / B entry"; exit 1; }

echo "PASS: B keyboard shortcut scrolls to bottom"
