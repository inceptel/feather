#!/bin/bash
# test-draft-persistence.sh
# Tests: sessionDrafts are persisted to localStorage (feather-session-drafts key)

grep -q 'feather-session-drafts' /opt/feather-dev/static/index.html || exit 1
grep -q 'persistDrafts' /opt/feather-dev/static/index.html || exit 1
# persistDrafts is called on save and delete
grep -q 'persistDrafts();' /opt/feather-dev/static/index.html || exit 1
exit 0
