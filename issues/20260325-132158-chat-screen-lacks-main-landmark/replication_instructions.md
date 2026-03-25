# Replication Instructions

1. Open the mobile chat view in the current worker app, for example `http://localhost:3305/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf`.
2. Wait for the chat transcript and the `Chat` / `Terminal` tabs to render.
3. Inspect the page landmarks or read `frontend/src/App.tsx`.
4. The bug is present when the chat transcript is rendered through `MessageView` but the page exposes no `<main>` element and no `role="main"` anywhere in the app shell.

The included `replicate.sh` verifies that condition directly from the current source, which matches the reported runtime DOM evidence for this issue.
