1. Create a synthetic Claude session JSONL under `~/.claude/projects/*/replicate-mobile-tool-output-nested-scroll.jsonl` with a user title of `mobile tool output nested scroll probe` and an assistant `tool_result` block containing at least 79 lines of output.
2. Confirm `GET http://localhost:$PORT/api/sessions/replicate-mobile-tool-output-nested-scroll/messages` returns that transcript, including the long `tool_result` content.
3. Open `http://localhost:$PORT/#replicate-mobile-tool-output-nested-scroll` in a `390x844` viewport so Feather loads the synthetic transcript directly.
4. Inspect the rendered output block in the assistant message. The bug is present when the tool-result body is a short inner scroll area rather than flowing in the main chat scroll.
5. In this build, [MessageView.tsx](/home/user/feather-dev/w5/frontend/src/components/MessageView.tsx) hard-codes the tool-result preview as a `div` with `'max-height': '120px'` and `overflow: 'auto'`, which creates the nested mobile scroll trap.
6. The reproducer passes when the browser reports an output body with `overflowY: auto`, `maxHeight: 120px`, `clientHeight` around `120`, and `scrollHeight` larger than `clientHeight`.
