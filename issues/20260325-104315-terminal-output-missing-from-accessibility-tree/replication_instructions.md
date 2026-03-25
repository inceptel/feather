1. Open `http://localhost:$PORT/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf` in a mobile-sized viewport (`390x844`).
2. Wait for the session to load in chat view, then switch to the `Terminal` tab.
3. Observe that the terminal visibly renders transcript text. In the current build this consistently shows an xterm row containing `[disconnected]`.
4. Capture the accessibility snapshot for the page.
5. The bug is present if the terminal transcript is visibly rendered in `.xterm-rows`, but the accessibility snapshot still exposes only the buttons and `textbox "Terminal input"` without any terminal transcript text.
