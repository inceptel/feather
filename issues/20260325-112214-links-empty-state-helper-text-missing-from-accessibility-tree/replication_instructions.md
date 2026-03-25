1. Open `http://localhost:3305/` on a mobile-sized viewport (`390x844`).
2. Open the drawer from the hamburger button.
3. Look for `Sessions` and `Links` drawer switchers, then switch to `Links` if it exists.
4. Look for the visible helper copy `No quick links yet. Use /feather add link to add some.` and compare it with the accessibility snapshot.
5. The reported bug is present only if that helper text is visibly rendered in the Links empty state but omitted from the accessibility tree.
6. On the current worker app, the detector reports the bug absent because the drawer no longer renders any `Links` switcher or helper copy, and the current source in `frontend/src/App.tsx` no longer contains that Links empty-state UI.
