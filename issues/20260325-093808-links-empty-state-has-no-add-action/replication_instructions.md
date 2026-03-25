1. Open `http://localhost:3305/` on a mobile viewport such as `390x844`.
2. Open the session drawer with the hamburger button.
3. Look for a usable way to manage quick links from the drawer.
4. The bug is present if there is no `Links` switcher at all, because mobile users have no path to an empty Links state or an add action.
5. The bug is also present if a `Links` empty state is shown with `No quick links yet. Use /feather add link to add some.` but no visible add CTA or other actionable control exists in that pane.
6. On the current worker app, the detector reproduces the stronger dead-end: the drawer exposes `+ New Claude` but no `Links` switcher or quick-link add action.
