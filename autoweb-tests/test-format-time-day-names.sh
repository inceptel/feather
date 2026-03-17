#!/bin/bash
# test-format-time-day-names.sh
# Tests: formatTime shows day names (Mon/Tue/etc) for "This Week" sessions, not "3d"/"4d"
# Added: iteration 76

# The formatTime function should use toLocaleDateString with weekday for sessions 2-6 days old
# (not the ${days}d pattern which just shows "3d" etc.)
# Check that formatTime function body uses weekday format for the days < 7 case
python3 - <<'EOF'
import re, sys
with open('/opt/feather/static/index.html') as f:
    content = f.read()

# Find the formatTime function
m = re.search(r'function formatTime\(iso\)(.*?)function formatFullTime', content, re.DOTALL)
if not m:
    print("formatTime function not found")
    sys.exit(1)

func_body = m.group(1)
# Should NOT have the old "${days}d" pattern for This Week sessions
if '`${days}d`' in func_body or "'${days}d'" in func_body:
    print("Still using days count format (Nd) for This Week sessions")
    sys.exit(1)

# Should have weekday formatting (toLocaleDateString with weekday, or day names array)
if 'weekday' not in func_body and 'dayNames' not in func_body and "['Sun','Mon'" not in func_body and '["Sun","Mon"' not in func_body:
    print("No day name formatting found in formatTime")
    sys.exit(1)

print("PASS")
sys.exit(0)
EOF
