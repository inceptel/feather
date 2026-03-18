#!/bin/bash
# Test: admin service cards have a copy-restart-command button
FILE="/opt/feather/static/admin/index.html"

# copyRestartCmd function must exist
grep -q "function copyRestartCmd" "$FILE" || { echo "FAIL: copyRestartCmd function missing"; exit 1; }

# Button with ↺ icon and copyRestartCmd onclick must be rendered per service
grep -q "onclick=\"copyRestartCmd(this" "$FILE" || { echo "FAIL: ↺ restart button not found in service template"; exit 1; }

# Must copy the supervisorctl restart command
grep -q "supervisorctl restart" "$FILE" || { echo "FAIL: supervisorctl restart command not present"; exit 1; }

echo "PASS: admin copy-restart-cmd button present"
exit 0
