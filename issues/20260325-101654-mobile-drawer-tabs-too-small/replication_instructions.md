1. Open `http://localhost:$PORT/` on a mobile viewport at `390x844`.
2. Tap the hamburger button to open the drawer.
3. Look for two primary drawer switchers labeled `Sessions` and `Links`.
4. Measure those switchers with `getBoundingClientRect()`.
5. The reported bug is present only if both switchers exist and their touch target height is under `44px`.
6. On the current worker app at port `3305`, the detector reports the bug absent because the drawer does not render `Sessions` or `Links` tabs at all, which is consistent with the current source in `frontend/src/App.tsx`.
