1. Open Feather on mobile at `390x844` with session `370e2f60-1399-4ebf-a182-7a8ba6c59ccf`.
2. Switch to the `Terminal` tab for that session.
3. Inspect the terminal DOM or accessibility tree.
4. The bug is present when xterm exposes both a hidden helper `textarea[aria-label="Terminal input"]` and an accessibility tree node for the same terminal input, producing two `Terminal input` textboxes for assistive technology.
