1. Open `http://localhost:3305/` in a mobile viewport (`390x844`).
2. Activate the hamburger button (`☰`) to open the session drawer.
3. Inspect `document.activeElement` after the drawer is visible.
4. The bug is present if the drawer is open but `document.activeElement === document.body` instead of the close button or another control inside the overlay.
