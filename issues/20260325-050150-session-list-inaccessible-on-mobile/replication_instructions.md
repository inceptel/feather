1. Open `http://127.0.0.1:$PORT/` on a mobile viewport such as `390x844`.
2. Tap the hamburger button in the top-left corner to open the session drawer.
3. Inspect the drawer controls through the accessibility tree or DOM semantics.
4. Observe that the visible session rows are clickable `div`s with pointer cursors, but they have no button semantics such as `role="button"` or `tabindex`.
5. Observe that only the close button and `+ New Claude` are exposed as actual buttons, so the session rows are not discoverable as interactive controls.
