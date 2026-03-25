1. Fetch `http://localhost:$PORT/api/sessions?limit=50`.
2. Inspect the returned `title` values and identify entries that begin with `WORKER_NUM=` for workers other than the current port's worker number. On port `3305`, any `WORKER_NUM=1`, `WORKER_NUM=2`, `WORKER_NUM=3`, or `WORKER_NUM=4` title is foreign.
3. The bug is present if those foreign worker titles are included in the session list for this worker's app, because the mobile drawer is populated from that same `/api/sessions` response.
4. The current server implementation in `server.js` confirms the leak path: `discoverSessions()` scans every directory under `~/.claude/projects`, and `GET /api/sessions` returns that unfiltered result directly.
