1. Open `http://localhost:$PORT/` on a `390x844` viewport.
2. Tap the hamburger button to open the mobile session drawer.
3. Inspect the scrollable session list on the right edge of the drawer.
4. Measure the drawer list container in DevTools or with `agent-browser eval`.
5. The bug is present when the drawer list reserves a persistent scrollbar gutter, with `offsetWidth - clientWidth` around `15px` instead of using the full drawer width.
