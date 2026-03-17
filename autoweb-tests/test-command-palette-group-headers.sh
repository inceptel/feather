#!/bin/bash
# test-command-palette-group-headers.sh
# Tests: command palette items have group property for section headers
# Added: iteration 103

# Check that getFilteredCommands returns items tagged with a 'group' property
grep -q "group: 'recent'" /opt/feather/static/index.html || exit 1
grep -q "group: 'command'" /opt/feather/static/index.html || exit 1
# Check that group headers are rendered in renderCommandPaletteList
grep -q "cmd.group !== lastGroup" /opt/feather/static/index.html || exit 1
exit 0
