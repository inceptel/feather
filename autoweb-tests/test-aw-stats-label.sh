#!/bin/bash
# test-aw-stats-label.sh
# Tests: AW dashboard stats label mapping includes 'frontend' key (not just 'feather','dev','trading')
# Added: iteration 73

# The stats label map should have 'frontend' key so the Frontend tab shows "Frontend: N attempts"
# instead of falling back to "Feather: N attempts"
grep -q "frontend: 'Frontend'" /opt/feather/static/index.html || exit 1
exit 0
