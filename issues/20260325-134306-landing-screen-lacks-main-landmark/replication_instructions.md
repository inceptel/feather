# Replication Instructions

1. Open the current worker app on mobile, for example `http://localhost:3305/`, and wait for the empty landing state.
2. Confirm the landing UI shows the `Select a session` header and the body copy `Open a session or create a new one`.
3. Inspect the page landmarks or read `frontend/src/App.tsx`.
4. The bug is present when that landing state is rendered but the app shell exposes no `<main>` element and no `role="main"` landmark for the primary content area.

The included `replicate.sh` verifies the current implementation directly from `frontend/src/App.tsx` by checking for the landing-state fallback strings and then asserting that the file defines no `<main>` or `role="main"` landmark anywhere in the app shell.
