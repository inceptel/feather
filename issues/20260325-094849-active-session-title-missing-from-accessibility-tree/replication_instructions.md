1. Open Feather on mobile (`390x844`) and load any session so the top header shows the active session title.
2. Confirm the title is visibly rendered in the header bar near the top-left of the page.
3. Capture the accessibility snapshot for the page body.
4. The bug is present only if that visible header title text is missing from the ARIA snapshot.
5. In the current build on port `3305`, the title is still rendered visually and Playwright's `aria_snapshot()` includes it, so this issue does not reproduce.
