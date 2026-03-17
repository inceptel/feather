#!/bin/bash
# test-draft-indicator.sh
# Tests: draft indicator shown in session list when sessionDrafts has entry

grep -q 'draft-indicator' /opt/feather/static/index.html || exit 1
grep -q 'updateDraftIndicator' /opt/feather/static/index.html || exit 1
grep -q 'Draft:' /opt/feather/static/index.html || exit 1
exit 0
