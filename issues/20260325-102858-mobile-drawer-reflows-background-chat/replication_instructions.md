1. Open `http://localhost:$PORT/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf` in Chromium on a `390x844` viewport.
2. Wait for the seeded session to render, then tap the hamburger button.
3. Inspect the layout after the drawer opens.
4. The bug is present when the drawer takes a fixed `300px` width, the chat pane is still visible as a thin strip on the right, and the remaining transcript/title text is crushed into a near-vertical column instead of being fully occluded.
