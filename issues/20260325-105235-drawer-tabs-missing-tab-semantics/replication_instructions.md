1. Open `http://localhost:$PORT/` on a mobile viewport at `390x844`.
2. Tap the hamburger button to open the left drawer.
3. Look for drawer switchers labeled `Sessions` and `Links`.
4. Inspect whether the drawer includes a parent `role="tablist"` and whether each switcher exposes `role="tab"`, `aria-selected`, and `aria-controls`.
5. The reported bug is present only if those `Sessions` and `Links` switchers exist as plain buttons with no tab semantics.
6. On the current worker app at port `3305`, the detector reports the bug absent because the drawer no longer renders `Sessions` or `Links` switchers at all, and the current source in `frontend/src/App.tsx` likewise contains no drawer tab UI to inspect.
