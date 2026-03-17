#!/bin/bash
# test-star-toast.sh
# Tests: toggleStarSession shows toast feedback (starred/unstarred)

grep -q "showToast.*[Ss]tarred\|[Ss]tarred.*showToast" /opt/feather/static/index.html || exit 1
exit 0
