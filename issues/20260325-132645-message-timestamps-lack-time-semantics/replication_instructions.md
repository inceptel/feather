1. Fetch `http://localhost:$PORT/api/sessions/370e2f60-1399-4ebf-a182-7a8ba6c59ccf/messages?limit=200` and confirm the session still has multiple messages with non-empty ISO `timestamp` fields.
2. Open `http://localhost:$PORT/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf` in a `390x844` mobile viewport and wait for the transcript to load.
3. Inspect the visible chat timestamp labels such as `11:42 AM` and `11:43 AM`.
4. The bug is present when those visible labels are rendered without semantic time metadata: there are no `<time>` elements, and the timestamp nodes are plain `SPAN` elements with no `datetime`, `role`, or `aria-label`.
5. The source-backed reason is in [MessageView.tsx](/home/user/feather-dev/w5/frontend/src/components/MessageView.tsx): the transcript footer renders `{formatTime(msg.timestamp)}` inside a plain `<span>` instead of a semantic time element.
