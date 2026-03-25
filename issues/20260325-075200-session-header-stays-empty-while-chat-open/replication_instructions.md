1. Ensure Feather is running, then identify a session id that still has messages on disk but does not appear in `GET /api/sessions`. The current reliable example is `549bddbd-df9b-46a6-9cc4-13712ad51ad6`.
2. Open `http://localhost:3305/#549bddbd-df9b-46a6-9cc4-13712ad51ad6` on a mobile-sized viewport such as `390x844`.
3. Wait for the transcript and composer to render.
4. The bug is present if the main pane shows a real chat session, including the `Chat` and `Terminal` tabs plus the `Send a message...` composer, while the header still reads `Select a session`.
5. The source-backed reason is in [App.tsx](/home/user/feather-dev/w5/frontend/src/App.tsx): `onMount()` restores `currentId` directly from `location.hash` and `select(id)` loads `/api/sessions/:id/messages`, but the header label comes from `cur()`, which only resolves ids returned by `fetchSessions()`.
