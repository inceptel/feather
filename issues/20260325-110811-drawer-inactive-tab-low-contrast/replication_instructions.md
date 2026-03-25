1. Open `http://localhost:$PORT/` on a mobile viewport such as `390x844`.
2. Tap the hamburger button to open the session drawer.
3. Look for drawer switcher buttons labeled `Sessions` and `Links`.
4. In the current build, the reported bug is absent because the drawer no longer renders those tabs at all; it shows `+ New Claude` and the session list instead.
5. If an older build does render both tabs, the bug is present when `Links` is active and the inactive `Sessions` label remains `rgb(102, 102, 102)` at `12px` on the dark drawer background, which is below small-text contrast guidance.
