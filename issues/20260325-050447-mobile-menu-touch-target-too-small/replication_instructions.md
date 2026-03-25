1. Open `http://localhost:$PORT/` in Chromium at a `390x844` viewport.
2. Locate the fixed hamburger button in the top-left corner of the page.
3. Measure the button with `getBoundingClientRect()`.
4. The bug is present when the button is found and either dimension is below `44px`.
5. On this worker, the reproduced size is `36x36`, so the touch target is too small.
