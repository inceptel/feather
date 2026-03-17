#!/bin/bash
# test-isautoweb-server-side-only.sh
# Tests: isAutowebSession() uses only s.is_autoweb (no title regex fallback)

# Should use server-side field only, no regex
grep -q 'return !!s.is_autoweb;' /opt/feather/static/index.html || exit 1

# Should NOT have the old regex patterns
grep -q 'Do exactly ONE iteration' /opt/feather/static/index.html && exit 1
grep -q 'AUTOWEB_FIX_PATTERN\|AUTOWEB_SPECIFIC_PATTERN' /opt/feather/static/index.html && exit 1

exit 0
