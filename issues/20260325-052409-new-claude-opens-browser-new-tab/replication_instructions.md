1. Open `http://localhost:$PORT/` in Chromium on a `390x844` mobile viewport.
2. Tap the hamburger button to open the Feather drawer.
3. Tap `+ New Claude`.
4. Wait about 5 seconds for the client to navigate.
5. Observe that Feather does not create a matching new session in `/api/sessions`. On this worker, the browser either jumps away from `http://localhost:$PORT/` entirely or lands on `http://localhost:$PORT/#<uuid>` where that `<uuid>` is missing from the session list.
