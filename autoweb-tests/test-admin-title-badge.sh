#!/bin/bash
# Test: Admin page updates document.title with down count when services are degraded

FILE="/opt/feather/static/admin/index.html"
grep -q 'downCount > 0' "$FILE" || exit 1
grep -q 'down) Feather Admin' "$FILE" || exit 1
grep -q "document.title" "$FILE" || exit 1
exit 0
