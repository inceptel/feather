1. Open `http://localhost:$PORT/` in Chromium at a `390x844` viewport.
2. Tap the `☰` button to open the mobile session drawer.
3. Locate the drawer's `×` dismiss button in the top-right corner.
4. Measure that button with `getBoundingClientRect()`.
5. The bug is present when the close button exists and either dimension is below `44px`.
6. On this worker, the reproduced size is about `11.69x23`, which is well below the mobile touch-target minimum.
