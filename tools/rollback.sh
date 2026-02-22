#!/bin/bash
# Rollback to previous commit and rebuild
set -e
cd /opt/feather

CURRENT=$(git log --oneline -1)
echo "Current: $CURRENT"

git checkout HEAD~1
echo "Rolled back to: $(git log --oneline -1)"

./tools/build.sh

echo ""
echo "To undo this rollback: git checkout master && ./tools/build.sh"
