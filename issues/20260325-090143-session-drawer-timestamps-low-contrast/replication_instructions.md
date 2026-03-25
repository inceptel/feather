1. Open `http://localhost:$PORT/` on a mobile-sized viewport such as `390x844`.
2. Open the session drawer with the hamburger button.
3. Look at the relative-time labels on the right edge of the session rows, such as `now`, `1m`, or `2m`.
4. The bug is present if those labels render at `11px` in `rgb(85, 85, 85)` while the drawer background is `rgb(13, 17, 23)`.
5. That combination is only about `2.54:1` contrast, so the session timestamps fall below readable normal-text contrast on mobile.
