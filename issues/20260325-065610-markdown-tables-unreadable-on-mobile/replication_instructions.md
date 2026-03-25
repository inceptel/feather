1. Fetch `http://localhost:$PORT/api/sessions?limit=500` and confirm session `4baa1292-7fdf-4e87-af47-6731e459b3cd` is still titled `worker 4 probe`.
2. Fetch `http://localhost:$PORT/api/sessions/4baa1292-7fdf-4e87-af47-6731e459b3cd/messages` and confirm the transcript still contains the markdown table headed `Port flip repro results:` with rows such as `Started on 3304` and `3304/#4baa...`.
3. Inspect [MessageView.tsx](/home/user/feather-dev/w5/frontend/src/components/MessageView.tsx): markdown text is rendered directly into `.markdown` HTML, assistant bubbles cap content at `85%` width with `overflow: hidden`, and `.markdown table` is styled with `width: 100%` but no horizontal-scroll wrapper or `overflow-x` handling.
4. Run `PORT=$PORT bash issues/20260325-065610-markdown-tables-unreadable-on-mobile/replicate.sh`.

The automated repro reports the bug when both halves still hold at the same time: the target session still contains the wide markdown table content, and the current renderer source still forces tables to fit inside the fixed-width hidden-overflow chat bubble instead of giving them a responsive horizontal-scroll path.
