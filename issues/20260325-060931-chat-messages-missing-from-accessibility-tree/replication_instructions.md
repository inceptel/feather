1. Open `http://localhost:3305/` on a mobile viewport (`390x844`).
2. Load the session titled `worker 4 probe`.
3. Observe that the chat transcript is visibly rendered in the main pane.
4. Capture an accessibility snapshot.
5. Compare the snapshot text with the visible transcript text.

The automated repro opens `worker 4 probe` by session id, samples visible `.markdown` transcript blocks from the DOM, and then checks whether at least one of those visible transcript snippets is missing from the `agent-browser snapshot -i` output. The bug is present when transcript content is visibly rendered but omitted from the accessibility tree.
