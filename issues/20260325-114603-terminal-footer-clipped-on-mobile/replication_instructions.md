1. Open `http://localhost:$PORT/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf` on a `390x844` viewport.
2. Wait for the session to load, then switch to the `Terminal` tab.
3. Measure `.xterm-screen` against `window.innerHeight`.
4. The bug is present if the terminal screen extends below the viewport bottom, which clips the last terminal/footer rows on mobile. In the current build on port `3305`, the probe consistently measures the xterm screen bottom at about `847px` for an `844px` viewport.
