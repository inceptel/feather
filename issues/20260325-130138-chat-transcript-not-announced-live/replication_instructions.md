1. Create a synthetic Claude session JSONL with at least one user title message and one assistant reply, then wait for `http://localhost:$PORT/api/sessions?limit=50` to list that session.
2. Open `http://localhost:$PORT/#<synthetic-session-id>` on a `390x844` viewport and wait for the chat transcript to render the seeded assistant text.
3. Starting from that visible assistant text node, walk up the DOM to the nearest `div` whose computed `overflow-y` is `auto` or `scroll`; this is the chat transcript scroller in the current build.
4. Inspect that scroller element’s accessibility attributes.
5. The bug is present if the transcript visibly renders the chat content but that scroller still exposes no `role`, no `aria-live`, and no `aria-label`, so assistive technology has no live-region semantics to announce new chat updates.
