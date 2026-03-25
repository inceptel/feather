1. Open `http://localhost:$PORT/` on a mobile viewport (`390x844`).
2. Wait for Feather to render the empty-state landing pane.
3. Inspect the center of the main pane between `Select a session` and `Open a session or create a new one`.
4. The bug is present if Feather renders a standalone `~` on its own line there. The current implementation also hard-codes that glyph in [App.tsx](/home/user/feather-dev/w5/frontend/src/App.tsx).
