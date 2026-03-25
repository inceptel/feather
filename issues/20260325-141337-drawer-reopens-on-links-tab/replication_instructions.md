1. Open `http://localhost:$PORT/` on a mobile viewport such as `390x844`.
2. From the landing screen, tap the hamburger button to open the session drawer.
3. If the drawer exposes `Sessions` and `Links`, switch to `Links`, close the drawer with `×`, then reopen it from the landing screen.
4. The bug is present only if the reopened drawer still shows the quick-links empty state (`No quick links yet. Use /feather add link to add some.`) and hides the normal session picker and `+ New Claude` action.
5. On the current worker app at port `3305`, the detector reports the bug absent because reopening the drawer immediately shows the session list and `+ New Claude`, and the drawer does not expose any `Links` switcher to preserve across closes.
