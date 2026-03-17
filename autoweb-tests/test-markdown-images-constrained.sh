#!/bin/bash
# test-markdown-images-constrained.sh
# Tests: markdown content images have max-width:100% to prevent overflow on mobile
# Added: iteration 31

grep -q '\.markdown-content img.*max-width.*100%' /opt/feather/static/index.html || exit 1
exit 0
