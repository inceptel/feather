#!/bin/bash
# test-search-snippet-no-double-escape.sh
# Tests: snippetLine passes raw s._snippet to highlightSearch (no pre-escaping),
#        since highlightSearch handles escapeHtml internally

grep -q 'highlightSearch(s\._snippet,' /opt/feather/static/index.html || exit 1
exit 0
