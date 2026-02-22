#!/bin/bash
# Create a commit and prepare a PR from local changes
set -e
cd /opt/feather

# Check for changes
if [ -z "$(git status --porcelain)" ]; then
    echo "No changes to commit."
    exit 0
fi

echo "=== Create PR ==="
echo ""
git status --short
echo ""

# Get commit message
if [ -n "$1" ]; then
    MSG="$1"
else
    read -p "Commit message: " MSG
fi

# Create branch
BRANCH="patch/$(date +%Y%m%d-%H%M%S)"
git checkout -b "$BRANCH"

# Commit
git add -A
git commit --author="Feather Bot <bot@inceptel.ai>" -m "$MSG

Co-Authored-By: Claude <noreply@anthropic.com>"

echo ""
echo "Committed on branch: $BRANCH"
echo ""
echo "To submit this PR, you need to:"
echo "  1. Fork https://github.com/inceptel/feather on GitHub"
echo "  2. Add your fork as a remote:"
echo "     git remote add fork https://github.com/YOUR_USER/feather.git"
echo "  3. Push and create PR:"
echo "     git push fork $BRANCH"
echo "     gh pr create --repo inceptel/feather"
echo ""
echo "Or if you have push access:"
echo "  git push origin $BRANCH"
echo "  gh pr create"
