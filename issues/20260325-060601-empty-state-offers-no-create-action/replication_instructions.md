1. Open `http://localhost:$PORT/` on a mobile viewport sized `390x844`.
2. Wait for the landing screen to finish rendering.
3. Observe the main pane: it shows only the text `Open a session or create a new one` with the decorative `~` glyph.
4. Check the accessible controls on the page.
5. The bug is present when the only exposed button is the hamburger menu button and there is no visible create-session control in the empty state content.
