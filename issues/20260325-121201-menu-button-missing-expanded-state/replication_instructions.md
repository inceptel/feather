1. Open `http://localhost:$PORT/` on a mobile-sized viewport such as `390x844`.
2. Inspect the top-left hamburger button before opening the drawer.
3. Confirm the closed control renders as `☰` with both `aria-expanded` and `aria-controls` missing.
4. Activate the same control to open the drawer.
5. Inspect the open-state close button and confirm it still has no `aria-expanded` or `aria-controls`, even though it now closes the drawer.
6. The bug is present when neither state exposes disclosure semantics for the drawer toggle relationship.
