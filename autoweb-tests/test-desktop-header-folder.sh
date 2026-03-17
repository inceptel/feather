#!/bin/bash
# test-desktop-header-folder.sh
# Tests: desktop session header shows folder/project name in meta
# Added: iteration 83

# Check that updateDesktopSessionHeader pushes a folder name into metaParts
grep -A 40 'function updateDesktopSessionHeader' /opt/feather/static/index.html | grep -q 'folderName\|folder\.name\|metaParts.*folder\|folder.*metaParts' || exit 1
exit 0
