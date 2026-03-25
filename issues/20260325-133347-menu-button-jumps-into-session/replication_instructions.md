1. Open `http://localhost:$PORT/` on a `390x844` viewport.
2. Confirm the page is on the empty landing state with `Select a session` and `Open a session or create a new one`.
3. Tap the top-left hamburger button (`☰`).
4. Check whether the app stays on the root URL with an empty hash and opens the drawer, exposing `+ New Claude` and the close button.
5. Check whether the tap instead jumps into a transcript, changing the header and exposing session chrome such as `Resume`, `Chat`, `Terminal`, or the composer.
6. The bug is present only when the hamburger tap selects a session instead of opening the drawer.
