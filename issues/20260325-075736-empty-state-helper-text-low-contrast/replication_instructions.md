1. Open `http://localhost:$PORT/` in a mobile viewport (`390x844`).
2. Wait for Feather to render the empty landing state without selecting a session.
3. Inspect the helper copy `Open a session or create a new one` in the center pane.
4. Measure the rendered text and background colors for that string.
5. The bug is present if the helper copy renders as `rgb(68, 68, 68)` on `rgb(10, 14, 20)`, which is about `1.99:1` contrast and below normal-text readability expectations.
