1. Open `http://localhost:${PORT:-3305}/#4baa1292-7fdf-4e87-af47-6731e459b3cd` in a mobile viewport (`390x844`).
2. Wait for the chat composer to appear.
3. Type any unique message into the `Send a message...` textarea.
4. Tap `Send`.
5. Immediately inspect the browser location.

Expected bug signal: Feather leaves the app and the page navigates to `chrome://new-tab-page/` with the browser title `New Tab`.

Current worker-5 result on `2026-03-25`: the app stays on `http://localhost:3305/#4baa1292-7fdf-4e87-af47-6731e459b3cd` after tapping `Send`, so this report is not reproducible on this worker's build.
