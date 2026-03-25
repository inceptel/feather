1. Open `http://localhost:$PORT/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf` in a mobile-sized viewport (`390x844`).
2. Leave the session on the default `Chat` tab and wait for the transcript plus composer to render.
3. Confirm the visible chat composer is present at the bottom of the screen with placeholder text `Send a message...`.
4. Capture the accessibility snapshot for the page while Chat remains selected.
5. The bug is present if the accessibility tree exposes `textbox "Terminal input"` even though the UI is in Chat view, and the composer textbox `Send a message...` is missing from the snapshot.
