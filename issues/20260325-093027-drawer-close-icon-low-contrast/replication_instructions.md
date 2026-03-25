1. Open `http://localhost:$PORT/` on a mobile viewport such as `390x844`.
2. Tap the hamburger button in the top-left corner to open the session drawer.
3. Inspect the `×` button in the drawer header.
4. The bug is present when that close icon renders as muted gray (`rgb(102, 102, 102)`) against the dark drawer header (`rgb(13, 17, 23)`), producing contrast below `4.5:1`.
