1. Fetch `http://localhost:$PORT/api/sessions?limit=50`.
2. Inspect the returned `title` values and focus on entries beginning with `WORKER_NUM=`.
3. The bug is present if that response contains repeated raw bootstrap titles such as `WORKER_NUM=2 WORKTREE=/home/user/feather-dev/w2 PORT=3302 WORKER_DIR=/home/user/`, because the mobile drawer renders those titles directly and multiple rows become visually indistinguishable.
4. The current server implementation in `server.js` confirms the source of the bug: `discoverSessions()` derives each session title from the first non-meta user message with `text.slice(0, 80)`, and `GET /api/sessions` returns that raw discovery output directly.
