1. Open `http://localhost:$PORT/` on a mobile viewport at `390x844`.
2. Open the sidebar drawer from the hamburger button.
3. Switch from `Sessions` to `Links`.
4. Inspect the helper copy `No quick links yet. Use /feather add link to add some.`
5. The bug is present only if that helper text exists in the `Links` pane and measures below `4.5:1` contrast, specifically around `rgb(85, 85, 85)` on `rgb(13, 17, 23)`.
6. On the current worker app at port `3305`, the detector reports the bug absent because the `Links` tab/helper copy is not rendered at all.
