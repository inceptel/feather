1. Open `http://localhost:$PORT/#7a004500-bb31-4cef-bf78-50ec21b8cefc` in a mobile-sized viewport (`390x844`).
2. Wait for the chat composer to render with an empty textarea showing the `Send a message...` placeholder.
3. Inspect the textarea and its `::placeholder` pseudo-element styles in Chromium.
4. Compare the placeholder color against the textarea background color.
5. The bug is present when the placeholder renders as `rgb(117, 117, 117)` at `15px` on `rgb(26, 26, 46)`, producing contrast below `4.5:1`.
