#!/bin/bash
# Test: admin service cards show ▶ start button for stopped services instead of ↺ restart
FILE="/opt/feather/static/admin/index.html"

# copyStartCmd function must exist
grep -q "function copyStartCmd" "$FILE" || { echo "FAIL: copyStartCmd function missing"; exit 1; }

# copyStartCmd must copy 'supervisorctl start' command
grep -q "supervisorctl start" "$FILE" || { echo "FAIL: supervisorctl start command not present"; exit 1; }

# The render template must differentiate between running and stopped (uses running || flapping condition)
grep -q "running || flapping" "$FILE" || { echo "FAIL: running/flapping conditional not present"; exit 1; }

# copyStartCmd must be called with onclick for stopped services
grep -q "onclick=\"copyStartCmd(this" "$FILE" || { echo "FAIL: copyStartCmd onclick not found in service template"; exit 1; }

echo "PASS: admin stopped service shows start command button"
exit 0
