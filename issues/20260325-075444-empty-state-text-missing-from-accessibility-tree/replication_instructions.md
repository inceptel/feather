1. Open `http://localhost:$PORT/` in a mobile viewport (`390x844`).
2. Wait for the empty landing state to render.
3. Confirm the page visibly shows `Select a session` in the header and `Open a session or create a new one` in the main pane.
4. Capture an accessibility snapshot.
5. The bug is present if the visible empty-state text exists on screen, but the accessibility snapshot exposes only the hamburger button instead of the heading and helper copy.
