1. Open Feather on mobile at `390x844` with no session selected.
2. Wait for the landing screen to finish rendering at the root URL.
3. Inspect the top header text that says `Select a session`.
4. The bug is present when that header uses the dim `#666` fallback style against the `#0a0e14` app background, yielding less than `4.5:1` contrast for normal-sized text.
