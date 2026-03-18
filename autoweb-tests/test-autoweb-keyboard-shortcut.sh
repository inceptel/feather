#!/bin/bash
# Test: V keyboard shortcut triggers toggleAutowebPanel
set -e
HTML=/opt/feather/static/index.html

# Check V key handler exists
grep -q "e.key === 'v'" "$HTML" || { echo "FAIL: V key handler missing"; exit 1; }
grep -q "toggleAutowebPanel()" "$HTML" || { echo "FAIL: toggleAutowebPanel not called from V handler"; exit 1; }

# Check shortcuts modal shows V for Autoweb dashboard
grep -q "Autoweb dashboard" "$HTML" || { echo "FAIL: Autoweb dashboard not in shortcuts modal"; exit 1; }

# Check command palette entry has V shortcut
grep -q "shortcut: 'V'" "$HTML" || { echo "FAIL: command palette Autoweb entry missing V shortcut"; exit 1; }

echo "PASS: V keyboard shortcut for Autoweb dashboard"
