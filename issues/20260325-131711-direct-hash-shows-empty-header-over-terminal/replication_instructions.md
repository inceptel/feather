1. Open `http://localhost:3305/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf` on a mobile-sized viewport (`390x844`).
2. Wait for Feather to finish loading. The hash points at a session id that is not in worker 5's `/api/sessions` list.
3. Observe that the header still says `Select a session`, which is the empty-state fallback.
4. Observe that the session UI still renders `Chat` and `Terminal` tabs because `currentId()` was set from the hash even though no matching session metadata exists.
5. Switch to `Terminal`. Feather opens the terminal pane for the hash session id, so terminal content or a disconnected terminal footer appears under the empty-state header.
6. The bug is present when the page simultaneously shows the `Select a session` header and session-specific terminal UI/content.
