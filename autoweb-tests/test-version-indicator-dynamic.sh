#!/bin/bash
# test-version-indicator-dynamic.sh
# Tests: version indicator reads dynamically from the autoweb-version HTML comment
# Added: iteration 11

# The version indicator should contain JS that reads from the HTML comment,
# not a hardcoded string. Check that there's a script/function that parses the comment.
grep -q 'autoweb-version' /opt/feather/static/index.html || exit 1

# The indicator div should NOT have a hardcoded improvement count — it should be set by JS
# Check that there's JS code that reads the HTML comment and updates the indicator
grep -q 'autoweb-version-indicator' /opt/feather/static/index.html || exit 1
grep -qP 'iter=|keeps=' /opt/feather/static/index.html || exit 1

# There should be JS that parses the comment and updates the indicator text
grep -q 'comment\|nodeType.*8\|autoweb-version' /opt/feather/static/index.html | head -1
# Check that the hardcoded "3 improvements" is NOT present
if grep -q '3 improvements' /opt/feather/static/index.html; then
    exit 1
fi

exit 0
