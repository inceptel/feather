#!/bin/bash
# Pull latest from upstream (no build, no restart)
set -e
cd /opt/feather

echo "Current: $(git log --oneline -1)"
git pull origin master
echo "Now:     $(git log --oneline -1)"
