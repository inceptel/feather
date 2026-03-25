1. Open `http://localhost:${PORT:-3305}/` in a mobile viewport (`390x844`).
2. Tap the hamburger button in the top-left corner to open the session drawer.
3. Measure the drawer container width with `getBoundingClientRect().width`.
4. The reported bug is present only if the drawer collapses into a narrow strip, roughly `21px` wide on a `390px` viewport, instead of occupying a substantial side-sheet width.

Current worker-5 result on `2026-03-25`: the drawer opens at `300px` wide on port `3305`, so this report is not reproducible on this worker's build.
