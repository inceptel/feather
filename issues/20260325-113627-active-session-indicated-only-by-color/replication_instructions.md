1. Fetch `http://localhost:$PORT/api/sessions?limit=500` and confirm session `370e2f60-1399-4ebf-a182-7a8ba6c59ccf` still exists as `hello old friend` with `isActive: true`.
2. Inspect [App.tsx](/home/user/feather-dev/w5/frontend/src/App.tsx#L201) for the active drawer row styling and accessibility state.
3. The bug is present only if the active row keeps the green dot but lacks both `aria-current` and any non-color selected treatment such as a border.
4. In the current worker 5 build on port `3305`, the active session button sets `aria-current="page"` and draws a `3px` left border, so the reported color-only cue is no longer reproducible.
