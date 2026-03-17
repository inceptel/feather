#!/bin/bash
# test-export-uses-session-project.sh
# Tests: exportSessionMarkdown() uses currentSessionProjectId not currentFolder
# Added: iteration 105

# The export function should use currentSessionProjectId (actual project of session)
# not currentFolder (the currently browsed project) — they can differ when a session
# is opened from a URL hash or command palette pointing to a different project.
grep -q 'currentSessionProjectId' /opt/feather/static/index.html || exit 1

# Specifically, the export fetch must NOT use currentFolder
# Check that in the exportSessionMarkdown function, the history fetch uses currentSessionProjectId
# We look for the pattern: api/projects encodeURIComponent(currentSessionProjectId) in the context of exportSessionMarkdown
grep -A 10 'async function exportSessionMarkdown' /opt/feather/static/index.html | grep -q 'currentSessionProjectId' || exit 1
exit 0
