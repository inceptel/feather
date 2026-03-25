1. Verify worker 4 still serves session `370e2f60-1399-4ebf-a182-7a8ba6c59ccf` from `http://localhost:3304/api/sessions/:id/messages`.
2. Inspect [App.tsx](/home/user/feather-dev/w5/frontend/src/App.tsx) and confirm `onMount()` reads `location.hash.slice(1)` and immediately calls `select(hash)`.
3. Inspect [api.ts](/home/user/feather-dev/w5/frontend/src/api.ts) and confirm all session fetches are same-origin because `BASE` is the empty string.
4. Search [App.tsx](/home/user/feather-dev/w5/frontend/src/App.tsx), [api.ts](/home/user/feather-dev/w5/frontend/src/api.ts), and [server.js](/home/user/feather-dev/w5/server.js) for any `location.href`, `location.assign`, `location.replace`, `window.location`, or hard-coded `http://localhost:330x` redirect path.
5. In the current build, the bug is absent when the target worker-4 session is still readable, hash restoration is still same-origin, and there is no code path that can switch the app to another worker origin during direct hash load.
