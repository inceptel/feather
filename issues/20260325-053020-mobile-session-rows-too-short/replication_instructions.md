1. Open `http://localhost:$PORT/` on a mobile viewport sized `390x844`.
2. Tap the hamburger button in the top-left corner to open the session drawer.
3. Measure the height of the clickable session-row containers in the drawer.
4. The bug is present if any session row is shorter than `44px`.
5. On port `3305`, the current rows measure `40px` tall, so the bug reproduces.
