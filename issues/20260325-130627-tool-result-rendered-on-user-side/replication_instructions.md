1. Fetch `http://localhost:$PORT/api/sessions/370e2f60-1399-4ebf-a182-7a8ba6c59ccf/messages?limit=500` and locate the user-authored probe text `w5 repro probe 1774438929`.
2. In that same exchange, confirm one of the next few stored messages is also `role: user` and contains a `tool_result` whose text includes `(Bash completed with no output)`.
3. Inspect [MessageView.tsx](/home/user/feather-dev/w5/frontend/src/components/MessageView.tsx): the outer message wrapper sets `'align-items'` and bubble background purely from `msg.role === 'user'`, and the `tool_result` block renderer does not override that wrapper.
4. Open `http://localhost:$PORT/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf` in a `390x844` viewport and scroll to the exchange after `w5 repro probe 1774438929`.
5. The bug is present when the `(Bash completed with no output)` `OUTPUT` card appears in the right-hand green user column instead of on the assistant/tool side.
