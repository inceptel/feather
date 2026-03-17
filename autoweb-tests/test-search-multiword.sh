#!/bin/bash
# test-search-multiword.sh
# Tests: multi-word search scoring — words scored individually, not as exact phrase

# Check that the search code uses word splitting for scoring
grep -q 'split_whitespace' /opt/feather/src/main.rs || exit 1
grep -q 'n_words' /opt/feather/src/main.rs || exit 1
exit 0
