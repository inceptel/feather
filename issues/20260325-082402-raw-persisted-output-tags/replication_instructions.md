1. Open `http://localhost:$PORT/#cee9ca45-5a00-420d-a67c-45f205156335` on mobile width.
2. That session includes a stored `tool_result` block whose content starts with `<persisted-output>`.
3. `GET /api/sessions/cee9ca45-5a00-420d-a67c-45f205156335/messages` returns the literal tag.
4. [`MessageView.tsx`](/home/user/feather-dev/w5/frontend/src/components/MessageView.tsx) renders `tool_result` previews from raw string content via `raw.slice(0, 200)` without stripping those tags.
5. Because the stored content already contains `<persisted-output>`, the chat bubble leaks the literal tag text instead of hiding internal markup.
