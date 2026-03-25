1. Confirm `http://localhost:$PORT/api/sessions` includes session id `370e2f60-1399-4ebf-a182-7a8ba6c59ccf` with title `hello old friend`.
2. Open `http://localhost:$PORT/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf` on a mobile viewport sized `390x844`.
3. Wait about 3 seconds for the SPA to settle.
4. The bug is present if Feather does not stay on that exact hashed URL and instead shows the empty-state copy `Select a session` / `Open a session or create a new one`.
5. In this worker environment on port `3305`, the current app stays on the requested hash and opens the `hello old friend` session, so this detector currently reports the bug absent.
