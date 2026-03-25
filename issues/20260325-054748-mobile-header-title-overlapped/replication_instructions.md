1. Open `http://localhost:$PORT/` on a `390x844` mobile viewport.
2. Stay on the landing screen with no session selected.
3. Inspect the fixed hamburger button and the `Select a session` header text at the top of the page.
4. The bug is present when the menu button consumes all horizontal space up to the title, leaving `0px` of separation between the button's right edge and the title's left edge, so the title reads as covered by the menu control.
