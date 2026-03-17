#!/bin/bash
# test-mobile-code-copy-btn.sh
# Tests: Mobile code copy button is always visible (opacity > 0)
# Added: iteration 28

# Check that mobile media query contains code-copy-btn opacity rule
grep -q '@media.*max-width.*767' /opt/feather/static/index.html || exit 1
grep -q 'code-copy-btn.*opacity.*0\.7' /opt/feather/static/index.html || exit 1
# Check mobile pre has reduced padding
grep -q 'markdown-content pre.*padding.*0\.7em' /opt/feather/static/index.html || exit 1
exit 0
