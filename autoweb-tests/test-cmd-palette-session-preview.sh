#!/bin/bash
# Test: Command palette shows session preview pane on hover/nav
FILE="/opt/feather/static/index.html"

# Preview pane exists in command palette
grep -q 'id="command-palette-preview"' "$FILE" || { echo "FAIL: command-palette-preview div not found"; exit 1; }
grep -q 'id="command-palette-preview-role"' "$FILE" || { echo "FAIL: command-palette-preview-role not found"; exit 1; }
grep -q 'id="command-palette-preview-text"' "$FILE" || { echo "FAIL: command-palette-preview-text not found"; exit 1; }

# Session items have sessionId field
grep -q 'sessionId: s\.id' "$FILE" || { echo "FAIL: sessionId not stored in session command items"; exit 1; }
grep -q 'projectId: s\.project' "$FILE" || { echo "FAIL: projectId not stored in session command items"; exit 1; }

# loadCmdPreview function exists
grep -q 'function loadCmdPreview' "$FILE" || { echo "FAIL: loadCmdPreview function not found"; exit 1; }

# highlightCmdItem calls loadCmdPreview
grep -q 'loadCmdPreview(filtered\[idx\])' "$FILE" || { echo "FAIL: highlightCmdItem does not call loadCmdPreview"; exit 1; }

# closeCommandPalette hides preview
grep -q 'previewDiv.style.display = .none' "$FILE" || { echo "FAIL: closeCommandPalette does not hide preview"; exit 1; }

echo "PASS: command palette session preview feature present"
exit 0
