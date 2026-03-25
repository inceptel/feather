1. Create a fresh session with `POST /api/sessions` so the check does not depend on any pre-existing tmux state.
2. Try opening `ws://127.0.0.1:$PORT/new-dev/api/terminal?session=<id>`.
3. Try opening `ws://127.0.0.1:$PORT/api/terminal?session=<id>` for the same session.
4. The bug is present when the `/new-dev/api/terminal` socket never opens, but `/api/terminal` opens successfully.
5. That proves the frontend terminal client is targeting the wrong WebSocket path for a live session.
