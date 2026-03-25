1. Open `http://localhost:${PORT:-3305}/` in a mobile-sized Chromium viewport such as `390x844`.
2. Tap the hamburger button in the top-left corner to open the session drawer.
3. Confirm the drawer is open by checking that the `+ New Claude` button and the close button are visible.
4. In the page context, run `document.querySelectorAll('nav,[role="navigation"]').length`.
5. The bug is present if the drawer is visibly open but that query returns `0`.
