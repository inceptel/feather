1. Open [`frontend/src/App.tsx`](/home/user/feather-dev/w5/frontend/src/App.tsx) and locate the mobile drawer session list.
2. Find the `<For each={sessions()}>` loop inside the sidebar.
3. Confirm whether each session row is rendered as a `<button>` with `onClick={() => select(s.id)}`.
4. Confirm the row also exposes `aria-current={s.id === currentId() ? 'page' : undefined}` for the active session.
5. Run `bash replicate.sh`.

Result interpretation:
- Exit `0`: bug present, because the session list is not implemented as focusable interactive controls.
- Exit `1`: bug absent, because the session list is implemented as focusable buttons.
