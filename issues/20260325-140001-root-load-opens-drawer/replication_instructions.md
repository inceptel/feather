1. Inspect [App.tsx](/home/user/feather-dev/w5/frontend/src/App.tsx).
2. Confirm the drawer state starts closed with `createSignal(false)`.
3. Confirm root load only auto-selects `location.hash`, so opening `/` without a hash does not flip `sidebar` open.
4. Confirm the hamburger renders only when `!sidebar()`.
5. Confirm the drawer container uses `width: sidebar() ? '300px' : '0'` and the close button / `+ New Claude` UI only render inside `<Show when={sidebar()}>`.
6. Run `bash replicate.sh`. It exits `1` when those conditions hold, meaning the reported bug is absent in the current build.
