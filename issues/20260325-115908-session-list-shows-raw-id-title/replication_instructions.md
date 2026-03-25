1. Seed `/home/user/.claude/projects/-home-user/1cb410df-0000-4000-8000-000000000000.jsonl` with a valid transcript that contains no non-meta user prompt, for example a single assistant-only JSON line.
2. Fetch `http://localhost:$PORT/api/sessions?limit=20` and locate session `1cb410df-0000-4000-8000-000000000000`.
3. Observe that the API reports the title as `1cb410df`, which is just the first 8 characters of the session id.
4. Open Feather on a mobile viewport, open the Sessions drawer, and confirm that same raw `1cb410df` string is rendered as the session row label instead of a human-readable fallback.
5. The source-backed reason is in [server.js](/home/user/feather-dev/w5/server.js): `discoverSessions()` sets `title: title || id.slice(0, 8)`, and [App.tsx](/home/user/feather-dev/w5/frontend/src/App.tsx) renders `s.title` directly in the drawer row.
