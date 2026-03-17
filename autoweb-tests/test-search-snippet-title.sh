#!/bin/bash
# test-search-snippet-title.sh
# Tests: search result snippets have title attribute for full-text hover tooltip

grep -q 'title="${escapeHtml(s._snippet)}"' /opt/feather/static/index.html || exit 1
exit 0
