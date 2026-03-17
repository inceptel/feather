#!/bin/bash
# test-image-message-dedup.sh
# Tests: addUserMessageWithFiles sets data-content-hash and tracks renderedTextHashes
# Added: iteration 56 — fixes duplicate messages when user sends images

# Verify addUserMessageWithFiles sets data-content-hash attribute
grep -q "data-content-hash.*hashContent" /opt/feather/static/index.html || exit 1

# Verify it adds to renderedTextHashes to prevent SSE re-render
grep -q "renderedTextHashes.add(hashContent(content))" /opt/feather/static/index.html || exit 1

exit 0
