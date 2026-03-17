#!/bin/bash
# test-session-folder-badge.sh
# Tests: session list items show project folder name when session is from a different project

grep -q 'sessionFolderName' /opt/feather/static/index.html || exit 1
grep -q 'folderBadge' /opt/feather/static/index.html || exit 1
grep -q 'FOLDERS.find(f => f.id === s.project)' /opt/feather/static/index.html || exit 1
exit 0
