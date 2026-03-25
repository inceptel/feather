1. Open Feather on mobile at `390x844` with a session selected so the `Chat`, `Terminal`, composer textarea, and `Send` button are visible.
2. Tap the hamburger button to open the left drawer.
3. Inspect the still-visible main pane on the right while the drawer is open.
4. The bug is present if the drawer takes `300px` of the `390px` viewport and forces the main pane down to about `90px`, leaving `Terminal` and `Send` pushed past the right edge and shrinking the composer textarea to about `30px` wide.
