1. Open `http://localhost:$PORT/` in Chromium at mobile viewport `390x844`.
2. Wait for the landing screen to finish loading.
3. Inspect the only visible navigation button in the top-left corner.
4. Confirm the button renders as `☰` and has no descriptive accessible name such as `Open session list`.
5. The bug is present when the landing screen exposes that control only by the glyph instead of a purpose-based label.
