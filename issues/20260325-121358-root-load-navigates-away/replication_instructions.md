1. Open `http://localhost:3305/` and `http://localhost:3305/api/sessions`.
2. Confirm the root route serves the Feather SPA shell and the API stays same-origin on the same port.
3. Inspect [App.tsx](/home/user/feather-dev/w5/frontend/src/App.tsx) and verify mount-time startup only does `const hash = location.hash.slice(1)` followed by `if (hash) select(hash)`.
4. Inspect [api.ts](/home/user/feather-dev/w5/frontend/src/api.ts) and verify the frontend uses `const BASE = ''`, so startup requests stay on the current origin.
5. Inspect [server.js](/home/user/feather-dev/w5/server.js) and verify there is no `res.redirect(...)` or other startup navigation logic.

Current worker-5 result on `2026-03-25`: this bug is not reproducible on port `3305` with the current source, because the root load path has no cross-port or new-tab redirect logic.
