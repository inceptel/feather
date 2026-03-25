1. Fetch `http://localhost:$PORT/api/sessions?limit=50` and pick any existing session id, preferring `370e2f60-1399-4ebf-a182-7a8ba6c59ccf` (`hello old friend`) if it is present.
2. POST to `/api/sessions/<id>/resume` and poll `/api/sessions?limit=50` until that same session reports `"isActive": true`.
3. On mobile (`390x844`), open the plain root route `http://localhost:$PORT/` with no hash fragment.
4. The bug is present if the backend still reports an active session but the UI remains on the empty-state copy `Select a session` and `Open a session or create a new one`, and the URL hash stays empty instead of restoring the active session.
