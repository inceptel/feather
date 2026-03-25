1. Fetch `http://localhost:$PORT/api/sessions/4baa1292-7fdf-4e87-af47-6731e459b3cd/messages?limit=500` and confirm the transcript still contains the assistant text `You've hit your limit · resets 5pm (UTC)`.
2. Open [App.tsx](/home/user/feather-dev/w5/frontend/src/App.tsx) and inspect `handleSend`, the composer `<textarea>`, and the `Send` button near the bottom of the file.
3. Verify `handleSend` only guards on empty input and `currentId()`, the `<textarea>` has no `disabled` prop, and the `Send` button is only rendered as `disabled={uploading()}`.
4. This reproduces the bug: Feather can show the rate-limit warning in the active transcript while leaving the composer editable and the send path available.
