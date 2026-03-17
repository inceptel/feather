#!/bin/bash
# test-cmd-palette-scroll-into-view.sh
# Tests: Active command palette item scrolls into view on keyboard navigation
# Added: iteration 99

# After renderCommandPaletteList, the active item should be scrolled into view
grep -q 'data-idx.*_cmdPaletteIdx.*scrollIntoView\|scrollIntoView.*data-idx.*_cmdPaletteIdx\|\[.data-idx.\].*scrollIntoView\|querySelector.*_cmdPaletteIdx.*scrollIntoView\|scrollIntoView.*block.*nearest.*cmdPaletteIdx\|cmdPaletteIdx.*scrollIntoView' /opt/feather/static/index.html || \
grep -q "querySelector\(\`\[data-idx=\"\${_cmdPaletteIdx}\"\]\`\).*scrollIntoView\|querySelector.*data-idx.*_cmdPaletteIdx.*scrollIntoView" /opt/feather/static/index.html || exit 1
exit 0
